import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

export const CODEXPRO_CONTROLLED_HANDOVER_TOOL_NAME = "codexpro_controlled_handover";
export const CODEXPRO_CONTROLLED_HANDOVER_CONFIRM = "CODEXPRO_CONTROLLED_HANDOVER";
export const CODEXPRO_CONTROLLED_HANDOVER_ACTION = "CODEXPRO_CONTROLLED_HANDOVER";

export interface ControlledHandoverPaths {
  logDir: string;
  lockFile: string;
  controlFile: string;
  launcherFile: string;
}

export const CODEXPRO_CONTROLLED_HANDOVER_PATHS: ControlledHandoverPaths = Object.freeze({
  logDir: String.raw`C:\Codex\tools\codexpro-supervisor\dual-logs`,
  lockFile: String.raw`C:\Codex\tools\codexpro-supervisor\dual-logs\codexpro-personal-dual.lock`,
  controlFile: String.raw`C:\Codex\tools\codexpro-supervisor\dual-logs\codexpro-personal-dual.control.json`,
  launcherFile: String.raw`C:\Codex\projects\_tools\CodexPro 실행_AI.bat`
});

export interface ControlledHandoverOptions {
  confirm: string;
  dryRun?: boolean;
}

export interface ControlledHandoverContext {
  platform?: NodeJS.Platform;
  paths?: ControlledHandoverPaths;
  isPidAlive?: (pid: number) => boolean;
  now?: Date;
  requestId?: () => string;
}

export interface ControlledHandoverPlan {
  action: typeof CODEXPRO_CONTROLLED_HANDOVER_ACTION;
  dryRun: boolean;
  expectedSupervisorPid: number;
  controlFile: string;
  lockFile: string;
  launcherFile: string;
  expectedLauncherSha256: string;
}

function assertRegularFile(file: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new Error(`${label} is unavailable: ${file}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${file}`);
}

export function launcherSha256(file: string): string {
  assertRegularFile(file, "Canonical CodexPro launcher");
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assertRegularDirectory(dir: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    throw new Error(`${label} is unavailable: ${dir}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular directory: ${dir}`);
  const actual = fs.realpathSync(dir);
  if (path.resolve(actual).toLowerCase() !== path.resolve(dir).toLowerCase()) {
    throw new Error(`${label} realpath mismatch: ${dir}`);
  }
}

export function windowsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const result = spawnSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) return false;
  const text = String(result.stdout ?? "").trim();
  return Boolean(text) && !/No tasks are running/i.test(text) && text.includes(`"${pid}"`);
}

export function readDualSupervisorPid(paths: ControlledHandoverPaths = CODEXPRO_CONTROLLED_HANDOVER_PATHS): number {
  assertRegularFile(paths.lockFile, "Dual supervisor lock");
  const value = Number(fs.readFileSync(paths.lockFile, "utf8").trim());
  if (!Number.isInteger(value) || value <= 0) throw new Error("Dual supervisor lock owner is invalid.");
  return value;
}

export function buildControlledHandoverPlan(
  options: ControlledHandoverOptions,
  context: ControlledHandoverContext = {}
): ControlledHandoverPlan {
  const platform = context.platform ?? process.platform;
  if (platform !== "win32") throw new Error(`Controlled CodexPro handover is only available on win32; current platform=${platform}.`);
  if (options.confirm !== CODEXPRO_CONTROLLED_HANDOVER_CONFIRM) {
    throw new Error(`Exact confirmation required: ${CODEXPRO_CONTROLLED_HANDOVER_CONFIRM}`);
  }

  const paths = context.paths ?? CODEXPRO_CONTROLLED_HANDOVER_PATHS;
  assertRegularDirectory(paths.logDir, "Dual supervisor log directory");
  assertRegularFile(paths.launcherFile, "Canonical CodexPro launcher");
  if (fs.existsSync(paths.controlFile)) throw new Error(`Controlled handover request already exists: ${paths.controlFile}`);

  const expectedSupervisorPid = readDualSupervisorPid(paths);
  const isPidAlive = context.isPidAlive ?? windowsPidAlive;
  if (!isPidAlive(expectedSupervisorPid)) throw new Error(`Dual supervisor lock owner is not alive: pid=${expectedSupervisorPid}`);

  return {
    action: CODEXPRO_CONTROLLED_HANDOVER_ACTION,
    dryRun: options.dryRun !== false,
    expectedSupervisorPid,
    controlFile: paths.controlFile,
    lockFile: paths.lockFile,
    launcherFile: paths.launcherFile,
    expectedLauncherSha256: launcherSha256(paths.launcherFile)
  };
}

export function requestControlledHandover(
  options: ControlledHandoverOptions,
  context: ControlledHandoverContext = {}
): ControlledHandoverPlan & { status: "DRY_RUN" | "REQUESTED"; requestId: string | null; requestedAt: string | null } {
  const plan = buildControlledHandoverPlan(options, context);
  if (plan.dryRun) return { ...plan, status: "DRY_RUN", requestId: null, requestedAt: null };

  const requestId = (context.requestId ?? randomUUID)();
  const requestedAt = (context.now ?? new Date()).toISOString();
  const payload = {
    version: 2,
    action: CODEXPRO_CONTROLLED_HANDOVER_ACTION,
    requestId,
    requestedAt,
    expectedSupervisorPid: plan.expectedSupervisorPid,
    expectedLauncherSha256: plan.expectedLauncherSha256
  };

  let fd: number | null = null;
  try {
    fd = fs.openSync(plan.controlFile, "wx");
    fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, { encoding: "utf8" });
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }

  return { ...plan, status: "REQUESTED", requestId, requestedAt };
}
