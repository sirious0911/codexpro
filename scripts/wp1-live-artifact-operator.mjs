import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ARTIFACTS = Object.freeze([
  "dist/wp1ReadonlyPreflightOps.js",
  "dist/wp1ReadonlyPreflightOps.js.map",
  "dist/server.js.map",
  "dist/server.js",
]);

export const PRODUCTION_ROOTS = Object.freeze({
  candidate: String.raw`C:\Codex\tools\codexpro-wp1-integration-exact13\dist`,
  live: String.raw`C:\Codex\tools\codexpro-official-patch\package\dist`,
  backupBase: String.raw`C:\Codex\tools\codexpro-wp1-live-backup`,
});

const HEX64 = /^[0-9a-f]{64}$/i;
const ARTIFACT_NAMES = ARTIFACTS.map((value) => value.slice("dist/".length));

class OperatorError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "OperatorError";
    this.reason = reason;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalized(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function artifactPath(root, index) {
  const target = path.resolve(root, ARTIFACT_NAMES[index]);
  if (path.dirname(target) !== path.resolve(root)) {
    throw new OperatorError("PATH_RESOLUTION_BLOCKED");
  }
  return target;
}

async function safeRoot(root, { create = false } = {}) {
  const resolved = path.resolve(root);
  if (create) {
    let ancestor = path.dirname(resolved);
    while (true) {
      try {
        const ancestorInfo = await lstat(ancestor);
        if (!ancestorInfo.isDirectory() || ancestorInfo.isSymbolicLink()) {
          throw new OperatorError("ROOT_PARENT_BLOCKED");
        }
        const ancestorActual = await realpath(ancestor);
        if (normalized(ancestorActual) !== normalized(ancestor)) {
          throw new OperatorError("ROOT_PARENT_PATH_MISMATCH");
        }
        break;
      } catch (error) {
        if (error instanceof OperatorError) throw error;
        if (error?.code !== "ENOENT") throw new OperatorError("ROOT_PARENT_READ_FAILED");
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw new OperatorError("ROOT_PARENT_MISSING");
        ancestor = parent;
      }
    }
    await mkdir(resolved, { recursive: true });
  }
  let info;
  try {
    info = await lstat(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") throw new OperatorError("ROOT_MISSING");
    throw new OperatorError("ROOT_READ_FAILED");
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new OperatorError("ROOT_NOT_REGULAR_DIRECTORY");
  }
  let actual;
  try {
    actual = await realpath(resolved);
  } catch {
    throw new OperatorError("ROOT_REALPATH_FAILED");
  }
  if (normalized(actual) !== normalized(resolved)) {
    throw new OperatorError("ROOT_PATH_MISMATCH");
  }
  return resolved;
}

async function inspectFile(root, index, { required }) {
  const target = artifactPath(root, index);
  let before;
  try {
    before = await lstat(target, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT" && !required) {
      return { path: ARTIFACTS[index], exists: false, size: null, sha256: null };
    }
    if (error?.code === "ENOENT") throw new OperatorError("CANDIDATE_ARTIFACT_MISSING");
    throw new OperatorError("ARTIFACT_READ_FAILED");
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new OperatorError("ARTIFACT_NOT_REGULAR_FILE");
  }
  let actual;
  try {
    actual = await realpath(target);
  } catch {
    throw new OperatorError("ARTIFACT_REALPATH_FAILED");
  }
  if (normalized(actual) !== normalized(target)) {
    throw new OperatorError("ARTIFACT_PATH_MISMATCH");
  }
  let bytes;
  let after;
  try {
    bytes = await readFile(target);
    after = await lstat(target, { bigint: true });
  } catch {
    throw new OperatorError("ARTIFACT_READ_FAILED");
  }
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    BigInt(bytes.length) !== after.size
  ) {
    throw new OperatorError("ARTIFACT_CHANGED_DURING_READ");
  }
  return {
    path: ARTIFACTS[index],
    exists: true,
    size: Number(after.size),
    sha256: sha256(bytes),
  };
}

function manifestSha(files) {
  const canonical = files.map(({ path: filePath, exists, size, sha256: digest }) => ({
    path: filePath,
    exists,
    size,
    sha256: digest,
  }));
  return sha256(JSON.stringify(canonical));
}

async function inspectManifest(root, { required }) {
  const safe = await safeRoot(root);
  const files = [];
  for (let index = 0; index < ARTIFACTS.length; index += 1) {
    files.push(await inspectFile(safe, index, { required }));
  }
  return { files, manifest_sha256: manifestSha(files) };
}

function publicError(error) {
  return error instanceof OperatorError ? error.reason : "INTERNAL_ERROR";
}

function resultBase(mode) {
  return {
    mode,
    ready: false,
    reason: "NOT_RUN",
    allowlist: [...ARTIFACTS],
  };
}

export async function preflight(options = {}) {
  const roots = options.roots ?? PRODUCTION_ROOTS;
  const result = resultBase("preflight");
  try {
    const candidate = await inspectManifest(roots.candidate, { required: true });
    const live = await inspectManifest(roots.live, { required: false });
    return {
      ...result,
      ready: true,
      reason: "PREFLIGHT_READY",
      candidate_files: candidate.files,
      live_files: live.files,
      candidate_manifest_sha256: candidate.manifest_sha256,
      live_manifest_sha256: live.manifest_sha256,
    };
  } catch (error) {
    return { ...result, reason: publicError(error) };
  }
}

function sameFileState(left, right) {
  return (
    left.path === right.path &&
    left.exists === right.exists &&
    left.size === right.size &&
    left.sha256 === right.sha256
  );
}

async function assertFileState(root, index, expected, { required }) {
  const current = await inspectFile(root, index, { required });
  if (!sameFileState(current, expected)) {
    throw new OperatorError("LIVE_STATE_RACE");
  }
  return current;
}

async function readVerifiedCandidate(root, index, expected) {
  await assertFileState(root, index, expected, { required: true });
  const bytes = await readFile(artifactPath(root, index));
  if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) {
    throw new OperatorError("CANDIDATE_STATE_RACE");
  }
  return bytes;
}

