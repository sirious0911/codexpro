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
  classifyNgrokRecovery,
  isDualSupervisorStopKey,
  parseArgs,
  PREFERRED_TRANSPORT,
  prepareHandoverLock,
  probe,
  probeNgrokControl,
  selectActiveTransport,
  tailscaleFunnelMatches,
  validateControlledHandoverRequest,
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
  '--ngrok-control-interval-ms', '30000',
  '--ngrok-public-interval-ms', '300000',
  '--', 'node', 'runtime.js',
]);
assert.equal(parsed.ngrokControlIntervalMs, 30000);
assert.equal(parsed.ngrokPublicIntervalMs, 300000);
assert.deepEqual(parsed.child, ['node', 'runtime.js']);
pass('exact runtime and transport intervals parsed');

assert.equal(PREFERRED_TRANSPORT, 'TAILSCALE');
const startupPrimary = selectActiveTransport({
  tailscaleHealthy: true,
  ngrokHealthy: true,
  previousActiveTransport: 'NONE',
});
assert.equal(startupPrimary.activeTransport, 'TAILSCALE');
assert.equal(startupPrimary.reason, 'PRIMARY_AVAILABLE');

const primaryDown = selectActiveTransport({
  tailscaleHealthy: false,
  ngrokHealthy: true,
  previousActiveTransport: 'TAILSCALE',
});
assert.equal(primaryDown.activeTransport, 'NGROK');
assert.equal(primaryDown.reason, 'PRIMARY_UNAVAILABLE');

const primaryRecovered = selectActiveTransport({
  tailscaleHealthy: true,
  ngrokHealthy: true,
  previousActiveTransport: 'NGROK',
});
assert.equal(primaryRecovered.activeTransport, 'TAILSCALE');
assert.equal(primaryRecovered.reason, 'PRIMARY_RECOVERED');

const primaryOnly = selectActiveTransport({
  tailscaleHealthy: true,
  ngrokHealthy: false,
  previousActiveTransport: 'NONE',
});
assert.equal(primaryOnly.activeTransport, 'TAILSCALE');

const bothDown = selectActiveTransport({
  tailscaleHealthy: false,
  ngrokHealthy: false,
  previousActiveTransport: 'NGROK',
});
assert.equal(bothDown.activeTransport, 'NONE');
assert.equal(bothDown.reason, 'BOTH_UNAVAILABLE');

for (const decision of [startupPrimary, primaryDown, primaryRecovered, primaryOnly, bothDown]) {
  assert.ok(['TAILSCALE', 'NGROK', 'NONE'].includes(decision.activeTransport));
  assert.equal(Object.hasOwn(decision, 'runtimeRestartCount'), false);
  assert.equal(Object.hasOwn(decision, 'retryCount'), false);
  assert.equal(Object.hasOwn(decision, 'approval'), false);
}
pass('transport selection is single-valued and does not create runtime restart, retry, or approval authority');
assert.equal(isDualSupervisorStopKey('q'), true);
assert.equal(isDualSupervisorStopKey('Q\r\n'), true);
assert.equal(isDualSupervisorStopKey('\u0003'), true);
assert.equal(isDualSupervisorStopKey('x'), false);
pass('dual supervisor accepts q and Ctrl+C stop keys');

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
  const request = {
    version: 1,
    action: 'CODEXPRO_CONTROLLED_HANDOVER',
    requestId: 'request-12345678',
    requestedAt: '2026-09-09T14:30:00.000Z',
    expectedSupervisorPid: 88888,
  };
  const validRequest = validateControlledHandoverRequest(
    request,
    { restartLauncher },
    Date.parse('2026-09-09T14:30:30.000Z'),
    88888,
  );
  assert.equal(validRequest.ok, true);
  pass('fresh controlled handover request with exact supervisor pid is accepted');
  assert.equal(
    validateControlledHandoverRequest(
      { ...request, expectedSupervisorPid: 77777 },
      { restartLauncher },
      Date.parse('2026-09-09T14:30:30.000Z'),
      88888,
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
    ).reason,
    'STALE_REQUEST',
  );
  pass('controlled handover request fails closed when stale');
} finally {
  fs.rmSync(lockRoot, { recursive: true, force: true });
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
