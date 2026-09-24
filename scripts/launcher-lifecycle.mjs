#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PROMOTION_ACTION = 'CODEXPRO_PROMOTE_TO_DUAL';
export const PROMOTION_VERSION = 1;
export const PROMOTION_MAX_AGE_MS = 120000;

function assertRegularFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${filePath}`);
}

export function launcherSha256(filePath) {
  assertRegularFile(filePath, 'Canonical launcher');
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function buildPromotionMarker({
  launcherFile,
  requestId = randomUUID(),
  requestedAt = new Date().toISOString(),
} = {}) {
  if (!launcherFile) throw new Error('launcherFile is required');
  return {
    version: PROMOTION_VERSION,
    action: PROMOTION_ACTION,
    requestId,
    requestedAt,
    expectedLauncherSha256: launcherSha256(launcherFile),
  };
}

export function validatePromotionMarker(raw, {
  launcherFile,
  nowMs = Date.now(),
  maxAgeMs = PROMOTION_MAX_AGE_MS,
} = {}) {
  let marker;
  try {
    marker = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, reason: 'INVALID_JSON' };
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return { ok: false, reason: 'INVALID_SCHEMA' };
  const keys = Object.keys(marker).sort();
  const expectedKeys = ['action', 'expectedLauncherSha256', 'requestId', 'requestedAt', 'version'];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) return { ok: false, reason: 'INVALID_SCHEMA' };
  if (marker.version !== PROMOTION_VERSION || marker.action !== PROMOTION_ACTION) return { ok: false, reason: 'INVALID_ACTION' };
  if (typeof marker.requestId !== 'string' || marker.requestId.length < 8 || marker.requestId.length > 128) {
    return { ok: false, reason: 'INVALID_REQUEST_ID' };
  }
  if (!/^[a-f0-9]{64}$/.test(String(marker.expectedLauncherSha256 || ''))) {
    return { ok: false, reason: 'INVALID_LAUNCHER_SHA' };
  }
  const requestedAtMs = Date.parse(marker.requestedAt);
  if (!Number.isFinite(requestedAtMs)) return { ok: false, reason: 'INVALID_REQUEST_TIME' };
  const ageMs = nowMs - requestedAtMs;
  if (ageMs < -10000 || ageMs > maxAgeMs) return { ok: false, reason: 'STALE_MARKER' };
  if (!launcherFile || !fs.existsSync(launcherFile)) return { ok: false, reason: 'LAUNCHER_UNAVAILABLE' };
  let currentLauncherSha256;
  try {
    currentLauncherSha256 = launcherSha256(launcherFile);
  } catch {
    return { ok: false, reason: 'LAUNCHER_UNAVAILABLE' };
  }
  if (currentLauncherSha256 !== marker.expectedLauncherSha256) return { ok: false, reason: 'LAUNCHER_SHA_MISMATCH' };
  return { ok: true, marker };
}

export function consumePromotionMarker({
  markerFile,
  launcherFile,
  nowMs = Date.now(),
  maxAgeMs = PROMOTION_MAX_AGE_MS,
  fileOps = fs,
} = {}) {
  if (!markerFile) throw new Error('markerFile is required');
  if (!fileOps.existsSync(markerFile)) return { promote: false, status: 'MISSING', reason: 'MARKER_MISSING' };

  const claimFile = `${markerFile}.claim-${process.pid}`;
  try {
    fileOps.renameSync(markerFile, claimFile);
  } catch {
    return { promote: false, status: 'REJECTED', reason: 'MARKER_CLAIM_FAILED' };
  }

  let raw;
  try {
    raw = fileOps.readFileSync(claimFile, 'utf8');
  } catch {
    try { fileOps.rmSync(claimFile, { force: true }); } catch {}
    return { promote: false, status: 'REJECTED', reason: 'MARKER_READ_FAILED' };
  }

  const validated = validatePromotionMarker(raw, { launcherFile, nowMs, maxAgeMs });
  if (!validated.ok) {
    try { fileOps.rmSync(claimFile, { force: true }); } catch {}
    return { promote: false, status: 'REJECTED', reason: validated.reason };
  }

  try {
    fileOps.rmSync(claimFile, { force: true });
  } catch {
    return { promote: false, status: 'REJECTED', reason: 'MARKER_FINALIZE_FAILED' };
  }

  return {
    promote: true,
    status: 'PROMOTE',
    reason: 'VALID_MARKER_CONSUMED',
    requestId: validated.marker.requestId,
  };
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  const out = { command, markerFile: '', launcherFile: '', value: '' };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!value) throw new Error(`Missing value for ${key}`);
    if (key === '--marker') out.markerFile = value;
    else if (key === '--launcher') out.launcherFile = value;
    else if (key === '--value') out.value = value;
    else throw new Error(`Unknown argument: ${key}`);
  }
  return out;
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const cli = parseCli(process.argv.slice(2));
    if (cli.command === 'launcher-sha256') {
      if (!cli.launcherFile) throw new Error('--launcher is required');
      process.stdout.write(`${launcherSha256(cli.launcherFile)}\n`);
    } else if (cli.command === 'validate-sha256') {
      if (!/^[a-f0-9]{64}$/.test(cli.value)) throw new Error('SHA-256 must be exactly 64 lowercase hex characters');
      process.stdout.write(`${cli.value}\n`);
    } else if (cli.command === 'consume-promotion') {
      const result = consumePromotionMarker({ markerFile: cli.markerFile, launcherFile: cli.launcherFile });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.promote ? 0 : 10;
    } else {
      throw new Error('Expected command: launcher-sha256, validate-sha256, or consume-promotion');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 11;
  }
}