async function writeTempAndRename(target, bytes, expectedSha, suffix) {
  const temp = `${target}.wp1-${suffix}.tmp`;
  let handle;
  try {
    handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const written = await readFile(temp);
    if (written.length !== bytes.length || sha256(written) !== expectedSha) {
      throw new OperatorError("TEMP_VERIFY_FAILED");
    }
    await rename(temp, target);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
    if (error instanceof OperatorError) throw error;
    throw new OperatorError("ATOMIC_REPLACE_FAILED");
  }
}

async function createBackup(roots, liveManifest) {
  const base = await safeRoot(roots.backupBase, { create: true });
  const backupId = `wp1-${Date.now()}-${randomUUID()}`;
  const backupPath = path.resolve(base, backupId);
  if (path.dirname(backupPath) !== base) throw new OperatorError("BACKUP_PATH_BLOCKED");
  await mkdir(backupPath, { recursive: false });
  await safeRoot(backupPath);
  const records = [];
  for (let index = 0; index < ARTIFACTS.length; index += 1) {
    const expected = liveManifest.files[index];
    if (!expected.exists) {
      records.push({ ...expected, backup: null });
      continue;
    }
    await assertFileState(roots.live, index, expected, { required: false });
    const destination = path.join(backupPath, ARTIFACT_NAMES[index]);
    await copyFile(artifactPath(roots.live, index), destination, constants.COPYFILE_EXCL);
    const copied = await readFile(destination);
    if (copied.length !== expected.size || sha256(copied) !== expected.sha256) {
      throw new OperatorError("BACKUP_VERIFY_FAILED");
    }
    records.push({ ...expected, backup: ARTIFACT_NAMES[index] });
  }
  const recordPath = path.join(backupPath, "manifest.json");
  const recordBytes = Buffer.from(`${JSON.stringify({ backup_id: backupId, files: records }, null, 2)}\n`);
  const handle = await open(recordPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(recordBytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { backupId, backupPath, records };
}

async function rollback(roots, backup, replaced) {
  for (const index of [...replaced].reverse()) {
    const record = backup.records[index];
    const target = artifactPath(roots.live, index);
    if (!record.exists) {
      await rm(target, { force: true });
      const restored = await inspectFile(roots.live, index, { required: false });
      if (restored.exists) throw new OperatorError("ROLLBACK_VERIFY_FAILED");
      continue;
    }
    const bytes = await readFile(path.join(backup.backupPath, record.backup));
    if (bytes.length !== record.size || sha256(bytes) !== record.sha256) {
      throw new OperatorError("BACKUP_CHANGED");
    }
    await writeTempAndRename(target, bytes, record.sha256, `${backup.backupId}-rollback-${index}`);
    await assertFileState(roots.live, index, record, { required: false });
  }
}

export async function executeDeployment(options) {
  const roots = options?.roots ?? PRODUCTION_ROOTS;
  const hooks = options?.hooks ?? {};
  const expectedCandidate = options?.expectedCandidateManifestSha;
  const expectedLive = options?.expectedLiveManifestSha;
  const result = {
    ...resultBase("execute"),
    candidate_manifest_sha256: null,
    live_manifest_before_sha256: null,
    live_manifest_after_sha256: null,
    replaced: [],
    rollback_attempted: false,
    rollback_status: "NOT_REQUIRED",
    backup_id: null,
    backup_path: null,
  };
  if (!HEX64.test(expectedCandidate ?? "") || !HEX64.test(expectedLive ?? "")) {
    return { ...result, reason: "INVALID_APPROVAL_MANIFEST" };
  }

  let candidate;
  let live;
  try {
    candidate = await inspectManifest(roots.candidate, { required: true });
    live = await inspectManifest(roots.live, { required: false });
  } catch (error) {
    return { ...result, reason: publicError(error) };
  }
  result.candidate_manifest_sha256 = candidate.manifest_sha256;
  result.live_manifest_before_sha256 = live.manifest_sha256;
  if (candidate.manifest_sha256 !== expectedCandidate.toLowerCase()) {
    return { ...result, reason: "CANDIDATE_MANIFEST_MISMATCH" };
  }
  if (live.manifest_sha256 !== expectedLive.toLowerCase()) {
    return { ...result, reason: "LIVE_MANIFEST_MISMATCH" };
  }

  let backup;
  const replacedIndexes = [];
  try {
    backup = await createBackup(roots, live);
    result.backup_id = backup.backupId;
    result.backup_path = backup.backupPath;
    for (let index = 0; index < ARTIFACTS.length; index += 1) {
      const bytes = await readVerifiedCandidate(roots.candidate, index, candidate.files[index]);
      await assertFileState(roots.live, index, live.files[index], { required: false });
      await hooks.beforeReplace?.({ artifact: ARTIFACTS[index], index });
      await writeTempAndRename(
        artifactPath(roots.live, index),
        bytes,
        candidate.files[index].sha256,
        `${backup.backupId}-${index}`,
      );
      replacedIndexes.push(index);
      result.replaced.push(ARTIFACTS[index]);
      await hooks.afterReplace?.({ artifact: ARTIFACTS[index], index });
    }
    await hooks.beforeFinalManifest?.();
    const after = await inspectManifest(roots.live, { required: true });
    result.live_manifest_after_sha256 = after.manifest_sha256;
    if (after.manifest_sha256 !== candidate.manifest_sha256) {
      throw new OperatorError("POST_DEPLOY_MANIFEST_MISMATCH");
    }
    return {
      ...result,
      ready: true,
      reason: "DEPLOYMENT_COMPLETE",
      rollback_status: "NOT_REQUIRED",
    };
  } catch (error) {
    const reason = publicError(error);
    if (replacedIndexes.length > 0 && backup) {
      result.rollback_attempted = true;
      try {
        await rollback(roots, backup, replacedIndexes);
        result.rollback_status = "ROLLED_BACK";
      } catch {
        result.rollback_status = "ROLLBACK_FAILED";
        return { ...result, reason: "ROLLBACK_FAILED" };
      }
    }
    return { ...result, reason };
  }
}

function parseCli(argv) {
  if (argv.length === 1 && argv[0] === "--preflight") {
    return { mode: "preflight" };
  }
  if (argv[0] !== "--execute" || argv.length !== 5) {
    throw new OperatorError("INVALID_ARGUMENTS");
  }
  const allowed = new Set([
    "--expected-candidate-manifest-sha",
    "--expected-live-manifest-sha",
  ]);
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || values.has(key) || !HEX64.test(value ?? "")) {
      throw new OperatorError("INVALID_ARGUMENTS");
    }
    values.set(key, value.toLowerCase());
  }
  if (values.size !== 2) throw new OperatorError("INVALID_ARGUMENTS");
  return {
    mode: "execute",
    expectedCandidateManifestSha: values.get("--expected-candidate-manifest-sha"),
    expectedLiveManifestSha: values.get("--expected-live-manifest-sha"),
  };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseCli(argv);
    const result = parsed.mode === "preflight"
      ? await preflight()
      : await executeDeployment(parsed);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.ready ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ mode: "invalid", ready: false, reason: publicError(error) })}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
