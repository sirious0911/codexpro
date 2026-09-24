#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  acquireLock,
  claimHandoverLock,
  classifyActiveTransport,
  classifyExternalMcpState,
  classifyNgrokRecovery,
  consumeControlledHandoverRequest,
  isDualSupervisorStopKey,
  launcherSha256,
  parseArgs,
  prepareHandoverLock,
  probe,
  runSupervisor,
  probeExternalMcp,
  probeNgrokControl,
  supervisorFailureExitCode,
  tailscaleFunnelMatches,
  validateControlledHandoverRequest,
  verifyStartupLauncherSha,
  waitRuntimeStartup,
} from './dual-transport-supervisor.mjs';

const checks = [];
function pass(name) {
  checks.push(name);
}

const parsed = parseArgs([
  '--local-health', 'http://127.0.0.1:8787/healthz',
  '--tailscale-bin', 'tailscale.exe',
  '--tailscale-host', 'primary.ts.net',
  '--ngrok-host', 'backup.ngrok-free.dev',
  '--ngrok-config', 'ngrok.yml',
  '--token-file', 'token.txt',
  '--log-dir', '.',
  '--restart-launcher', 'restart.cmd',
  '--launcher-sha256', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '--ngrok-control-interval-ms', '30000',
  '--ngrok-public-interval-ms', '300000',
  '--external-mcp-interval-ms', '60000',
  '--external-dns-url', 'https://dns.google/resolve',
  '--', 'node', 'runtime.js',
]);
assert.equal(parsed.ngrokControlIntervalMs, 30000);
assert.equal(parsed.ngrokPublicIntervalMs, 300000);
assert.equal(parsed.externalMcpIntervalMs, 60000);
assert.equal(parsed.externalDnsUrl, 'https://dns.google/resolve');
assert.equal(parsed.launcherSha256, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
assert.deepEqual(parsed.child, ['node', 'runtime.js']);
pass('exact runtime and transport intervals parsed');

let missingLauncherShaError = null;
try {
  parseArgs([
    '--local-health', 'http://127.0.0.1:8787/healthz',
    '--tailscale-bin', 'tailscale.exe',
    '--tailscale-host', 'primary.ts.net',
    '--ngrok-host', 'backup.ngrok-free.dev',
    '--ngrok-config', 'ngrok.yml',
    '--token-file', 'token.txt',
    '--log-dir', '.',
    '--restart-launcher', 'restart.cmd',
    '--', 'node', 'runtime.js',
  ]);
} catch (error) {
  missingLauncherShaError = error;
}
assert.equal(supervisorFailureExitCode(missingLauncherShaError), 42);
pass('missing launcher SHA is classified as startup identity failure with no-fallback exit');

assert.equal(isDualSupervisorStopKey('q'), true);
assert.equal(isDualSupervisorStopKey('Q\r\n'), true);
assert.equal(isDualSupervisorStopKey('\u0003'), true);
assert.equal(isDualSupervisorStopKey('x'), false);
pass('dual supervisor accepts q and Ctrl+C stop keys');

assert.deepEqual(classifyExternalMcpState({ ok: true }, 1), { state: 'HEALTHY', failureCount: 0 });
assert.deepEqual(classifyExternalMcpState({ ok: false, indeterminate: true }, 1), { state: 'INDETERMINATE', failureCount: 1 });
assert.deepEqual(classifyExternalMcpState({ ok: false, indeterminate: false }, 0), { state: 'SUSPECT', failureCount: 1 });
assert.deepEqual(classifyExternalMcpState({ ok: false, indeterminate: false }, 1), { state: 'DEGRADED', failureCount: 2 });
pass('external MCP state preserves failure count across DNS uncertainty and requires two real failures');

assert.equal(classifyActiveTransport({ tailscaleState: 'HEALTHY', ngrokState: 'HEALTHY', previousTransport: 'NONE' }), 'TAILSCALE');
assert.equal(classifyActiveTransport({ tailscaleState: 'SUSPECT', ngrokState: 'HEALTHY', previousTransport: 'TAILSCALE' }), 'TAILSCALE');
assert.equal(classifyActiveTransport({ tailscaleState: 'INDETERMINATE', ngrokState: 'HEALTHY', previousTransport: 'TAILSCALE' }), 'TAILSCALE');
assert.equal(classifyActiveTransport({ tailscaleState: 'DEGRADED', ngrokState: 'HEALTHY', previousTransport: 'TAILSCALE' }), 'NGROK');
assert.equal(classifyActiveTransport({ tailscaleState: 'DEGRADED', ngrokState: 'DEGRADED', previousTransport: 'TAILSCALE' }), 'NONE');
assert.equal(classifyActiveTransport({ tailscaleState: 'HEALTHY', ngrokState: 'HEALTHY', previousTransport: 'NGROK' }), 'NGROK');
assert.equal(classifyActiveTransport({ tailscaleState: 'HEALTHY', ngrokState: 'SUSPECT', previousTransport: 'NGROK' }), 'NGROK');
assert.equal(classifyActiveTransport({ tailscaleState: 'HEALTHY', ngrokState: 'INDETERMINATE', previousTransport: 'NGROK' }), 'NGROK');
assert.equal(classifyActiveTransport({ tailscaleState: 'HEALTHY', ngrokState: 'DEGRADED', previousTransport: 'NGROK' }), 'TAILSCALE');
pass('active transport is sticky until the current transport is confirmed DEGRADED');

const invalidExternalMcp = await probeExternalMcp('http://127.0.0.1/mcp', 100, 'probe-token');
assert.equal(invalidExternalMcp.ok, false);
assert.match(invalidExternalMcp.error, /requires https URL/);
const missingTokenExternalMcp = await probeExternalMcp('https://example.invalid/mcp', 100, '');
assert.equal(missingTokenExternalMcp.ok, false);
assert.match(missingTokenExternalMcp.error, /requires bearer token/);
pass('external MCP probe fails closed before network on invalid security prerequisites');

const dualSource = fs.readFileSync(new URL('./dual-transport-supervisor.mjs', import.meta.url), 'utf8');
assert.match(dualSource, /cloudflare-dns\.com\/dns-query/);
assert.match(dualSource, /for \(const publicIp of resolved\.addresses\)/);
pass('external MCP probe has secondary DoH fallback and tries every resolved public IPv4');

const earlyExitStarted = Date.now();
const earlyExit = await waitRuntimeStartup(
  { pid: 999999, exitCode: 1, signalCode: null },
  'http://127.0.0.1:9/healthz',
  100,
  30000,
  '',
);
assert.equal(earlyExit.ok, false);
assert.equal(earlyExit.childExitCode, 1);
assert.match(earlyExit.error, /runtime child exited/);
assert.ok(Date.now() - earlyExitStarted < 1000);
pass('runtime startup detects early child exit without waiting for full health timeout');

const funnelStatus = JSON.stringify({
  TCP: { 443: { HTTPS: true } },
  Web: {
    'primary.ts.net:443': {
      Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' } },
    },
  },
  AllowFunnel: { 'primary.ts.net:443': true },
});
assert.equal(tailscaleFunnelMatches(funnelStatus, 'primary.ts.net', 'http://127.0.0.1:8787'), true);
pass('matching Tailscale Funnel status reuses existing configuration');
assert.equal(tailscaleFunnelMatches(funnelStatus, 'primary.ts.net', 'http://127.0.0.1:9999'), false);
pass('mismatched Tailscale Funnel target requires configuration update');
assert.equal(tailscaleFunnelMatches('{not-json', 'primary.ts.net', 'http://127.0.0.1:8787'), false);
pass('invalid Tailscale Funnel status fails safe to configuration update');

const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpro-dual-lock-'));
const lockFile = path.join(lockRoot, 'codexpro-personal-dual.lock');
try {
  fs.writeFileSync(lockFile, '11111\n', 'utf8');
  const matching = prepareHandoverLock(lockFile, 11111, {
    currentPid: 22222,
    isAlive: (pid) => pid === 11111,
  });
  assert.equal(fs.readFileSync(lockFile, 'utf8').trim(), '11111');
  assert.throws(
    () => acquireLock(lockFile, { currentPid: 33333, isAlive: (pid) => pid === 11111 }),
    /handover is already in progress/,
  );
  pass('normal supervisor is blocked while handover guard is active');
  const releaseMatching = claimHandoverLock(matching, { isAlive: () => false });
  assert.equal(fs.readFileSync(lockFile, 'utf8').trim(), '22222');
  releaseMatching();
  pass('matching handover owner transfers singleton lock only after old owner stops');

  fs.writeFileSync(lockFile, '33333\n', 'utf8');
  assert.throws(
    () => prepareHandoverLock(lockFile, 44444, { currentPid: 22222, isAlive: () => true }),
    /owner mismatch/,
  );
  assert.equal(fs.readFileSync(lockFile, 'utf8').trim(), '33333');
  pass('wrong handover pid fails closed without changing singleton lock');

  fs.writeFileSync(lockFile, '55555\n', 'utf8');
  assert.throws(
    () => prepareHandoverLock(lockFile, 55555, { currentPid: 22222, isAlive: () => false }),
    /owner is stale/,
  );
  assert.equal(fs.readFileSync(lockFile, 'utf8').trim(), '55555');
  pass('stale handover owner fails closed without deleting singleton lock');

  fs.writeFileSync(lockFile, '66666\n', 'utf8');
  const raced = prepareHandoverLock(lockFile, 66666, {
    currentPid: 22222,
    isAlive: (pid) => pid === 66666,
  });
  fs.writeFileSync(lockFile, '77777\n', 'utf8');
  assert.throws(
    () => claimHandoverLock(raced, { isAlive: () => false }),
    /lock changed during takeover/,
  );
  assert.equal(fs.readFileSync(lockFile, 'utf8').trim(), '77777');
  raced.release();
  pass('handover lock owner race fails closed');

  fs.writeFileSync(lockFile, '88888\n', 'utf8');
  assert.throws(
    () => acquireLock(lockFile, { currentPid: 99999, isAlive: (pid) => pid === 88888 }),
    /already running/,
  );
  assert.equal(fs.readFileSync(lockFile, 'utf8').trim(), '88888');
  pass('normal duplicate supervisor remains blocked by singleton lock');

  const restartLauncher = path.join(lockRoot, 'restart.cmd');
  fs.writeFileSync(restartLauncher, '@echo off\r\n', 'utf8');
  const startupLauncherSha256 = launcherSha256(restartLauncher);
  assert.equal(
    verifyStartupLauncherSha({ restartLauncher, launcherSha256: startupLauncherSha256 }),
    startupLauncherSha256,
  );
  pass('supervisor independently verifies and pins supplied launcher SHA before startup');

  const request = {
    version: 2,
    action: 'CODEXPRO_CONTROLLED_HANDOVER',
    requestId: 'request-12345678',
    requestedAt: '2026-09-09T14:30:00.000Z',
    expectedSupervisorPid: 88888,
    expectedLauncherSha256: startupLauncherSha256,
  };
  const validRequest = validateControlledHandoverRequest(
    request,
    { restartLauncher },
    Date.parse('2026-09-09T14:30:30.000Z'),
    88888,
    startupLauncherSha256,
  );
  assert.equal(validRequest.ok, true);
  pass('fresh controlled handover request with exact supervisor pid is accepted');
  assert.equal(
    validateControlledHandoverRequest(
      { ...request, expectedSupervisorPid: 77777 },
      { restartLauncher },
      Date.parse('2026-09-09T14:30:30.000Z'),
      88888,
      startupLauncherSha256,
    ).reason,
    'SUPERVISOR_PID_MISMATCH',
  );
  pass('controlled handover request fails closed on supervisor pid mismatch');
  assert.equal(
    validateControlledHandoverRequest(
      request,
      { restartLauncher },
      Date.parse('2026-09-09T14:33:00.001Z'),
      88888,
      startupLauncherSha256,
    ).reason,
    'STALE_REQUEST',
  );
  pass('controlled handover request fails closed when stale');

  const consumeOptions = { restartLauncher, logDir: lockRoot, name: 'consume-test' };
  const consumePath = path.join(lockRoot, 'consume-test.control.json');
  const consumeEvents = [];
  const consumeLogger = {
    event(kind, message, detail = {}) {
      consumeEvents.push({ kind, message, detail });
    },
  };

  fs.writeFileSync(consumePath, JSON.stringify({ ...request, expectedSupervisorPid: 77777 }), 'utf8');
  assert.equal(
    consumeControlledHandoverRequest(
      consumeOptions,
      consumeLogger,
      startupLauncherSha256,
      Date.parse('2026-09-09T14:30:30.000Z'),
      88888,
    ),
    null,
  );
  assert.equal(fs.existsSync(consumePath), false);
  assert.equal(consumeEvents.at(-1)?.kind, 'controlled_handover_rejected');
  pass('rejected controlled handover consumes the request without granting restart authority');

  fs.writeFileSync(consumePath, JSON.stringify(request), 'utf8');
  const acceptedAuthority = consumeControlledHandoverRequest(
    consumeOptions,
    consumeLogger,
    startupLauncherSha256,
    Date.parse('2026-09-09T14:30:30.000Z'),
    88888,
  );
  assert.equal(acceptedAuthority?.requestId, request.requestId);
  assert.equal(fs.existsSync(consumePath), false);
  assert.equal(
    consumeControlledHandoverRequest(
      consumeOptions,
      consumeLogger,
      startupLauncherSha256,
      Date.parse('2026-09-09T14:30:30.000Z'),
      88888,
    ),
    null,
  );
  pass('accepted controlled handover grants exactly one consumable restart authority');

  fs.writeFileSync(consumePath, JSON.stringify(request), 'utf8');
  const finalizeFailureOps = {
    existsSync: fs.existsSync,
    renameSync: fs.renameSync,
    readFileSync: fs.readFileSync,
    rmSync() {
      throw new Error('injected finalize failure');
    },
  };
  assert.equal(
    consumeControlledHandoverRequest(
      consumeOptions,
      consumeLogger,
      startupLauncherSha256,
      Date.parse('2026-09-09T14:30:30.000Z'),
      88888,
      finalizeFailureOps,
    ),
    null,
  );
  assert.equal(fs.existsSync(consumePath), false);
  assert.equal(consumeEvents.at(-1)?.detail?.reason, 'REQUEST_FINALIZE_FAILED');
  pass('handover request finalize failure grants no authority after atomic claim');

  fs.appendFileSync(restartLauncher, 'echo drift\r\n', 'utf8');
  assert.throws(
    () => verifyStartupLauncherSha({ restartLauncher, launcherSha256: startupLauncherSha256 }),
    /does not match supplied startup SHA/,
  );
  pass('supervisor startup launcher SHA verification fails closed on drift');
  assert.equal(
    validateControlledHandoverRequest(
      request,
      { restartLauncher },
      Date.parse('2026-09-09T14:30:30.000Z'),
      88888,
      startupLauncherSha256,
    ).reason,
    'LAUNCHER_SHA_MISMATCH',
  );
  pass('controlled handover request fails closed when canonical launcher drifts after supervisor startup');
} finally {
  fs.rmSync(lockRoot, { recursive: true, force: true });
}

const startupIdentityRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpro-startup-identity-'));
try {
  const startupLauncher = path.join(startupIdentityRoot, 'launcher.cmd');
  fs.writeFileSync(startupLauncher, '@echo off\r\n', 'utf8');
  const suppliedSha = '0'.repeat(64);
  const startupLogDir = path.join(startupIdentityRoot, 'logs');
  const startupLockFile = path.join(startupLogDir, 'identity-test.lock');
  let startupError = null;
  try {
    await runSupervisor({
      ...parsed,
      name: 'identity-test',
      logDir: startupLogDir,
      restartLauncher: startupLauncher,
      launcherSha256: suppliedSha,
      tokenFile: path.join(startupIdentityRoot, 'missing-token'),
    });
  } catch (error) {
    startupError = error;
  }
  assert.equal(supervisorFailureExitCode(startupError), 42);
  assert.equal(fs.existsSync(startupLockFile), false);
  assert.equal(fs.existsSync(startupLogDir), false);
  pass('startup launcher identity mismatch fails before lock/token/child side effects with no-fallback exit classification');
} finally {
  fs.rmSync(startupIdentityRoot, { recursive: true, force: true });
}

assert.deepEqual(
  classifyNgrokRecovery({ childAlive: false, controlFailures: 0, failureThreshold: 3, publicResult: null }),
  { action: 'RESTART_NGROK', reason: 'TUNNEL_PROCESS_EXITED' },
);
pass('dead ngrok process recovers tunnel only');

assert.equal(
  classifyNgrokRecovery({ childAlive: true, controlFailures: 2, failureThreshold: 3, publicResult: { ok: false } }).action,
  'NONE',
);
pass('transient ngrok control failures do not recover');

assert.equal(
  classifyNgrokRecovery({ childAlive: true, controlFailures: 3, failureThreshold: 3, publicResult: null }).reason,
  'INSUFFICIENT_RECOVERY_EVIDENCE',
);
pass('missing corroboration fails closed');

assert.equal(
  classifyNgrokRecovery({ childAlive: true, controlFailures: 3, failureThreshold: 3, publicResult: { ok: true } }).reason,
  'PUBLIC_PATH_REACHABLE',
);
pass('healthy public path suppresses ngrok restart');

assert.deepEqual(
  classifyNgrokRecovery({ childAlive: true, controlFailures: 3, failureThreshold: 3, publicResult: { ok: false } }),
  { action: 'RESTART_NGROK', reason: 'MULTI_SIGNAL_TUNNEL_OUTAGE' },
);
pass('corroborated multi-signal outage recovers ngrok only');

const healthServer = createServer((request, response) => {
  if (request.headers.authorization === 'Bearer smoke-token') {
    response.statusCode = 200;
    response.end('OK');
    return;
  }
  response.statusCode = 401;
  response.end('Unauthorized');
});
healthServer.listen(0, '127.0.0.1');
await once(healthServer, 'listening');
const healthPort = healthServer.address().port;
const unauthHealth = await probe(`http://127.0.0.1:${healthPort}/healthz`, 2000);
assert.equal(unauthHealth.ok, true);
assert.equal(unauthHealth.status, 401);
pass('401 health response counts as reachable');
const authHealth = await probe(`http://127.0.0.1:${healthPort}/healthz`, 2000, 'smoke-token');
assert.equal(authHealth.ok, true);
assert.equal(authHealth.status, 200);
await new Promise((resolve) => healthServer.close(resolve));
pass('health probe sends bearer token when configured');

const apiServer = createServer((_, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ tunnels: [{ public_url: 'https://backup.ngrok-free.dev' }] }));
});
apiServer.listen(0, '127.0.0.1');
await once(apiServer, 'listening');
const apiPort = apiServer.address().port;
const control = await probeNgrokControl(`http://127.0.0.1:${apiPort}/api/tunnels`, 2000);
assert.equal(control.ok, true);
assert.equal(control.tunnelCount, 1);
await new Promise((resolve) => apiServer.close(resolve));
pass('ngrok local control requires at least one tunnel');

console.log(`✓ dual transport smoke passed (${checks.length} checks)`);
for (const check of checks) console.log(`  - ${check}`);
