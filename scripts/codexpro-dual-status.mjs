#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import https from 'node:https';
import { isIP } from 'node:net';

const toolsRoot = 'C:\\Codex\\tools';
const logDir = path.join(toolsRoot, 'codexpro-supervisor', 'dual-logs');
const lockFile = path.join(logDir, 'codexpro-personal-dual.lock');
const healthLog = path.join(logDir, 'dual-health.jsonl');
const eventLog = path.join(logDir, 'dual-supervisor.log');
const tokenFile = path.join(process.env.USERPROFILE || '', '.codexpro', 'http-token');
const hostsFile = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
const tailscaleBin = 'C:\\Program Files\\Tailscale\\tailscale.exe';
const tailscaleHost = 'aaron.tailbdbf19.ts.net';
const tailscaleTarget = 'http://127.0.0.1:8787';
const ngrokHost = 'undusted-elite-populace.ngrok-free.dev';

function lastJsonLine(file) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const result = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return false;
  const text = String(result.stdout || '').trim();
  return text && !/No tasks are running/i.test(text) && text.includes(`"${pid}"`);
}

function listenerPids(port) {
  const result = spawnSync('netstat.exe', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return [];
  const found = new Set();
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const local = parts[1];
    const pid = Number(parts[4]);
    if ((local.endsWith(`:${port}`) || local.endsWith(`]:${port}`)) && Number.isInteger(pid) && pid > 0) found.add(pid);
  }
  return [...found];
}

async function health(url, token, connectAddress = '') {
  const started = Date.now();
  try {
    let status;
    if (connectAddress) {
      const target = new URL(url);
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
        request.setTimeout(8000, () => request.destroy(new Error('timeout')));
        request.on('error', reject);
        request.end();
      });
    } else {
      const response = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(8000),
      });
      status = response.status;
    }
    return { status, ok: status === 200, latencyMs: Date.now() - started };
  } catch (error) {
    return { status: 0, ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

function localTailscaleAddress() {
  const result = spawnSync(tailscaleBin, ['ip', '-4'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return '';
  const address = String(result.stdout || '').trim().split(/\s+/)[0] || '';
  return isIP(address) === 4 ? address : '';
}

function funnelState() {
  const result = spawnSync(tailscaleBin, ['funnel', 'status', '--json'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return { ok: false, reason: String(result.stderr || result.stdout || '').trim() };
  try {
    const parsed = JSON.parse(result.stdout);
    const authority = `${tailscaleHost}:443`;
    const proxy = parsed?.Web?.[authority]?.Handlers?.['/']?.Proxy || '';
    const matched = parsed?.TCP?.['443']?.HTTPS === true
      && parsed?.AllowFunnel?.[authority] === true
      && String(proxy).replace(/\/+$/, '') === tailscaleTarget;
    return { ok: matched, proxy, allowFunnel: parsed?.AllowFunnel?.[authority] === true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

const lockOwner = fs.existsSync(lockFile) ? Number(fs.readFileSync(lockFile, 'utf8').trim()) : 0;
const latestHealth = lastJsonLine(healthLog);
const latestEvent = lastJsonLine(eventLog);
const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
const tailscaleAddress = localTailscaleAddress();
const local = await health('http://127.0.0.1:8787/healthz', token);
const tailscale = await health(`https://${tailscaleHost}/healthz`, token, tailscaleAddress);
const ngrok = await health(`https://${ngrokHost}/healthz`, token);
const listeners = listenerPids(8787);
const funnel = funnelState();
const hostsStat = fs.existsSync(hostsFile) ? fs.statSync(hostsFile) : null;
const preferredTransport = 'TAILSCALE';
const activeTransport = tailscale.ok ? 'TAILSCALE' : (ngrok.ok ? 'NGROK' : 'NONE');
const runtimeRestartCount = Number(latestHealth?.runtimeRestartCount || 0);

const result = {
  checkedAt: new Date().toISOString(),
  preferredTransport,
  activeTransport,
  primaryHealth: tailscale,
  backupHealth: ngrok,
  capabilityParity: 'SHARED_LOCAL_RUNTIME_127.0.0.1:8787',
  runtimeRestartCount,
  supervisor: {
    lockOwner,
    alive: pidAlive(lockOwner),
  },
  runtime: {
    pid: Number(latestHealth?.runtimePid || 0) || null,
    alive: pidAlive(Number(latestHealth?.runtimePid || 0)),
  },
  http: {
    listenerPids: listeners,
  },
  ngrok: {
    pid: Number(latestHealth?.ngrokPid || 0) || null,
    alive: pidAlive(Number(latestHealth?.ngrokPid || 0)),
  },
  health: { local, tailscale, ngrok },
  funnel,
  hostsLastWrite: hostsStat?.mtime?.toISOString() || null,
  latestEvent: latestEvent ? { ts: latestEvent.ts, kind: latestEvent.kind, message: latestEvent.message } : null,
};

result.status = result.supervisor.alive
  && result.runtime.alive
  && result.ngrok.alive
  && result.http.listenerPids.length === 1
  && local.ok && tailscale.ok && ngrok.ok
  && funnel.ok
  ? 'PASS'
  : 'CHECK';

console.log(JSON.stringify(result, null, 2));
