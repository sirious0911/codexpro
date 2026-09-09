import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARTIFACTS,
  PRODUCTION_ROOTS,
  executeDeployment,
  preflight,
} from "./wp1-live-artifact-operator.mjs";

const scriptPath = fileURLToPath(new URL("./wp1-live-artifact-operator.mjs", import.meta.url));
const artifactNames = ARTIFACTS.map((value) => value.slice("dist/".length));
let checks = 0;

function check(value, message) {
  assert.ok(value, message);
  checks += 1;
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function fixture({ absentLive = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wp1-live-artifact-"));
  const roots = {
    candidate: path.join(root, "candidate"),
    live: path.join(root, "live"),
    backupBase: path.join(root, "backup"),
  };
  await mkdir(roots.candidate);
  await mkdir(roots.live);
  const candidateBytes = [];
  const liveBytes = [];
  for (let index = 0; index < artifactNames.length; index += 1) {
    const candidate = Buffer.from(`candidate-${index}-PRIVATE-CONTENT\n`);
    const live = Buffer.from(`live-${index}-PRIVATE-CONTENT\n`);
    candidateBytes.push(candidate);
    liveBytes.push(live);
    await writeFile(path.join(roots.candidate, artifactNames[index]), candidate);
    if (!absentLive.includes(index)) {
      await writeFile(path.join(roots.live, artifactNames[index]), live);
    }
  }
  return { root, roots, candidateBytes, liveBytes, absentLive };
}

async function removeFixture(value) {
  await rm(value.root, { recursive: true, force: true });
}

async function snapshotLive(value) {
  const result = [];
  for (let index = 0; index < artifactNames.length; index += 1) {
    const target = path.join(value.roots.live, artifactNames[index]);
    result.push(await exists(target) ? await readFile(target) : null);
  }
  return result;
}

async function assertSnapshot(value, expected) {
  const current = await snapshotLive(value);
  assert.equal(current.length, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] === null) {
      assert.equal(current[index], null, `${ARTIFACTS[index]} must remain absent`);
    } else {
      assert.deepEqual(current[index], expected[index], `${ARTIFACTS[index]} must match pre-state`);
    }
    checks += 1;
  }
}

async function approvals(value) {
  const result = await preflight({ roots: value.roots });
  assert.equal(result.ready, true);
  return {
    expectedCandidateManifestSha: result.candidate_manifest_sha256,
    expectedLiveManifestSha: result.live_manifest_sha256,
  };
}

async function testPreflightMetadataOnly() {
  const value = await fixture();
  try {
    const beforeBackup = await exists(value.roots.backupBase);
    const result = await preflight({ roots: value.roots });
    const serialized = JSON.stringify(result);
    check(result.ready && result.reason === "PREFLIGHT_READY", "preflight must be ready");
    check(result.candidate_files.length === 4 && result.live_files.length === 4, "preflight must report exact4");
    check(result.candidate_files.every((item) => item.exists && item.size > 0 && /^[0-9a-f]{64}$/.test(item.sha256)), "candidate metadata must be bounded");
    check(!serialized.includes("PRIVATE-CONTENT"), "preflight must not expose contents");
    check(beforeBackup === false && await exists(value.roots.backupBase) === false, "preflight must write nothing");
  } finally {
    await removeFixture(value);
  }
}

async function testApprovalMismatchWriteZero() {
  for (const mismatch of ["candidate", "live"]) {
    const value = await fixture();
    try {
      const before = await snapshotLive(value);
      const approved = await approvals(value);
      if (mismatch === "candidate") approved.expectedCandidateManifestSha = "0".repeat(64);
      if (mismatch === "live") approved.expectedLiveManifestSha = "f".repeat(64);
      const result = await executeDeployment({ roots: value.roots, ...approved });
      check(result.ready === false && result.reason === `${mismatch.toUpperCase()}_MANIFEST_MISMATCH`, `${mismatch} mismatch must block`);
      await assertSnapshot(value, before);
      check(await exists(value.roots.backupBase) === false, `${mismatch} mismatch must be write0`);
    } finally {
      await removeFixture(value);
    }
  }
}

async function testMissingCandidate() {
  const value = await fixture();
  try {
    await rm(path.join(value.roots.candidate, artifactNames[2]));
    const result = await preflight({ roots: value.roots });
    check(result.ready === false && result.reason === "CANDIDATE_ARTIFACT_MISSING", "missing candidate must block");
    check(await exists(value.roots.backupBase) === false, "missing candidate must be write0");
  } finally {
    await removeFixture(value);
  }
}

