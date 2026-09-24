#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const DEFAULTS = Object.freeze({
  intervalMs: 15000,
  failureThreshold: 4,
  probeTimeoutMs: 5000,
  healthyResetMs: 300000,
  restartBaseMs: 5000,
  restartMaxMs: 120000,
  maxRapidRestarts: 6,
  logMaxBytes: 5 * 1024 * 1024,
  restartOnPublicFailure: false,
});

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function onOff(value, fallback = true) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['on', 'true', '1', 'yes'].includes(normalized)) return true;
  if (['off', 'false', '0', 'no'].includes(normalized)) return false;
  throw new Error(`Expected on/off value, got: ${value}`);
}

export function parseArgs(argv) {
  const separator = argv.indexOf('--');
  const own = separator >= 0 ? argv.slice(0, separator) : argv;
  const child = separator >= 0 ? argv.slice(separator + 1) : [];
  const out = {
    name: 'codexpro',
    localHealth: '',
    publicHealth: '',
    externalPublicHealth: '',
    externalDnsUrl: 'https://dns.google/resolve',
    ngrokApi: 'http://127.0.0.1:4040/api/tunnels',
    logDir: '',
    tunnelLog: '',
    lockFile: '',
    cwd: '',
    intervalMs: DEFAULTS.intervalMs,
    failureThreshold: DEFAULTS.failureThreshold,
    probeTimeoutMs: DEFAULTS.probeTimeoutMs,
    healthyResetMs: DEFAULTS.healthyResetMs,
    restartBaseMs: DEFAULTS.restartBaseMs,
    restartMaxMs: DEFAULTS.restartMaxMs,
    maxRapidRestarts: DEFAULTS.maxRapidRestarts,
    restartOnPublicFailure: DEFAULTS.restartOnPublicFailure,
    selfTest: false,
    child,
  };

  for (let i = 0; i < own.length; i += 1) {
    const arg = own[i];
    if (arg === '--self-test') {
      out.selfTest = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    const key = arg.slice(2);
    const value = own[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    i += 1;
    if (key === 'name') out.name = value;
    else if (key === 'local-health') out.localHealth = value;
    else if (key === 'public-health') out.publicHealth = value;
    else if (key === 'external-public-health') out.externalPublicHealth = value;
    else if (key === 'external-dns-url') out.externalDnsUrl = value;
    else if (key === 'ngrok-api') out.ngrokApi = value;
    else if (key === 'log-dir') out.logDir = value;
    else if (key === 'tunnel-log') out.tunnelLog = value;
    else if (key === 'lock-file') out.lockFile = value;
    else if (key === 'cwd') out.cwd = value;
    else if (key === 'interval-ms') out.intervalMs = positiveInt(value, DEFAULTS.intervalMs, 1000, 3600000);
    else if (key === 'failure-threshold') out.failureThreshold = positiveInt(value, DEFAULTS.failureThreshold, 2, 20);
    else if (key === 'probe-timeout-ms') out.probeTimeoutMs = positiveInt(value, DEFAULTS.probeTimeoutMs, 500, 60000);
    else if (key === 'healthy-reset-ms') out.healthyResetMs = positiveInt(value, DEFAULTS.healthyResetMs, 10000, 86400000);
    else if (key === 'restart-base-ms') out.restartBaseMs = positiveInt(value, DEFAULTS.restartBaseMs, 1000, 600000);
    else if (key === 'restart-max-ms') out.restartMaxMs = positiveInt(value, DEFAULTS.restartMaxMs, 1000, 3600000);
    else if (key === 'max-rapid-restarts') out.maxRapidRestarts = positiveInt(value, DEFAULTS.maxRapidRestarts, 1, 50);
    else if (key === 'restart-on-public-failure') out.restartOnPublicFailure = onOff(value, DEFAULTS.restartOnPublicFailure);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!out.selfTest) {
    if (!out.localHealth) throw new Error('--local-health is required');
    if (!out.publicHealth) throw new Error('--public-health is required');
    if (!out.logDir) throw new Error('--log-dir is required');
    if (out.child.length === 0) throw new Error('Child command is required after --');
  }
  return out;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function rotateFile(filePath, maxBytes = DEFAULTS.logMaxBytes, backups = 3) {
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size < maxBytes) return;
    for (let index = backups; index >= 1; index -= 1) {
      const current = index === 1 ? filePath : `${filePath}.${index - 1}`;
      const next = `${filePath}.${index}`;
      if (!fs.existsSync(current)) continue;
      if (fs.existsSync(next)) fs.rmSync(next, { force: true });
      fs.renameSync(current, next);
    }
  } catch {}
}

function appendLine(filePath, line) {
  try {
    rotateFile(filePath);
    fs.appendFileSync(filePath, `${line}\n`, 'utf8');
  } catch {}
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(lockFile) {
  ensureDir(path.dirname(lockFile));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeFileSync(fd, `${process.pid}\n`, 'utf8');
      return () => {
        try { fs.closeSync(fd); } catch {}
        try { fs.rmSync(lockFile, { force: true }); } catch {}
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      let existingPid = 0;
      try { existingPid = Number(fs.readFileSync(lockFile, 'utf8').trim()); } catch {}
      if (pidIsAlive(existingPid)) throw new Error(`Supervisor already running with pid=${existingPid}`);
      try { fs.rmSync(lockFile, { force: true }); } catch {}
    }
  }
  throw new Error('Could not acquire supervisor lock');
}

export async function probe(url, timeoutMs = DEFAULTS.probeTimeoutMs) {
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    try { await response.body?.cancel(); } catch {}
    return {
      ok: true,
      status: response.status,
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      error: '',
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isPublicIpv4(value) {
  const parts = String(value ?? '').trim().split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && parts[2] === 100))) return false;
  if (a === 203 && b === 0 && parts[2] === 113) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

export function extractPublicIpv4Answers(body) {
  const answers = Array.isArray(body?.Answer) ? body.Answer : [];
  return answers
    .filter((answer) => Number(answer?.type) === 1 && isPublicIpv4(answer?.data))
    .map((answer) => String(answer.data));
}

async function resolveExternalIpv4(hostname, timeoutMs, dnsUrl) {
  const started = performance.now();
  const endpoint = new URL(dnsUrl);
  endpoint.searchParams.set('name', hostname);
  endpoint.searchParams.set('type', 'A');
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: { accept: 'application/dns-json' },
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json();
  const addresses = extractPublicIpv4Answers(body);
  if (!response.ok || addresses.length === 0) {
    throw new Error(`External DNS resolution failed (status=${response.status}, publicA=${addresses.length})`);
  }
  return {
    ip: addresses[0],
    dnsStatus: response.status,
    dnsLatencyMs: Math.round((performance.now() - started) * 100) / 100,
  };
}

export async function probeExternalHttps(url, timeoutMs = DEFAULTS.probeTimeoutMs, dnsUrl = 'https://dns.google/resolve') {
  const started = performance.now();
  try {
    const target = new URL(url);
    if (target.protocol !== 'https:') throw new Error('External public probe requires https URL');
    const resolved = await resolveExternalIpv4(target.hostname, timeoutMs, dnsUrl);
    const status = await new Promise((resolve, reject) => {
      const request = httpsRequest({
        protocol: 'https:',
        hostname: resolved.ip,
        port: Number(target.port || 443),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        servername: target.hostname,
        rejectUnauthorized: true,
        headers: {
          Host: target.host,
          'Cache-Control': 'no-cache',
          Connection: 'close',
        },
        timeout: timeoutMs,
      }, (response) => {
        const responseStatus = response.statusCode || 0;
        response.resume();
        resolve(responseStatus);
      });
      request.once('timeout', () => request.destroy(new Error(`External HTTPS probe timeout after ${timeoutMs} ms`)));
      request.once('error', reject);
      request.end();
    });
    return {
      ok: true,
      status,
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      dnsLatencyMs: resolved.dnsLatencyMs,
      publicIp: resolved.ip,
      error: '',
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      dnsLatencyMs: null,
      publicIp: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeNgrokApi(url, timeoutMs) {
  const started = performance.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    const body = await response.json();
    return {
      ok: true,
      status: response.status,
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      tunnelCount: Array.isArray(body?.tunnels) ? body.tunnels.length : null,
      error: '',
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      tunnelCount: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export class HealthState {
  constructor(failureThreshold = DEFAULTS.failureThreshold) {
    this.failureThreshold = failureThreshold;
    this.localFailures = 0;
    this.publicFailures = 0;
    this.lastState = 'STARTING';
  }

  observe(localResult, publicResult) {
    this.localFailures = localResult.ok ? 0 : this.localFailures + 1;
    this.publicFailures = publicResult.ok ? 0 : this.publicFailures + 1;

    let state = 'HEALTHY';
    let restartReason = '';
    if (!localResult.ok) state = 'LOCAL_DEGRADED';
    else if (!publicResult.ok) state = 'PUBLIC_DEGRADED';

    if (this.localFailures >= this.failureThreshold) {
      state = 'LOCAL_RUNTIME_OUTAGE';
      restartReason = state;
    } else if (localResult.ok && this.publicFailures >= this.failureThreshold) {
      state = 'PUBLIC_TUNNEL_OUTAGE';
      restartReason = state;
    }

    const changed = state !== this.lastState;
    this.lastState = state;
    return {
      state,
      changed,
      restartReason,
      localFailures: this.localFailures,
      publicFailures: this.publicFailures,
    };
  }
}

export function restartBackoffMs(restartCount, baseMs = DEFAULTS.restartBaseMs, maxMs = DEFAULTS.restartMaxMs) {
  return Math.min(maxMs, baseMs * (2 ** Math.max(0, restartCount - 1)));
}

export function isSupervisorStopKey(input) {
  const text = String(input ?? '');
  return text === '\u0003' || text.trim().toLowerCase() === 'q';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    try { child.kill('SIGTERM'); } catch {}
  }
}

function createLogger(logDir) {
  ensureDir(logDir);
  const supervisorLog = path.join(logDir, 'supervisor.log');
  const healthLog = path.join(logDir, 'health.jsonl');
  const colorEnabled = Boolean(process.stdout.isTTY) && process.env.NO_COLOR !== '1';
  const paint = (code, text) => colorEnabled ? `\u001b[${code}m${text}\u001b[0m` : text;
  const consoleLine = (kind, message) => {
    if (kind === 'health_recovered') return paint('1;32', `[READY] ${message}`);
    if (kind === 'health_state') return paint('1;33', `[DEGRADED] ${message}`);
    if (kind === 'restart_requested' || kind === 'child_error') return paint('1;31', `[OUTAGE] ${message}`);
    if (kind === 'child_exit' || kind === 'restart_backoff') return paint('33', `[RECOVERY] ${message}`);
    if (kind === 'start' || kind === 'child_start') return paint('36', `[Supervisor] ${message}`);
    return `[Supervisor] ${message}`;
  };
  return {
    event(kind, message, extra = {}) {
      appendLine(supervisorLog, JSON.stringify({ ts: new Date().toISOString(), kind, message, ...extra }));
      console.log(consoleLine(kind, message));
    },
    ready(localResult, publicResult, childPid) {
      const lines = [
        '✓ CODEXPRO READY',
        `  Local MCP   HEALTHY  (${localResult.status}, ${localResult.latencyMs} ms)`,
        `  Public MCP  HEALTHY  (${publicResult.status}, ${publicResult.latencyMs} ms)`,
        `  Supervisor  ACTIVE   (runtime pid=${childPid})`,
      ];
      console.log(paint('1;32', lines.join('\n')));
    },
    health(record) {
      appendLine(healthLog, JSON.stringify(record));
    },
  };
}

async function monitorChild(child, options, logger, healthState, startedAt, restartCounter) {
  let externalPublicWasOk = null;
  let externalPublicFailures = 0;
  while (child.exitCode === null && child.signalCode === null) {
    await sleep(options.intervalMs);
    if (child.exitCode !== null || child.signalCode !== null) return { type: 'child_exit' };

    const [localResult, publicResult, externalPublicResult] = await Promise.all([
      probe(options.localHealth, options.probeTimeoutMs),
      probe(options.publicHealth, options.probeTimeoutMs),
      options.externalPublicHealth
        ? probeExternalHttps(options.externalPublicHealth, options.probeTimeoutMs, options.externalDnsUrl)
        : Promise.resolve(null),
    ]);
    const observation = healthState.observe(localResult, publicResult);
    if (externalPublicResult) {
      externalPublicFailures = externalPublicResult.ok ? 0 : externalPublicFailures + 1;
      if (externalPublicWasOk !== externalPublicResult.ok) {
        logger.event(
          externalPublicResult.ok ? 'external_public_recovered' : 'external_public_degraded',
          externalPublicResult.ok
            ? 'True external Funnel probe recovered.'
            : `True external Funnel probe failed: ${externalPublicResult.error || 'unknown error'}`,
          { externalPublic: externalPublicResult, externalPublicFailures },
        );
      }
      externalPublicWasOk = externalPublicResult.ok;
    }
    let ngrok = null;
    if ((!localResult.ok || !publicResult.ok || observation.changed) && options.ngrokApi !== 'off') {
      ngrok = await probeNgrokApi(options.ngrokApi, options.probeTimeoutMs);
    }

    if (localResult.ok && publicResult.ok && Date.now() - startedAt >= options.healthyResetMs && restartCounter.value !== 0) {
      restartCounter.value = 0;
      logger.event('restart_budget_reset', 'Healthy runtime reset restart backoff.');
    }

    logger.health({
      ts: new Date().toISOString(),
      pid: child.pid,
      state: observation.state,
      local: localResult,
      public: publicResult,
      externalPublic: externalPublicResult,
      ngrok,
      localFailures: observation.localFailures,
      publicFailures: observation.publicFailures,
      externalPublicFailures,
      restartCount: restartCounter.value,
    });

    if (observation.changed && observation.state !== 'HEALTHY') {
      logger.event('health_state', `${observation.state}: local_fail=${observation.localFailures} public_fail=${observation.publicFailures}`);
    } else if (observation.changed) {
      logger.event('health_recovered', 'Transport health recovered without restart.');
      logger.ready(localResult, publicResult, child.pid);
    }

    if (observation.restartReason === 'PUBLIC_TUNNEL_OUTAGE' && options.restartOnPublicFailure !== true) {
      if (observation.changed) {
        logger.event('public_restart_suppressed', 'PUBLIC_TUNNEL_OUTAGE: full runtime restart disabled by policy.');
      }
    } else if (observation.restartReason) {
      return { type: 'restart', reason: observation.restartReason, localResult, publicResult, ngrok };
    }
  }
  return { type: 'child_exit' };
}

export async function runSupervisor(options) {
  const lockFile = options.lockFile || path.join(options.logDir, `${options.name}.lock`);
  const releaseLock = acquireLock(lockFile);
  const logger = createLogger(options.logDir);
  const [command, ...childArgs] = options.child;
  const restartCounter = { value: 0 };
  let currentChild = null;
  let stopping = false;
  let cleanupConsole = () => {};

  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    logger.event('shutdown', `Stopping supervisor (${signal}).`);
    terminateProcessTree(currentChild);
  };
  const onSigint = () => stop('SIGINT');
  const onSigterm = () => stop('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  if (process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    if (typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(true);
    process.stdin.resume();
    const onInput = (input) => {
      if (!isSupervisorStopKey(input)) return;
      const label = String(input) === '\u0003' ? 'CTRL_C' : 'Q';
      console.log('');
      stop(label);
    };
    process.stdin.on('data', onInput);
    console.log('Controls: q quit | Ctrl+C quit');
    cleanupConsole = () => {
      process.stdin.off('data', onInput);
      if (typeof process.stdin.setRawMode === 'function') {
        try { process.stdin.setRawMode(false); } catch {}
      }
      try { process.stdin.pause(); } catch {}
    };
  }

  try {
    logger.event('start', `Supervisor started for ${options.name}.`, {
      localHealth: options.localHealth,
      publicHealth: options.publicHealth,
      externalPublicHealth: options.externalPublicHealth || '',
      externalDnsUrl: options.externalPublicHealth ? options.externalDnsUrl : '',
      intervalMs: options.intervalMs,
      failureThreshold: options.failureThreshold,
    });

    while (!stopping) {
      const startedAt = Date.now();
      const healthState = new HealthState(options.failureThreshold);
      if (options.tunnelLog) rotateFile(options.tunnelLog, 10 * 1024 * 1024, 3);
      logger.event('child_start', `Starting CodexPro runtime (restart=${restartCounter.value}).`);
      currentChild = spawn(command, childArgs, {
        cwd: options.cwd || process.cwd(),
        env: process.env,
        stdio: 'ignore',
        windowsHide: false,
      });

      const childExit = once(currentChild, 'exit').then(([code, signal]) => ({ type: 'exit', code, signal }));
      const childError = once(currentChild, 'error').then(([error]) => ({ type: 'spawn_error', error }));
      const monitor = monitorChild(currentChild, options, logger, healthState, startedAt, restartCounter);
      let outcome = await Promise.race([childExit, childError, monitor]);
      if (outcome.type === 'spawn_error') {
        logger.event('child_error', `CodexPro runtime process error: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`);
        terminateProcessTree(currentChild);
        outcome = { type: 'exit', code: currentChild.exitCode, signal: currentChild.signalCode, restartReason: 'CHILD_PROCESS_ERROR' };
      }

      if (outcome.type === 'restart') {
        logger.event('restart_requested', `${outcome.reason}: sustained failure threshold reached.`, {
          local: outcome.localResult,
          public: outcome.publicResult,
          ngrok: outcome.ngrok,
        });
        terminateProcessTree(currentChild);
        await Promise.race([once(currentChild, 'exit').catch(() => []), sleep(5000)]);
        outcome = {
          type: 'exit',
          code: currentChild.exitCode,
          signal: currentChild.signalCode,
          restartReason: outcome.reason,
        };
      }

      if (stopping) break;

      const uptimeMs = Date.now() - startedAt;
      if (uptimeMs >= options.healthyResetMs) restartCounter.value = 0;
      restartCounter.value += 1;
      logger.event('child_exit', 'CodexPro runtime exited; scheduling recovery.', {
        code: outcome.code ?? currentChild.exitCode,
        signal: outcome.signal ?? currentChild.signalCode,
        restartReason: outcome.restartReason || '',
        uptimeMs,
        restartCount: restartCounter.value,
      });

      if (restartCounter.value > options.maxRapidRestarts) {
        throw new Error(`Restart budget exhausted after ${restartCounter.value - 1} rapid restarts.`);
      }

      const delay = restartBackoffMs(restartCounter.value, options.restartBaseMs, options.restartMaxMs);
      logger.event('restart_backoff', `Restarting in ${delay} ms.`, { delay, restartCount: restartCounter.value });
      await sleep(delay);
    }
  } finally {
    terminateProcessTree(currentChild);
    cleanupConsole();
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    releaseLock();
  }
}

async function runSelfTest() {
  const checks = [];
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
    checks.push(message);
  };

  assert(restartBackoffMs(1, 100, 1000) === 100, 'backoff step 1');
  assert(restartBackoffMs(4, 100, 500) === 500, 'backoff cap');
  assert(isSupervisorStopKey('q'), 'q stop key');
  assert(isSupervisorStopKey('Q'), 'Q stop key');
  assert(isSupervisorStopKey('\u0003'), 'Ctrl+C stop key');
  assert(!isSupervisorStopKey('x'), 'non-stop key ignored');
  const parsedObserveOnly = parseArgs([
    '--local-health', 'http://127.0.0.1:1/healthz',
    '--public-health', 'https://example.invalid/healthz',
    '--external-public-health', 'https://example.invalid/healthz',
    '--external-dns-url', 'https://dns.google/resolve',
    '--log-dir', os.tmpdir(),
    '--restart-on-public-failure', 'off',
    '--ngrok-api', 'off',
    '--', process.execPath, '-e', 'setInterval(() => {}, 1000)'
  ]);
  assert(parsedObserveOnly.restartOnPublicFailure === false, 'public restart suppression parsed');
  const parsedDefaultPolicy = parseArgs([
    '--local-health', 'http://127.0.0.1:1/healthz',
    '--public-health', 'https://example.invalid/healthz',
    '--log-dir', os.tmpdir(),
    '--', process.execPath, '-e', 'setInterval(() => {}, 1000)'
  ]);
  assert(parsedDefaultPolicy.restartOnPublicFailure === false, 'public restart disabled by default');
  assert(parsedObserveOnly.ngrokApi === 'off', 'tunnel diagnostic probe can be disabled');
  assert(parsedObserveOnly.externalPublicHealth === 'https://example.invalid/healthz', 'external public probe parsed');
  assert(parsedObserveOnly.externalDnsUrl === 'https://dns.google/resolve', 'external DNS resolver parsed');
  const extractedPublic = extractPublicIpv4Answers({
    Answer: [
      { type: 1, data: '100.64.0.1' },
      { type: 1, data: '127.0.0.1' },
      { type: 1, data: '8.8.8.8' },
      { type: 28, data: '2001:db8::1' },
    ],
  });
  assert(extractedPublic.length === 1 && extractedPublic[0] === '8.8.8.8', 'external DNS keeps public IPv4 only');

  const publicState = new HealthState(4);
  for (let index = 1; index <= 3; index += 1) {
    assert(publicState.observe({ ok: true }, { ok: false }).restartReason === '', `public transient ${index}`);
  }
  assert(publicState.observe({ ok: true }, { ok: false }).restartReason === 'PUBLIC_TUNNEL_OUTAGE', 'public sustained outage');
  const recovered = publicState.observe({ ok: true }, { ok: true });
  assert(recovered.state === 'HEALTHY' && recovered.publicFailures === 0, 'public recovery reset');

  const localState = new HealthState(3);
  localState.observe({ ok: false }, { ok: false });
  localState.observe({ ok: false }, { ok: false });
  assert(localState.observe({ ok: false }, { ok: false }).restartReason === 'LOCAL_RUNTIME_OUTAGE', 'local sustained outage precedence');

  const server = createServer((_, response) => {
    response.statusCode = 401;
    response.end('unauthorized');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const probeResult = await probe(`http://127.0.0.1:${address.port}/healthz`, 2000);
  server.close();
  assert(probeResult.ok && probeResult.status === 401, '401 health is reachable');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpro-supervisor-selftest-'));
  const lockPath = path.join(tempDir, 'test.lock');
  const release = acquireLock(lockPath);
  assert(fs.existsSync(lockPath), 'lock acquired');
  release();
  assert(!fs.existsSync(lockPath), 'lock released');
  fs.rmSync(tempDir, { recursive: true, force: true });

  const localServer = createServer((_, response) => {
    response.statusCode = 401;
    response.end('reachable');
  });
  localServer.listen(0, '127.0.0.1');
  await once(localServer, 'listening');
  const localAddress = localServer.address();

  const reservedServer = createServer();
  reservedServer.listen(0, '127.0.0.1');
  await once(reservedServer, 'listening');
  const reservedAddress = reservedServer.address();
  const unavailablePort = reservedAddress.port;
  await new Promise((resolve) => reservedServer.close(resolve));

  const observeChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const observeEvents = [];
  const observeTimer = setTimeout(() => terminateProcessTree(observeChild), 350);
  const observeOutcome = await monitorChild(
    observeChild,
    {
      localHealth: `http://127.0.0.1:${localAddress.port}/healthz`,
      publicHealth: `http://127.0.0.1:${unavailablePort}/healthz`,
      ngrokApi: 'off',
      intervalMs: 50,
      probeTimeoutMs: 100,
      healthyResetMs: 5000,
    },
    {
      health() {},
      event(kind) { observeEvents.push(kind); },
      ready() {},
    },
    new HealthState(2),
    Date.now(),
    { value: 0 },
  );
  clearTimeout(observeTimer);
  assert(observeOutcome.type === 'child_exit', 'public observe-only does not restart local runtime');
  assert(observeEvents.includes('public_restart_suppressed'), 'public restart suppression event');

  const supervisorTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpro-supervisor-restart-'));
  let restartBudgetHit = false;
  try {
    await runSupervisor({
      name: 'selftest',
      localHealth: `http://127.0.0.1:${unavailablePort}/healthz`,
      publicHealth: `http://127.0.0.1:${unavailablePort}/healthz`,
      ngrokApi: `http://127.0.0.1:${unavailablePort}/api/tunnels`,
      logDir: supervisorTemp,
      tunnelLog: '',
      lockFile: path.join(supervisorTemp, 'selftest.lock'),
      cwd: supervisorTemp,
      intervalMs: 100,
      failureThreshold: 2,
      probeTimeoutMs: 100,
      healthyResetMs: 5000,
      restartBaseMs: 50,
      restartMaxMs: 50,
      maxRapidRestarts: 1,
      child: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    });
  } catch (error) {
    restartBudgetHit = error instanceof Error && error.message.includes('Restart budget exhausted');
  }
  await new Promise((resolve) => localServer.close(resolve));
  fs.rmSync(supervisorTemp, { recursive: true, force: true });
  assert(restartBudgetHit, 'local sustained outage restart and budget');

  console.log(`✓ transport supervisor self-test passed (${checks.length} checks)`);
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  const options = parseArgs(process.argv.slice(2));
  const task = options.selfTest ? runSelfTest() : runSupervisor(options);
  task.catch((error) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
