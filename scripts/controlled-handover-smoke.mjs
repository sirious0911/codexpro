#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  CODEXPRO_CONTROLLED_HANDOVER_ACTION,
  CODEXPRO_CONTROLLED_HANDOVER_CONFIRM,
  buildControlledHandoverPlan,
  requestControlledHandover,
} from '../dist/controlledHandoverOps.js';
import { validateControlledHandoverRequest } from './dual-transport-supervisor.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpro-controlled-handover-'));
try {
  const logDir = path.join(root, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const launcherFile = path.join(root, 'launcher.cmd');
  const lockFile = path.join(logDir, 'dual.lock');
  const controlFile = path.join(logDir, 'dual.control.json');
  fs.writeFileSync(launcherFile, '@echo off\r\necho launcher\r\n', 'utf8');
  fs.writeFileSync(lockFile, '4242\n', 'utf8');
  const paths = { logDir, lockFile, controlFile, launcherFile };
  const expectedLauncherSha256 = createHash('sha256').update(fs.readFileSync(launcherFile)).digest('hex');

  const plan = buildControlledHandoverPlan(
    { confirm: CODEXPRO_CONTROLLED_HANDOVER_CONFIRM, dryRun: true },
    { platform: 'win32', paths, isPidAlive: (pid) => pid === 4242 }
  );
  assert.equal(plan.action, CODEXPRO_CONTROLLED_HANDOVER_ACTION);
  assert.equal(plan.expectedSupervisorPid, 4242);
  assert.equal(plan.expectedLauncherSha256, expectedLauncherSha256);
  assert.equal(fs.existsSync(controlFile), false);

  fs.appendFileSync(launcherFile, 'echo changed-after-plan\r\n', 'utf8');
  const requestLauncherSha256 = createHash('sha256').update(fs.readFileSync(launcherFile)).digest('hex');
  assert.notEqual(requestLauncherSha256, plan.expectedLauncherSha256);

  const result = requestControlledHandover(
    { confirm: CODEXPRO_CONTROLLED_HANDOVER_CONFIRM, dryRun: false },
    {
      platform: 'win32',
      paths,
      isPidAlive: (pid) => pid === 4242,
      now: new Date('2026-09-24T09:00:00.000Z'),
      requestId: () => 'request-v2-12345678',
    }
  );
  assert.equal(result.status, 'REQUESTED');
  assert.equal(result.expectedLauncherSha256, requestLauncherSha256);
  const payload = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
  assert.deepEqual(Object.keys(payload).sort(), [
    'action',
    'expectedLauncherSha256',
    'expectedSupervisorPid',
    'requestId',
    'requestedAt',
    'version',
  ]);
  assert.equal(payload.version, 2);
  assert.equal(payload.expectedSupervisorPid, 4242);
  assert.equal(payload.expectedLauncherSha256, requestLauncherSha256);
  assert.equal(
    validateControlledHandoverRequest(
      payload,
      { restartLauncher: launcherFile },
      Date.parse('2026-09-24T09:00:30.000Z'),
      4242,
      plan.expectedLauncherSha256,
    ).reason,
    'LAUNCHER_SHA_MISMATCH',
  );

  assert.throws(
    () => requestControlledHandover(
      { confirm: CODEXPRO_CONTROLLED_HANDOVER_CONFIRM, dryRun: false },
      { platform: 'win32', paths, isPidAlive: () => true }
    ),
    /already exists/
  );

  console.log('controlled-handover-smoke: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
