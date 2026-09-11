#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CODEXPRO_CONTROLLED_HANDOVER_ACTION,
  buildControlledHandoverPlan,
  requestControlledHandover,
} from '../dist/controlledHandoverOps.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpro-controlled-handover-'));
const paths = {
  logDir: root,
  lockFile: path.join(root, 'codexpro-personal-dual.lock'),
  controlFile: path.join(root, 'codexpro-personal-dual.control.json'),
  launcherFile: path.join(root, 'CodexPro-launcher.bat'),
};

try {
  fs.writeFileSync(paths.lockFile, '1234\n', 'utf8');
  fs.writeFileSync(paths.launcherFile, '@echo off\r\nexit /b 0\r\n', 'utf8');

  const baseContext = {
    platform: 'win32',
    paths,
    isPidAlive: (pid) => pid === 1234,
    now: new Date('2026-09-09T14:30:00.000Z'),
    requestId: () => '11111111-2222-4333-8444-555555555555',
  };

  const dry = buildControlledHandoverPlan(
    { confirm: 'CODEXPRO_CONTROLLED_HANDOVER' },
    baseContext,
  );
  assert.equal(dry.action, CODEXPRO_CONTROLLED_HANDOVER_ACTION);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.expectedSupervisorPid, 1234);
  assert.equal(fs.existsSync(paths.controlFile), false);

  assert.throws(
    () => buildControlledHandoverPlan({ confirm: 'WRONG' }, baseContext),
    /Exact confirmation required/,
  );
  assert.throws(
    () => buildControlledHandoverPlan(
      { confirm: 'CODEXPRO_CONTROLLED_HANDOVER' },
      { ...baseContext, platform: 'linux' },
    ),
    /only available on win32/,
  );
  assert.throws(
    () => buildControlledHandoverPlan(
      { confirm: 'CODEXPRO_CONTROLLED_HANDOVER' },
      { ...baseContext, isPidAlive: () => false },
    ),
    /lock owner is not alive/,
  );

  const requested = requestControlledHandover(
    { confirm: 'CODEXPRO_CONTROLLED_HANDOVER', dryRun: false },
    baseContext,
  );
  assert.equal(requested.status, 'REQUESTED');
  assert.equal(requested.requestId, '11111111-2222-4333-8444-555555555555');
  assert.equal(fs.existsSync(paths.controlFile), true);

  const payload = JSON.parse(fs.readFileSync(paths.controlFile, 'utf8'));
  assert.deepEqual(Object.keys(payload).sort(), [
    'action',
    'expectedSupervisorPid',
    'requestId',
    'requestedAt',
    'version',
  ]);
  assert.equal(payload.version, 1);
  assert.equal(payload.action, CODEXPRO_CONTROLLED_HANDOVER_ACTION);
  assert.equal(payload.expectedSupervisorPid, 1234);
  assert.equal(payload.requestedAt, '2026-09-09T14:30:00.000Z');
  assert.equal('launcher' in payload, false);
  assert.equal('command' in payload, false);

  assert.throws(
    () => requestControlledHandover(
      { confirm: 'CODEXPRO_CONTROLLED_HANDOVER', dryRun: false },
      baseContext,
    ),
    /request already exists/,
  );

  console.log('controlled handover smoke: PASS (16 checks)');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
