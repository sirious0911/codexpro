#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildPromotionMarker,
  consumePromotionMarker,
  launcherSha256,
  validatePromotionMarker,
} from './launcher-lifecycle.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpro-launcher-lifecycle-'));
try {
  const launcherFile = path.join(root, 'launcher.cmd');
  const markerFile = path.join(root, 'promote-to-dual.request');
  fs.writeFileSync(launcherFile, '@echo off\r\necho full full\r\n', 'utf8');
  const expectedLauncherSha256 = launcherSha256(launcherFile);
  const lifecycleScript = fileURLToPath(new URL('./launcher-lifecycle.mjs', import.meta.url));
  const shaCli = spawnSync(process.execPath, [lifecycleScript, 'launcher-sha256', '--launcher', launcherFile], {
    encoding: 'utf8',
  });
  assert.equal(shaCli.status, 0);
  assert.equal(shaCli.stdout.trim(), expectedLauncherSha256);
  const validateShaCli = spawnSync(process.execPath, [lifecycleScript, 'validate-sha256', '--value', expectedLauncherSha256], { encoding: 'utf8' });
  assert.equal(validateShaCli.status, 0);
  const invalidShaCli = spawnSync(process.execPath, [lifecycleScript, 'validate-sha256', '--value', 'ABC'], { encoding: 'utf8' });
  assert.notEqual(invalidShaCli.status, 0);

  const requestedAt = '2026-09-24T09:00:00.000Z';
  const nowMs = Date.parse('2026-09-24T09:00:30.000Z');
  const marker = buildPromotionMarker({
    launcherFile,
    requestId: 'promotion-12345678',
    requestedAt,
  });

  assert.equal(validatePromotionMarker(marker, { launcherFile, nowMs }).ok, true);
  fs.writeFileSync(markerFile, JSON.stringify(marker), 'utf8');
  const first = consumePromotionMarker({ markerFile, launcherFile, nowMs });
  assert.equal(first.promote, true);
  assert.equal(fs.existsSync(markerFile), false);
  const second = consumePromotionMarker({ markerFile, launcherFile, nowMs });
  assert.equal(second.promote, false);
  assert.equal(second.status, 'MISSING');

  fs.writeFileSync(markerFile, JSON.stringify({
    ...marker,
    requestedAt: '2026-09-24T08:00:00.000Z',
  }), 'utf8');
  const stale = consumePromotionMarker({ markerFile, launcherFile, nowMs });
  assert.equal(stale.promote, false);
  assert.equal(stale.reason, 'STALE_MARKER');
  assert.equal(fs.existsSync(markerFile), false);

  fs.writeFileSync(markerFile, '{not-json', 'utf8');
  const malformed = consumePromotionMarker({ markerFile, launcherFile, nowMs });
  assert.equal(malformed.promote, false);
  assert.equal(malformed.reason, 'INVALID_JSON');
  assert.equal(fs.existsSync(markerFile), false);

  const finalizeMarker = buildPromotionMarker({
    launcherFile,
    requestId: 'promotion-finalize-failure',
    requestedAt,
  });
  fs.writeFileSync(markerFile, JSON.stringify(finalizeMarker), 'utf8');
  const finalizeFailure = consumePromotionMarker({
    markerFile,
    launcherFile,
    nowMs,
    fileOps: {
      existsSync: fs.existsSync,
      renameSync: fs.renameSync,
      readFileSync: fs.readFileSync,
      rmSync() { throw new Error('injected marker finalize failure'); },
    },
  });
  assert.equal(finalizeFailure.promote, false);
  assert.equal(finalizeFailure.reason, 'MARKER_FINALIZE_FAILED');
  assert.equal(fs.existsSync(markerFile), false);
  assert.ok(fs.readdirSync(root).some((name) => name.startsWith('promote-to-dual.request.claim-')));

  const hashMarker = buildPromotionMarker({
    launcherFile,
    requestId: 'promotion-87654321',
    requestedAt,
  });
  fs.writeFileSync(markerFile, JSON.stringify(hashMarker), 'utf8');
  fs.appendFileSync(launcherFile, 'echo drift\r\n', 'utf8');
  const mismatch = consumePromotionMarker({ markerFile, launcherFile, nowMs });
  assert.equal(mismatch.promote, false);
  assert.equal(mismatch.reason, 'LAUNCHER_SHA_MISMATCH');
  assert.equal(fs.existsSync(markerFile), false);

  const launcherTemplate = fs.readFileSync(new URL('./codexpro-personal-dual-launcher.cmd', import.meta.url), 'utf8');
  assert.match(launcherTemplate, /CODEXPRO_LOCAL_CAPABILITIES=full/);
  assert.equal((launcherTemplate.match(/--tool-mode full/g) || []).length, 2);
  assert.match(launcherTemplate, /launcher-sha256 --launcher \"%~f0\"/);
  assert.match(launcherTemplate, /validate-sha256 --value \"%LAUNCHER_SHA256%\"/);
  assert.match(launcherTemplate, /--restart-launcher \"%~f0\"/);
  assert.match(launcherTemplate, /--launcher-sha256 \"%LAUNCHER_SHA256%\"/);
  assert.match(launcherTemplate, /if \"%EXIT_CODE%\"==\"0\" goto stopped/);
  assert.match(launcherTemplate, /if \"%EXIT_CODE%\"==\"42\" goto fail_startup_identity/);
  assert.match(launcherTemplate, /DUAL_SUPERVISOR_STARTUP_IDENTITY_REJECT code=%EXIT_CODE% action=NO_FALLBACK/);
  assert.match(
    launcherTemplate,
    /SUPERVISOR=%TOOLS_ROOT%\\codexpro-official-patch\\package\\scripts\\transport-supervisor\.mjs/,
  );
  assert.match(
    launcherTemplate,
    /DUAL_SUPERVISOR=%TOOLS_ROOT%\\codexpro-official-patch\\package\\scripts\\dual-transport-supervisor\.mjs/,
  );
  assert.match(
    launcherTemplate,
    /LAUNCHER_LIFECYCLE=%TOOLS_ROOT%\\codexpro-official-patch\\package\\scripts\\launcher-lifecycle\.mjs/,
  );
  assert.doesNotMatch(launcherTemplate, /codexpro-source\\scripts/i);
  assert.match(launcherTemplate, /node \"%LAUNCHER_LIFECYCLE%\" consume-promotion/);
  assert.doesNotMatch(launcherTemplate, /if exist .*promote-to-dual\.request/i);
  assert.doesNotMatch(launcherTemplate, /del \/q .*promote-to-dual\.request/i);

  console.log('launcher-lifecycle-smoke: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
