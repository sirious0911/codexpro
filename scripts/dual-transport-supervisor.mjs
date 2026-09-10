#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import https from 'node:https';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

const DEFAULTS = Object.freeze({
  intervalMs: 15000,
  failureThreshold: 4,
  probeTimeoutMs: 5000,
  ngrokControlIntervalMs: 30000,
  ngrokPublicIntervalMs: 300000,
  restartBaseMs: 5000,
  restartMaxMs: 120000,
  maxRapidRestarts: 6,
  logMaxBytes: 5 * 1024 * 1024,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function parseArgs(argv) {
  const separator = argv.indexOf('--');
  const own = separator >= 0 ? argv.slice(0, separator) : argv;
  const child = separator >= 0 ? argv.slice(separator + 1) : [];
  const out = {
    name: 'codexpro-dual',
    localHealth: '',
    tailscaleBin: '',
    tailscaleHost: '',
    tailscaleTarget: 'http://127.0.0.1:8787',
    ngrokBin: 'ngrok',
    ngrokHost: '',
    ngrokConfig: '',
    ngrokApi: 'http://127.0.0.1:4040/api/tunnels',
    tokenFile: '',
    logDir: '',
    ngrokLog: '',
    cwd: '',
    intervalMs: DEFAULTS.intervalMs,
    failureThreshold: DEFAULTS.failureThreshold,
    probeTimeoutMs: DEFAULTS.probeTimeoutMs,
    ngrokControlIntervalMs: DEFAULTS.ngrokControlIntervalMs,
    ngrokPublicIntervalMs: DEFAULTS.ngrokPublicIntervalMs,
    restartBaseMs: DEFAULTS.restartBaseMs,
    restartMaxMs: DEFAULTS.restartMaxMs,
    maxRapidRestarts: DEFAULTS.maxRapidRestarts,
    handoverPid: 0,
    handoverDelayMs: 5000,
    rollbackLauncher: '',
    restartLauncher: '',
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
    else if (key === 'tailscale-bin') out.tailscaleBin = value;
    else if (key === 'tailscale-host') out.tailscaleHost = value;
    else if (key === 'tailscale-target') out.tailscaleTarget = value;
    else if (key === 'ngrok-bin') out.ngrokBin = value;
    else if (key === 'ngrok-host') out.ngrokHost = value;
    else if (key === 'ngrok-config') out.ngrokConfig = value;
    else if (key === 'ngrok-api') out.ngrokApi = value;
    else if (key === 'token-file') out.tokenFile = value;
    else if (key === 'log-dir') out.logDir = value;
    else if (key === 'ngrok-log') out.ngrokLog = value;
    else if (key === 'cwd') out.cwd = value;
    else if (key === 'interval-ms') out.intervalMs = positiveInt(value, DEFAULTS.intervalMs, 1000, 3600000);
    else if (key === 'failure-threshold') out.failureThreshold = positiveInt(value, DEFAULTS.failureThreshold, 2, 20);
    else if (key === 'probe-timeout-ms') out.probeTimeoutMs = positiveInt(value, DEFAULTS.probeTimeoutMs, 500, 60000);
    else if (key === 'ngrok-control-interval-ms') out.ngrokControlIntervalMs = positiveInt(value, DEFAULTS.ngrokControlIntervalMs, 5000, 3600000);
    else if (key === 'ngrok-public-interval-ms') out.ngrokPublicIntervalMs = positiveInt(value, DEFAULTS.ngrokPublicIntervalMs, 30000, 86400000);
    else if (key === 'restart-base-ms') out.restartBaseMs = positiveInt(value, DEFAULTS.restartBaseMs, 1000, 600000);
    else if (key === 'restart-max-ms') out.restartMaxMs = positiveInt(value, DEFAULTS.restartMaxMs, 1000, 3600000);
    else if (key === 'max-rapid-restarts') out.maxRapidRestarts = positiveInt(value, DEFAULTS.maxRapidRestarts, 1, 50);
    else if (key === 'handover-pid') out.handoverPid = positiveInt(value, 0, 0, 2147483647);
    else if (key === 'handover-delay-ms') out.handoverDelayMs = positiveInt(value, 5000, 1000, 60000);
    else if (key === 'rollback-launcher') out.rollbackLauncher = value;
    else if (key === 'restart-launcher') out.restartLauncher = value;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!out.selfTest) {
    for (const [name, value] of [
      ['--local-health', out.localHealth],
      ['--tailscale-bin', out.tailscaleBin],
      ['--tailscale-host', out.tailscaleHost],
      ['--ngrok-host', out.ngrokHost],
      ['--ngrok-config', out.ngrokConfig],
      ['--token-file', out.tokenFile],
      ['--log-dir', out.logDir],
    ]) {
      if (!value) throw new Error(`${name} is required`);
    }
    if (out.child.length === 0) throw new Error('Runtime child command is required after --');
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

function appendJson(filePath, record) {
  try {
    rotateFile(filePath);
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
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

function readLockOwner(lockFile) {
  const raw = fs.readFileSync(lockFile, 'utf8').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid dual supervisor lock owner: ${raw || '<empty>'}`);
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid dual supervisor lock owner: ${raw}`);
  return pid;
}

function handoverGuardFile(lockFile) {
  return `${lockFile}.handover`;
}

function releaseGuard(guardFile, fd) {
  try { fs.closeSync(fd); } catch {}
  try { fs.rmSync(guardFile, { force: true }); } catch {}
}

export function acquireLock(lockFile, { currentPid = process.pid, isAlive = pidIsAlive } = {}) {
  ensureDir(path.dirname(lockFile));
  const guardFile = handoverGuardFile(lockFile);
  if (fs.existsSync(guardFile)) throw new Error('Dual supervisor handover is already in progress');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeFileSync(fd, `${currentPid}\n`, 'utf8');
      return () => {
        try { fs.closeSync(fd); } catch {}
        try { fs.rmSync(lockFile, { force: true }); } catch {}
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      let existingPid = 0;
      try { existingPid = readLockOwner(lockFile); } catch {}
      if (isAlive(existingPid)) throw new Error(`Dual supervisor already running with pid=${existingPid}`);
      try { fs.rmSync(lockFile, { force: true }); } catch {}
    }
  }
  throw new Error('Could not acquire dual supervisor lock');
}

export function prepareHandoverLock(lockFile, expectedPid, { currentPid = process.pid, isAlive = pidIsAlive } = {}) {
  ensureDir(path.dirname(lockFile));
  if (!Number.isInteger(expectedPid) || expectedPid <= 0) throw new Error('Handover requires a valid expected owner pid');
  const guardFile = handoverGuardFile(lockFile);
  let guardFd = null;
  try {
    guardFd = fs.openSync(guardFile, 'wx');
    fs.writeFileSync(guardFd, `${currentPid}:${expectedPid}\n`, 'utf8');
    const ownerPid = readLockOwner(lockFile);
    if (ownerPid !== expectedPid) {
      throw new Error(`Handover lock owner mismatch: expected pid=${expectedPid}, actual pid=${ownerPid}`);
    }
    if (!isAlive(ownerPid)) throw new Error(`Handover lock owner is stale: pid=${ownerPid}`);
    return {
      lockFile,
      guardFile,
      guardFd,
      currentPid,
      expectedPid,
      release() {
        if (guardFd === null) return;
        releaseGuard(guardFile, guardFd);
        guardFd = null;
      },
    };
  } catch (error) {
    if (guardFd !== null) releaseGuard(guardFile, guardFd);
    throw error;
  }
}

export function claimHandoverLock(handover, { isAlive = pidIsAlive } = {}) {
  if (!handover || !handover.lockFile || !handover.guardFile || handover.guardFd === null) {
    throw new Error('Valid handover guard is required before claiming singleton lock');
  }
  const { lockFile, guardFile, currentPid, expectedPid } = handover;
  const guardOwner = fs.readFileSync(guardFile, 'utf8').trim();
  if (guardOwner !== `${currentPid}:${expectedPid}`) throw new Error('Handover guard ownership changed; refusing takeover');
  if (isAlive(expectedPid)) throw new Error(`Handover owner is still running: pid=${expectedPid}`);

  let fd = null;
  if (fs.existsSync(lockFile)) {
    const ownerPid = readLockOwner(lockFile);
    if (ownerPid !== expectedPid) {
      throw new Error(`Handover lock changed during takeover: expected pid=${expectedPid}, actual pid=${ownerPid}`);
    }
    fd = fs.openSync(lockFile, 'r+');
    const confirmedOwner = readLockOwner(lockFile);
    if (confirmedOwner !== expectedPid) {
      try { fs.closeSync(fd); } catch {}
      throw new Error(`Handover lock raced during claim: expected pid=${expectedPid}, actual pid=${confirmedOwner}`);
    }
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, `${currentPid}\n`, 'utf8');
  } else {
    fd = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(fd, `${currentPid}\n`, 'utf8');
  }

  handover.release();
  return () => {
    try { fs.closeSync(fd); } catch {}
    try {
      if (fs.existsSync(lockFile) && readLockOwner(lockFile) === currentPid) fs.rmSync(lockFile, { force: true });
    } catch {}
  };
}

export async function probe(url, timeoutMs = DEFAULTS.probeTimeoutMs, token = '', connectAddress = '') {
  const started = performance.now();
  try {
    let status;
    if (connectAddress) {
      const target = new URL(url);
      if (target.protocol !== 'https:') throw new Error('connectAddress probe requires https');
      status = await new Promise((resolve, reject) => {
        const headers = { Host: target.host };
        if (token) headers.Authorization = `Bearer ${token}`;
        const request = https.request({
          hostname: connectAddress,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers,
          servername: target.hostname,
          rejectUnauthorized: true,
          agent: false,
        }, (response) => {
          response.resume();
          resolve(response.statusCode || 0);
        });
        request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
        request.on('error', reject);
        request.end();
      });
    } else {
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
      const response = await fetch(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
      try { await response.body?.cancel(); } catch {}
      status = response.status;
    }
    return {
      ok: true,
      status,
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

export async function probeNgrokControl(url, timeoutMs = DEFAULTS.probeTimeoutMs) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json();
    const tunnels = Array.isArray(body?.tunnels) ? body.tunnels : [];
    return {
      available: true,
      ok: response.ok && tunnels.length > 0,
      status: response.status,
      tunnelCount: tunnels.length,
      error: '',
    };
  } catch (error) {
    return {
      available: true,
      ok: false,
      status: 0,
      tunnelCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function classifyNgrokRecovery({ childAlive, controlFailures, failureThreshold, publicResult }) {
  if (!childAlive) return { action: 'RESTART_NGROK', reason: 'TUNNEL_PROCESS_EXITED' };
  if (controlFailures < failureThreshold) return { action: 'NONE', reason: '' };
  if (!publicResult) return { action: 'SUPPRESS', reason: 'INSUFFICIENT_RECOVERY_EVIDENCE' };
  if (publicResult.ok) return { action: 'SUPPRESS', reason: 'PUBLIC_PATH_REACHABLE' };
  return { action: 'RESTART_NGROK', reason: 'MULTI_SIGNAL_TUNNEL_OUTAGE' };
}

export const PREFERRED_TRANSPORT = 'TAILSCALE';

export function selectActiveTransport({
  tailscaleHealthy,
  ngrokHealthy,
  previousActiveTransport = 'NONE',
}) {
  const previous = ['TAILSCALE', 'NGROK', 'NONE'].includes(previousActiveTransport)
    ? previousActiveTransport
    : 'NONE';
  const activeTransport = tailscaleHealthy ? 'TAILSCALE' : (ngrokHealthy ? 'NGROK' : 'NONE');
  let reason = 'UNCHANGED';
  if (activeTransport !== previous) {
    if (activeTransport === 'TAILSCALE') {
      reason = previous === 'NGROK' ? 'PRIMARY_RECOVERED' : 'PRIMARY_AVAILABLE';
    } else if (activeTransport === 'NGROK') {
      reason = 'PRIMARY_UNAVAILABLE';
    } else {
      reason = 'BOTH_UNAVAILABLE';
    }
  }
  return {
    preferredTransport: PREFERRED_TRANSPORT,
    activeTransport,
    previousActiveTransport: previous,
    changed: activeTransport !== previous,
    reason,
  };
}

function terminatePidTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !pidIsAlive(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch {}
}

function terminateProcessTree(child) {
  if (!child || !Number.isInteger(child.pid)) return;
  terminatePidTree(child.pid);
}

function launchRollback(options, logger) {
  if (!options.rollbackLauncher) return false;
  try {
    const child = spawn('cmd.exe', ['/c', options.rollbackLauncher], {
      cwd: options.cwd || process.cwd(),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    logger.event('rollback_launched', 'Existing primary launcher started after failed handover.');
    return true;
  } catch (error) {
    logger.event('rollback_launch_failed', 'Failed to start existing primary launcher.', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function restartDelay(attempt, baseMs, maxMs) {
  return Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt - 1)));
}

const CONTROLLED_HANDOVER_ACTION = 'CODEXPRO_CONTROLLED_HANDOVER';
const CONTROLLED_HANDOVER_MAX_AGE_MS = 120000;
const CONTROLLED_HANDOVER_RESPONSE_GRACE_MS = 3000;

function controlledHandoverRequestPath(options) {
  return path.join(options.logDir, `${options.name}.control.json`);
}

export function validateControlledHandoverRequest(raw, options, nowMs = Date.now(), currentPid = process.pid) {
  let request;
  try {
    request = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, reason: 'INVALID_JSON' };
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) return { ok: false, reason: 'INVALID_SCHEMA' };
  const keys = Object.keys(request).sort();
  const expectedKeys = ['action', 'expectedSupervisorPid', 'requestId', 'requestedAt', 'version'];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) return { ok: false, reason: 'INVALID_SCHEMA' };
  if (request.version !== 1 || request.action !== CONTROLLED_HANDOVER_ACTION) return { ok: false, reason: 'INVALID_ACTION' };
  if (typeof request.requestId !== 'string' || request.requestId.length < 8 || request.requestId.length > 128) return { ok: false, reason: 'INVALID_REQUEST_ID' };
  if (!Number.isInteger(request.expectedSupervisorPid) || request.expectedSupervisorPid !== currentPid) return { ok: false, reason: 'SUPERVISOR_PID_MISMATCH' };
  const requestedAtMs = Date.parse(request.requestedAt);
  if (!Number.isFinite(requestedAtMs)) return { ok: false, reason: 'INVALID_REQUEST_TIME' };
  const ageMs = nowMs - requestedAtMs;
  if (ageMs < -10000 || ageMs > CONTROLLED_HANDOVER_MAX_AGE_MS) return { ok: false, reason: 'STALE_REQUEST' };
  if (!options.restartLauncher || !fs.existsSync(options.restartLauncher)) return { ok: false, reason: 'RESTART_LAUNCHER_UNAVAILABLE' };
  return { ok: true, request };
}

function consumeControlledHandoverRequest(options, logger) {
  const requestPath = controlledHandoverRequestPath(options);
  if (!fs.existsSync(requestPath)) return null;
  let raw = '';
  try {
    raw = fs.readFileSync(requestPath, 'utf8');
  } catch (error) {
    logger.event('controlled_handover_rejected', 'Unable to read controlled handover request; request will be discarded.', {
      reason: 'REQUEST_READ_FAILED',
      error: error instanceof Error ? error.message : String(error),
    });
    try { fs.rmSync(requestPath, { force: true }); } catch {}
    return null;
  }
  const validated = validateControlledHandoverRequest(raw, options);
  try { fs.rmSync(requestPath, { force: true }); } catch {}
  if (!validated.ok) {
    logger.event('controlled_handover_rejected', 'Controlled handover request rejected and discarded.', { reason: validated.reason });
    return null;
  }
  return validated.request;
}

async function waitForControlledHandoverRequest(options, logger, totalMs) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const request = consumeControlledHandoverRequest(options, logger);
    if (request) return request;
    await sleep(Math.min(500, Math.max(1, deadline - Date.now())));
  }
  return null;
}

function launchControlledRestart(options, logger) {
  if (!options.restartLauncher || !fs.existsSync(options.restartLauncher)) {
    logger.event('controlled_handover_launch_failed', 'Canonical restart launcher is unavailable after lock release.');
    return false;
  }
  try {
    const child = spawn('cmd.exe', ['/d', '/c', options.restartLauncher], {
      cwd: options.cwd || process.cwd(),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    logger.event('controlled_handover_launcher_started', 'Canonical CodexPro launcher started after controlled handover cleanup.');
    return true;
  } catch (error) {
    logger.event('controlled_handover_launch_failed', 'Failed to start canonical CodexPro launcher after controlled handover cleanup.', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function isDualSupervisorStopKey(input) {
  const text = String(input ?? '');
  return text === '\u0003' || text.trim().toLowerCase() === 'q';
}

function createLogger(logDir) {
  ensureDir(logDir);
  const eventsPath = path.join(logDir, 'dual-supervisor.log');
  const healthPath = path.join(logDir, 'dual-health.jsonl');
  return {
    event(kind, message, detail = {}) {
      const record = { ts: new Date().toISOString(), kind, message, ...detail };
      appendJson(eventsPath, record);
      console.log(`[${record.ts}] ${kind}: ${message}`);
    },
    health(detail) {
      appendJson(healthPath, { ts: new Date().toISOString(), ...detail });
    },
  };
}

function runTailscale(options, args) {
  return spawnSync(options.tailscaleBin, args, {
    cwd: options.cwd || process.cwd(),
    stdio: 'pipe',
    encoding: 'utf8',
    windowsHide: true,
  });
}

export function tailscaleProbeAddress(options) {
  const result = runTailscale(options, ['ip', '-4']);
  if (result.status !== 0) {
    throw new Error(`Unable to resolve local Tailscale IPv4: ${String(result.stderr || result.stdout || '').trim()}`);
  }
  const address = String(result.stdout || '').trim().split(/\s+/)[0] || '';
  if (isIP(address) !== 4) throw new Error(`Invalid local Tailscale IPv4: ${address || '<empty>'}`);
  return address;
}

function normalizeProxyTarget(value) {
  return String(value || '').replace(/\/+$/, '');
}

export function tailscaleFunnelMatches(statusJson, host, target) {
  let parsed;
  try {
    parsed = typeof statusJson === 'string' ? JSON.parse(statusJson) : statusJson;
  } catch {
    return false;
  }
  const authority = `${host}:443`;
  const handler = parsed?.Web?.[authority]?.Handlers?.['/'];
  return parsed?.TCP?.['443']?.HTTPS === true
    && parsed?.AllowFunnel?.[authority] === true
    && normalizeProxyTarget(handler?.Proxy) === normalizeProxyTarget(target);
}

function enableTailscaleFunnel(options, logger) {
  const status = runTailscale(options, ['status', '--json']);
  if (status.status !== 0) throw new Error(`Tailscale is not connected: ${String(status.stderr || status.stdout || '').trim()}`);
  const funnelStatus = runTailscale(options, ['funnel', 'status', '--json']);
  if (funnelStatus.status === 0 && tailscaleFunnelMatches(funnelStatus.stdout, options.tailscaleHost, options.tailscaleTarget)) {
    logger.event('tailscale_funnel_reused', `Existing Tailscale Funnel already targets ${options.tailscaleTarget}; configuration write skipped.`);
    return;
  }
  const result = runTailscale(options, ['funnel', '--bg', '--yes', options.tailscaleTarget]);
  if (result.status !== 0) throw new Error(`Failed to enable Tailscale Funnel: ${String(result.stderr || result.stdout || '').trim()}`);
  logger.event('tailscale_funnel_enabled', `Tailscale Funnel enabled for https://${options.tailscaleHost}`);
}

function startRuntime(options, logger) {
  const [command, ...args] = options.child;
  logger.event('runtime_start', 'Starting single CodexPro local runtime.');
  return spawn(command, args, {
    cwd: options.cwd || process.cwd(),
    env: process.env,
    stdio: 'ignore',
    windowsHide: false,
  });
}

function startNgrok(options, logger) {
  const publicBase = `https://${options.ngrokHost}`;
  const args = [
    'http', options.tailscaleTarget,
    '--url', publicBase,
    '--log', options.ngrokLog || path.join(options.logDir, 'ngrok.jsonl'),
    '--log-format', 'json',
    '--log-level', 'info',
    '--config', options.ngrokConfig,
  ];
  logger.event('ngrok_start', `Starting independent ngrok tunnel for ${publicBase}.`);
  return spawn(options.ngrokBin, args, {
    cwd: options.cwd || process.cwd(),
    env: process.env,
    stdio: 'ignore',
    windowsHide: true,
  });
}

async function waitReachable(url, timeoutMs, totalMs, token = '', connectAddress = '') {
  const deadline = Date.now() + totalMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await probe(url, timeoutMs, token, connectAddress);
    if (last.ok) return last;
    await sleep(1000);
  }
  return last || { ok: false, status: 0, latencyMs: 0, error: 'timeout' };
}

export async function waitRuntimeStartup(child, url, timeoutMs, totalMs, token = '') {
  const deadline = Date.now() + totalMs;
  let last = null;
  while (Date.now() < deadline) {
    const alive = child && child.exitCode === null && child.signalCode === null && pidIsAlive(child.pid);
    if (!alive) {
      return {
        ok: false,
        status: 0,
        latencyMs: 0,
        error: 'runtime child exited before health became reachable',
        childExitCode: child?.exitCode ?? null,
        childSignal: child?.signalCode ?? null,
      };
    }
    last = await probe(url, timeoutMs, token);
    if (last.ok) return { ...last, childExitCode: null, childSignal: null };
    await sleep(1000);
  }
  return {
    ...(last || { ok: false, status: 0, latencyMs: 0, error: 'timeout' }),
    childExitCode: child?.exitCode ?? null,
    childSignal: child?.signalCode ?? null,
  };
}

export async function runSupervisor(options) {
  ensureDir(options.logDir);
  const lockFile = path.join(options.logDir, `${options.name}.lock`);
  let handoverLock = null;
  let releaseLock = null;
  if (options.handoverPid > 0) handoverLock = prepareHandoverLock(lockFile, options.handoverPid);
  else releaseLock = acquireLock(lockFile);
  const logger = createLogger(options.logDir);
  const healthToken = fs.readFileSync(options.tokenFile, 'utf8').trim();
  if (!healthToken) throw new Error('Health probe token file is empty.');
  let stopping = false;
  let runtimeChild = null;
  let ngrokChild = null;
  let localFailures = 0;
  let runtimeRestartCount = 0;
  let ngrokControlFailures = 0;
  let tailscaleFailures = 0;
  let lastNgrokControlAt = 0;
  let lastNgrokPublicAt = 0;
  let lastTailscaleState = '';
  let lastNgrokPublicState = '';
  let lastNgrokPublicHealthy = false;
  let activeTransport = 'NONE';
  let startupNormalReported = false;
  let handoverComplete = options.handoverPid > 0 ? false : true;
  let handoverOldStopped = false;
  let controlledHandoverRequest = null;
  let cleanupConsole = () => {};

  const stop = () => { stopping = true; };
  const reportStartupNormal = (localResult, tailscaleResult, ngrokResult) => {
    if (startupNormalReported) return;
    if (localResult?.status !== 200 || tailscaleResult?.status !== 200 || ngrokResult?.status !== 200) return;
    startupNormalReported = true;
    logger.event('startup_normal', 'CodexPro 정상: authenticated local/Tailscale/ngrok health all returned HTTP 200.');
    console.log('\x1b[92m============================================================\x1b[0m');
    console.log('\x1b[92m  [OK] CodexPro 정상 - Local / Tailscale / ngrok 모두 정상\x1b[0m');
    console.log('\x1b[92m============================================================\x1b[0m');
  };
  const applyTransportBoundary = (tailscaleHealthy, ngrokHealthy, boundary) => {
    const decision = selectActiveTransport({
      tailscaleHealthy,
      ngrokHealthy,
      previousActiveTransport: activeTransport,
    });
    if (decision.changed) {
      logger.event(
        'transport_switch',
        `Active execution transport ${decision.previousActiveTransport} -> ${decision.activeTransport}.`,
        {
          boundary,
          preferredTransport: decision.preferredTransport,
          previousActiveTransport: decision.previousActiveTransport,
          activeTransport: decision.activeTransport,
          reason: decision.reason,
        },
      );
    }
    activeTransport = decision.activeTransport;
    return decision;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    if (typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(true);
    process.stdin.resume();
    const onInput = (input) => {
      if (!isDualSupervisorStopKey(input)) return;
      const label = String(input) === '\u0003' ? 'CTRL_C' : 'Q';
      console.log('');
      logger.event('console_stop', `Console stop requested via ${label}.`);
      stop();
    };
    process.stdin.on('data', onInput);
    console.log('Controls: q quit (recommended) | Ctrl+C quit');
    cleanupConsole = () => {
      process.stdin.off('data', onInput);
      if (typeof process.stdin.setRawMode === 'function') {
        try { process.stdin.setRawMode(false); } catch {}
      }
      try { process.stdin.pause(); } catch {}
    };
  }

  try {
    logger.event('start', `Dual transport supervisor started for ${options.name}.`, {
      localHealth: options.localHealth,
      tailscalePublic: `https://${options.tailscaleHost}/healthz`,
      ngrokPublic: `https://${options.ngrokHost}/healthz`,
      ngrokPublicIntervalMs: options.ngrokPublicIntervalMs,
    });

    enableTailscaleFunnel(options, logger);
    const tailscaleAddress = tailscaleProbeAddress(options);
    logger.event('tailscale_probe_route', `Tailscale self-probe pinned to local Tailscale IPv4 ${tailscaleAddress}; public hostname and TLS SNI are preserved.`);

    if (options.handoverPid > 0) {
      if (!options.rollbackLauncher || !fs.existsSync(options.rollbackLauncher)) {
        throw new Error('Handover requires an existing --rollback-launcher.');
      }
      const tailscalePreflight = await waitReachable(`https://${options.tailscaleHost}/healthz`, options.probeTimeoutMs, 30000, healthToken, tailscaleAddress);
      if (!tailscalePreflight.ok) {
        throw new Error(`Tailscale handover preflight failed: ${tailscalePreflight.error}`);
      }
      logger.event('handover_preflight_pass', 'Tailscale path is reachable before stopping the existing supervisor.', {
        handoverPid: options.handoverPid,
        status: tailscalePreflight.status,
      });
      await sleep(options.handoverDelayMs);
      terminatePidTree(options.handoverPid);
      handoverOldStopped = true;
      const stopDeadline = Date.now() + 10000;
      while (pidIsAlive(options.handoverPid) && Date.now() < stopDeadline) await sleep(100);
      if (pidIsAlive(options.handoverPid)) throw new Error(`Handover owner did not stop: pid=${options.handoverPid}`);
      releaseLock = claimHandoverLock(handoverLock);
      handoverLock = null;
      logger.event('handover_old_stopped', 'Existing supervisor stopped and singleton lock ownership transferred; starting dual runtime.');
    }

    runtimeChild = startRuntime(options, logger);
    let localReady = await waitRuntimeStartup(runtimeChild, options.localHealth, options.probeTimeoutMs, 30000, healthToken);
    if (!localReady.ok) {
      logger.event('runtime_initial_failure', 'Initial CodexPro runtime startup did not become healthy.', {
        pid: runtimeChild?.pid || null,
        error: localReady.error,
        childExitCode: localReady.childExitCode,
        childSignal: localReady.childSignal,
      });
      terminateProcessTree(runtimeChild);
      await sleep(5000);
      logger.event('runtime_initial_retry', 'Retrying local CodexPro runtime startup exactly once after initial startup failure.');
      runtimeChild = startRuntime(options, logger);
      localReady = await waitRuntimeStartup(runtimeChild, options.localHealth, options.probeTimeoutMs, 30000, healthToken);
    }
    if (!localReady.ok) {
      throw new Error(
        `Local CodexPro runtime did not become reachable after exact1 startup retry: ${localReady.error}; ` +
        `exit=${String(localReady.childExitCode)} signal=${String(localReady.childSignal)}`
      );
    }
    logger.event('runtime_ready', 'Local CodexPro runtime is reachable.', { pid: runtimeChild.pid, status: localReady.status });

    ngrokChild = startNgrok(options, logger);
    const tailscaleReady = await waitReachable(`https://${options.tailscaleHost}/healthz`, options.probeTimeoutMs, 30000, healthToken, tailscaleAddress);
    if (!tailscaleReady.ok) logger.event('tailscale_initial_degraded', 'Tailscale public path is not yet reachable.', { result: tailscaleReady });
    else logger.event('tailscale_ready', 'Tailscale public path is reachable.', { status: tailscaleReady.status });

    const ngrokReady = await waitReachable(`https://${options.ngrokHost}/healthz`, options.probeTimeoutMs, 30000, healthToken);
    if (!ngrokReady.ok) logger.event('ngrok_initial_degraded', 'ngrok public path is not yet reachable.', { result: ngrokReady });
    else logger.event('ngrok_ready', 'ngrok public path is reachable.', { status: ngrokReady.status, pid: ngrokChild.pid });

    lastNgrokPublicHealthy = ngrokReady.status === 200;
    applyTransportBoundary(tailscaleReady.status === 200, lastNgrokPublicHealthy, 'STARTUP');
    reportStartupNormal(localReady, tailscaleReady, ngrokReady);

    if (options.handoverPid > 0) {
      if (!tailscaleReady.ok || !ngrokReady.ok) {
        throw new Error('Dual transport handover failed initial public health gate.');
      }
      handoverComplete = true;
      logger.event('handover_pass', 'Dual transport handover completed with local, Tailscale, and ngrok reachable.');
    }

    while (!stopping) {
      const pendingControl = await waitForControlledHandoverRequest(options, logger, options.intervalMs);
      if (pendingControl) {
        controlledHandoverRequest = pendingControl;
        logger.event('controlled_handover_accepted', 'Controlled CodexPro handover request accepted; response grace period begins before supervisor cleanup.', {
          requestId: pendingControl.requestId,
          expectedSupervisorPid: pendingControl.expectedSupervisorPid,
          responseGraceMs: CONTROLLED_HANDOVER_RESPONSE_GRACE_MS,
        });
        await sleep(CONTROLLED_HANDOVER_RESPONSE_GRACE_MS);
        break;
      }
      const now = Date.now();

      const runtimeAlive = runtimeChild && runtimeChild.exitCode === null && runtimeChild.signalCode === null && pidIsAlive(runtimeChild.pid);
      const local = runtimeAlive ? await probe(options.localHealth, options.probeTimeoutMs, healthToken) : { ok: false, status: 0, latencyMs: 0, error: 'runtime child exited' };
      localFailures = local.ok ? 0 : localFailures + 1;

      if (!runtimeAlive || localFailures >= options.failureThreshold) {
        const reason = !runtimeAlive ? 'RUNTIME_PROCESS_EXITED' : 'LOCAL_RUNTIME_OUTAGE';
        terminateProcessTree(runtimeChild);
        runtimeRestartCount += 1;
        if (runtimeRestartCount > options.maxRapidRestarts) throw new Error(`Runtime restart budget exhausted after ${runtimeRestartCount - 1} rapid restarts.`);
        const delay = restartDelay(runtimeRestartCount, options.restartBaseMs, options.restartMaxMs);
        logger.event('runtime_restart', `${reason}; restarting local runtime only.`, { delay, runtimeRestartCount });
        await sleep(delay);
        runtimeChild = startRuntime(options, logger);
        localFailures = 0;
      } else if (local.ok && runtimeRestartCount > 0) {
        runtimeRestartCount = 0;
      }

      const tailscale = await probe(`https://${options.tailscaleHost}/healthz`, options.probeTimeoutMs, healthToken, tailscaleAddress);
      tailscaleFailures = tailscale.ok ? 0 : tailscaleFailures + 1;
      const tailscaleState = tailscale.ok ? 'HEALTHY' : (tailscaleFailures >= options.failureThreshold ? 'OUTAGE' : 'DEGRADED');
      if (tailscaleState !== lastTailscaleState) {
        logger.event('tailscale_state', `Tailscale ${tailscaleState}; runtime restart is forbidden.`, { tailscale, tailscaleFailures });
        lastTailscaleState = tailscaleState;
      }

      let ngrokControl = null;
      let ngrokPublic = null;
      const ngrokAlive = ngrokChild && ngrokChild.exitCode === null && ngrokChild.signalCode === null && pidIsAlive(ngrokChild.pid);
      let ngrokDecision = classifyNgrokRecovery({
        childAlive: Boolean(ngrokAlive),
        controlFailures: ngrokControlFailures,
        failureThreshold: options.failureThreshold,
        publicResult: null,
      });

      if (!ngrokAlive) {
        lastNgrokPublicHealthy = false;
        logger.event('ngrok_recovery', 'ngrok process exited; restarting tunnel only.', { reason: ngrokDecision.reason });
        terminateProcessTree(ngrokChild);
        ngrokChild = startNgrok(options, logger);
        ngrokControlFailures = 0;
        lastNgrokControlAt = 0;
        lastNgrokPublicAt = 0;
      } else if (now - lastNgrokControlAt >= options.ngrokControlIntervalMs) {
        ngrokControl = await probeNgrokControl(options.ngrokApi, options.probeTimeoutMs);
        lastNgrokControlAt = now;
        ngrokControlFailures = ngrokControl.ok ? 0 : ngrokControlFailures + 1;

        if (ngrokControlFailures >= options.failureThreshold) {
          ngrokPublic = await probe(`https://${options.ngrokHost}/healthz`, options.probeTimeoutMs, healthToken);
          lastNgrokPublicAt = now;
          ngrokDecision = classifyNgrokRecovery({
            childAlive: true,
            controlFailures: ngrokControlFailures,
            failureThreshold: options.failureThreshold,
            publicResult: ngrokPublic,
          });
          if (ngrokDecision.action === 'RESTART_NGROK') {
            logger.event('ngrok_recovery', 'Multi-signal ngrok outage; restarting tunnel only.', {
              reason: ngrokDecision.reason,
              control: ngrokControl,
              public: ngrokPublic,
            });
            terminateProcessTree(ngrokChild);
            await sleep(1000);
            ngrokChild = startNgrok(options, logger);
            lastNgrokPublicHealthy = false;
            ngrokControlFailures = 0;
            lastNgrokControlAt = 0;
            lastNgrokPublicAt = 0;
          } else {
            logger.event('ngrok_recovery_suppressed', 'ngrok recovery suppressed; runtime remains untouched.', {
              reason: ngrokDecision.reason,
              control: ngrokControl,
              public: ngrokPublic,
            });
            ngrokControlFailures = 0;
          }
        }
      }

      if (tailscale.status !== 200 && ngrokChild && pidIsAlive(ngrokChild.pid) && !ngrokPublic) {
        ngrokPublic = await probe(`https://${options.ngrokHost}/healthz`, options.probeTimeoutMs, healthToken);
        lastNgrokPublicAt = now;
      }

      if (ngrokChild && pidIsAlive(ngrokChild.pid) && now - lastNgrokPublicAt >= options.ngrokPublicIntervalMs) {
        ngrokPublic = await probe(`https://${options.ngrokHost}/healthz`, options.probeTimeoutMs, healthToken);
        lastNgrokPublicAt = now;
        const state = ngrokPublic.status === 200 ? 'HEALTHY' : 'DEGRADED';
        if (state !== lastNgrokPublicState) {
          logger.event('ngrok_public_state', `ngrok public path ${state}; public-only failure never restarts runtime or tunnel.`, { public: ngrokPublic });
          lastNgrokPublicState = state;
        }
      }

      if (ngrokPublic) {
        lastNgrokPublicHealthy = ngrokPublic.status === 200;
        reportStartupNormal(local, tailscale, ngrokPublic);
      }
      const backupHealthy = Boolean(ngrokChild && pidIsAlive(ngrokChild.pid)) && lastNgrokPublicHealthy;
      const transportDecision = applyTransportBoundary(tailscale.status === 200, backupHealthy, 'HEALTH_LOOP');

      logger.health({
        runtimePid: runtimeChild?.pid || null,
        ngrokPid: ngrokChild?.pid || null,
        local,
        localFailures,
        tailscale,
        tailscaleFailures,
        ngrokControl,
        ngrokControlFailures,
        ngrokPublic,
        preferredTransport: transportDecision.preferredTransport,
        activeTransport: transportDecision.activeTransport,
        transportReason: transportDecision.reason,
        runtimeRestartCount,
      });
    }
  } catch (error) {
    if (options.handoverPid > 0 && handoverOldStopped && !handoverComplete) {
      logger.event('handover_failed', 'Initial dual transport handover failed; rollback will be attempted.', {
        error: error instanceof Error ? error.message : String(error),
      });
      terminateProcessTree(runtimeChild);
      terminateProcessTree(ngrokChild);
      await sleep(1500);
      launchRollback(options, logger);
    }
    throw error;
  } finally {
    logger.event('shutdown', 'Stopping dual supervisor; terminating local runtime and ngrok only. Tailscale Funnel config is preserved.');
    terminateProcessTree(runtimeChild);
    terminateProcessTree(ngrokChild);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    cleanupConsole();
    try { handoverLock?.release(); } catch {}
    try { releaseLock?.(); } catch {}
    if (controlledHandoverRequest) {
      await sleep(500);
      launchControlledRestart(options, logger);
    }
  }
}

async function runSelfTest() {
  const checks = [];
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
    checks.push(message);
  };
  const parsed = parseArgs([
    '--local-health', 'http://127.0.0.1:8787/healthz',
    '--tailscale-bin', 'tailscale.exe',
    '--tailscale-host', 'example.ts.net',
    '--ngrok-host', 'example.ngrok-free.dev',
    '--ngrok-config', 'ngrok.yml',
    '--token-file', 'token.txt',
    '--log-dir', '.',
    '--handover-pid', '1234',
    '--handover-delay-ms', '5000',
    '--rollback-launcher', 'rollback.cmd',
    '--restart-launcher', 'restart.cmd',
    '--', 'node', 'runtime.js',
  ]);
  assert(parsed.ngrokPublicIntervalMs === 300000, 'ngrok public probe defaults to five minutes');
  assert(parsed.handoverPid === 1234 && parsed.rollbackLauncher === 'rollback.cmd', 'handover rollback options parsed');
  assert(parsed.restartLauncher === 'restart.cmd', 'controlled restart launcher parsed');
  assert(parsed.child.length === 2, 'runtime child parsed');
  assert(classifyNgrokRecovery({ childAlive: false, controlFailures: 0, failureThreshold: 3, publicResult: null }).reason === 'TUNNEL_PROCESS_EXITED', 'dead ngrok restarts immediately');
  assert(classifyNgrokRecovery({ childAlive: true, controlFailures: 2, failureThreshold: 3, publicResult: { ok: false } }).action === 'NONE', 'transient control failure does not restart');
  assert(classifyNgrokRecovery({ childAlive: true, controlFailures: 3, failureThreshold: 3, publicResult: null }).reason === 'INSUFFICIENT_RECOVERY_EVIDENCE', 'missing corroboration suppresses');
  assert(classifyNgrokRecovery({ childAlive: true, controlFailures: 3, failureThreshold: 3, publicResult: { ok: true } }).reason === 'PUBLIC_PATH_REACHABLE', 'reachable public path suppresses');
  assert(classifyNgrokRecovery({ childAlive: true, controlFailures: 3, failureThreshold: 3, publicResult: { ok: false } }).reason === 'MULTI_SIGNAL_TUNNEL_OUTAGE', 'multi-signal outage restarts ngrok only');
  console.log(`✓ dual transport supervisor self-test passed (${checks.length} checks)`);
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  const options = parseArgs(process.argv.slice(2));
  const task = options.selfTest ? runSelfTest() : runSupervisor(options);
  task.catch((error) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