async function testSymlinkAndJunctionBlocked() {
  const rootLink = await fixture();
  try {
    const linkedCandidate = path.join(rootLink.root, "candidate-link");
    await symlink(rootLink.roots.candidate, linkedCandidate, process.platform === "win32" ? "junction" : "dir");
    const result = await preflight({ roots: { ...rootLink.roots, candidate: linkedCandidate } });
    check(result.ready === false && result.reason === "ROOT_NOT_REGULAR_DIRECTORY", "candidate root junction must block");
  } finally {
    await removeFixture(rootLink);
  }

  const artifactLink = await fixture();
  try {
    const target = path.join(artifactLink.roots.candidate, artifactNames[0]);
    const linkedDirectory = path.join(artifactLink.root, "linked-directory");
    await rm(target);
    await mkdir(linkedDirectory);
    await symlink(linkedDirectory, target, process.platform === "win32" ? "junction" : "dir");
    const result = await preflight({ roots: artifactLink.roots });
    check(result.ready === false && result.reason === "ARTIFACT_NOT_REGULAR_FILE", "artifact junction must block");
  } finally {
    await removeFixture(artifactLink);
  }
}

async function testSuccessfulOrderAndAllowlist() {
  const value = await fixture();
  try {
    const unrelated = path.join(value.roots.live, "unrelated.js");
    await writeFile(unrelated, "leave-me-alone\n");
    const events = [];
    const result = await executeDeployment({
      roots: value.roots,
      ...await approvals(value),
      hooks: { afterReplace: ({ artifact }) => events.push(artifact) },
    });
    check(result.ready && result.reason === "DEPLOYMENT_COMPLETE", "deployment fixture must pass");
    check(JSON.stringify(events) === JSON.stringify(ARTIFACTS), "replacement order must equal fixed allowlist");
    check(events.at(-1) === "dist/server.js", "server.js must activate last");
    check((await readFile(unrelated, "utf8")) === "leave-me-alone\n", "non-allowlisted file must remain untouched");
    check(!JSON.stringify(result).includes("PRIVATE-CONTENT"), "execute output must not expose contents");
    for (let index = 0; index < artifactNames.length; index += 1) {
      assert.deepEqual(await readFile(path.join(value.roots.live, artifactNames[index])), value.candidateBytes[index]);
      checks += 1;
    }
    check(result.live_manifest_after_sha256 === result.candidate_manifest_sha256, "final live manifest must equal candidate");
  } finally {
    await removeFixture(value);
  }
}

async function testMidDeployRollbackIncludingAbsent() {
  const value = await fixture({ absentLive: [1] });
  try {
    const before = await snapshotLive(value);
    const result = await executeDeployment({
      roots: value.roots,
      ...await approvals(value),
      hooks: {
        afterReplace: ({ index }) => {
          if (index === 1) throw new Error("injected failure");
        },
      },
    });
    check(result.ready === false && result.reason === "INTERNAL_ERROR", "injected failure must block");
    check(result.rollback_attempted && result.rollback_status === "ROLLED_BACK", "mid-deploy failure must rollback");
    await assertSnapshot(value, before);
  } finally {
    await removeFixture(value);
  }
}

async function testPostManifestMismatchRollback() {
  const value = await fixture();
  try {
    const before = await snapshotLive(value);
    const result = await executeDeployment({
      roots: value.roots,
      ...await approvals(value),
      hooks: {
        beforeFinalManifest: () => writeFile(path.join(value.roots.live, artifactNames[0]), "tampered\n"),
      },
    });
    check(result.ready === false && result.reason === "POST_DEPLOY_MANIFEST_MISMATCH", "post-write mismatch must block");
    check(result.rollback_attempted && result.rollback_status === "ROLLED_BACK", "post-write mismatch must rollback");
    await assertSnapshot(value, before);
  } finally {
    await removeFixture(value);
  }
}

async function testCliAndStaticBoundaries() {
  const child = spawnSync(process.execPath, [scriptPath, "--preflight", "--candidate-root", "C:\\other"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const output = JSON.parse(child.stdout.trim());
  check(child.status === 1 && output.reason === "INVALID_ARGUMENTS", "CLI must reject arbitrary roots");
  const source = await readFile(scriptPath, "utf8");
  check(!/node:(?:child_process|net|http|https)|\b(?:spawn|execFile|execSync)\s*\(/.test(source), "operator must not invoke process or network surfaces");
  check(source.includes(PRODUCTION_ROOTS.candidate) && source.includes(PRODUCTION_ROOTS.live), "production roots must be fixed in source");
  check(ARTIFACTS.length === 4 && ARTIFACTS.at(-1) === "dist/server.js", "allowlist must be exact4 with server last");
}

await testPreflightMetadataOnly();
await testApprovalMismatchWriteZero();
await testMissingCandidate();
await testSymlinkAndJunctionBlocked();
await testSuccessfulOrderAndAllowlist();
await testMidDeployRollbackIncludingAbsent();
await testPostManifestMismatchRollback();
await testCliAndStaticBoundaries();

console.log(`wp1 live artifact operator smoke: PASS (${checks} checks)`);
