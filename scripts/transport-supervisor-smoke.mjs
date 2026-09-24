#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HealthState,
  acquireLock,
  extractPublicIpv4Answers,
  isSupervisorStopKey,
  parseArgs,
  restartBackoffMs,
} from './transport-supervisor.mjs';

const supervisorUrl = new URL('./transport-supervisor.mjs', import.meta.url);
const supervisorPath = path.normalize(supervisorUrl.pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)));
const supervisorBytes = fs.readFileSync(supervisorUrl);
const supervisorSha256 = crypto.createHash('sha256').update(supervisorBytes).digest('hex');
assert.equal(
  supervisorSha256,
  '56df9da25fea979c9836739a84303ebd130730ceffe4245df23a99921501e192',
  'transport supervisor must remain byte-identical to the approved operational reference',
);

const parsed = parseArgs([
  '--name', 'codexpro-personal-fallback',
  '--local-health', 'http://127.0.0.1:8787/healthz',
  '--public-health', 'https://example.invalid/healthz',
  '--ngrok-api', 'http://127.0.0.1:4040/api/tunnels',
  '--log-dir', 'C:\\Codex\\tools\\codexpro-supervisor\\logs',
  '--tunnel-log', 'C:\\Codex\\tools\\codexpro-supervisor\\logs\\ngrok.jsonl',
  '--cwd', 'C:\\Codex\\projects',
  '--interval-ms', '15000',
  '--failure-threshold', '4',
  '--restart-on-public-failure', 'off',
  '--probe-timeout-ms', '5000',
  '--healthy-reset-ms', '300000',
  '--restart-base-ms', '5000',
  '--restart-max-ms', '120000',
  '--max-rapid-restarts', '6',
  '--',
  process.execPath,
  'runtime.mjs',
  'ngrok',
  '--tool-mode',
  'full',
]);

assert.equal(parsed.name, 'codexpro-personal-fallback');
assert.equal(parsed.intervalMs, 15000);
assert.equal(parsed.failureThreshold, 4);
assert.equal(parsed.restartOnPublicFailure, false);
assert.equal(parsed.probeTimeoutMs, 5000);
assert.equal(parsed.healthyResetMs, 300000);
assert.equal(parsed.restartBaseMs, 5000);
assert.equal(parsed.restartMaxMs, 120000);
assert.equal(parsed.maxRapidRestarts, 6);
assert.deepEqual(parsed.child.slice(-3), ['ngrok', '--tool-mode', 'full']);

const defaultPolicy = parseArgs([
  '--local-health', 'http://127.0.0.1:8787/healthz',
  '--public-health', 'https://example.invalid/healthz',
  '--log-dir', os.tmpdir(),
  '--',
  process.execPath,
  'runtime.mjs',
]);
assert.equal(defaultPolicy.restartOnPublicFailure, false);

const publicState = new HealthState(4);
for (let index = 0; index < 3; index += 1) {
  assert.equal(publicState.observe({ ok: true }, { ok: false }).restartReason, '');
}
assert.equal(
  publicState.observe({ ok: true }, { ok: false }).restartReason,
  'PUBLIC_TUNNEL_OUTAGE',
);
assert.equal(publicState.observe({ ok: true }, { ok: true }).state, 'HEALTHY');

const localState = new HealthState(2);
localState.observe({ ok: false }, { ok: true });
assert.equal(
  localState.observe({ ok: false }, { ok: true }).restartReason,
  'LOCAL_RUNTIME_OUTAGE',
);

assert.equal(restartBackoffMs(1, 5000, 120000), 5000);
assert.equal(restartBackoffMs(6, 5000, 120000), 120000);
assert.equal(isSupervisorStopKey('q'), true);
assert.equal(isSupervisorStopKey('Q'), true);
assert.equal(isSupervisorStopKey('\u0003'), true);
assert.equal(isSupervisorStopKey('x'), false);

assert.deepEqual(
  extractPublicIpv4Answers({
    Answer: [
      { type: 1, data: '127.0.0.1' },
      { type: 1, data: '100.64.0.1' },
      { type: 1, data: '8.8.8.8' },
      { type: 28, data: '2001:db8::1' },
    ],
  }),
  ['8.8.8.8'],
);

const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpro-transport-supervisor-smoke-'));
try {
  const lockFile = path.join(lockRoot, 'transport.lock');
  const release = acquireLock(lockFile);
  assert.equal(fs.existsSync(lockFile), true);
  release();
  assert.equal(fs.existsSync(lockFile), false);
} finally {
  fs.rmSync(lockRoot, { recursive: true, force: true });
}

const source = supervisorBytes.toString('utf8');
assert.match(
  source,
  /observation\.restartReason === 'PUBLIC_TUNNEL_OUTAGE' && options\.restartOnPublicFailure !== true/,
);
assert.match(source, /public_restart_suppressed/);
assert.match(source, /restartOnPublicFailure: false/);

console.log(`transport-supervisor-smoke: PASS (${supervisorSha256.slice(0, 12)}..., ${supervisorPath})`);
