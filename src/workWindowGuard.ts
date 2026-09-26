import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "./guard.js";
import { codexProHome } from "./profileStore.js";

export const WORK_WINDOW_DURATION_MS = 30 * 60 * 1000;
export const WORK_WINDOW_ACTIVE_MS = 27 * 60 * 1000;
export const WORK_WINDOW_REPORT_RESERVE_MS = WORK_WINDOW_DURATION_MS - WORK_WINDOW_ACTIVE_MS;
export const WORK_WINDOW_MIN_BASH_BUDGET_MS = 1000;
export const WORK_WINDOW_MIN_SUBSTANTIVE_BUDGET_MS = 1000;

const WORK_WINDOW_VERSION = 1;
const HOST_RECORD_VERSION = 1;
const MAX_WINDOW_RECORDS = 512;
const MAX_CHECKPOINT_ITEMS = 50;
const MAX_CHECKPOINT_ITEM_LENGTH = 1000;
const MAX_RESUME_FROM_LENGTH = 2000;
const MAX_SESSION_BINDING_LENGTH = 128;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class WorkWindowError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CodexProError";
    this.details = details;
  }
}

export type WorkWindowState = "ACTIVE" | "DRAINING" | "EXPIRED" | "STOPPED";
export type WorkWindowStopReason = "MANUAL" | "CHECKPOINT_TERMINAL" | "DEADLINE_AUTO";

export interface WorkWindowCheckpoint {
  completed: string[];
  pending: string[];
  resume_from: string;
  finding: string[];
  test_completed: string[];
  test_not_run: string[];
  updated_at: string;
}

export interface WorkWindowRecord {
  version: 1;
  host_id: string;
  work_window_id: string;
  workspace_id: string;
  workspace_root: string;
  started_at: string;
  started_at_ms: number;
  drain_at: string;
  drain_at_ms: number;
  deadline: string;
  deadline_ms: number;
  session_binding?: string;
  stopped_at?: string;
  stopped_at_ms?: number;
  stop_reason?: WorkWindowStopReason;
  checkpoint?: WorkWindowCheckpoint;
}

export interface WorkWindowStatus {
  host_id: string;
  work_window_id: string;
  workspace_id: string;
  workspace_root: string;
  state: WorkWindowState;
  started_at: string;
  drain_at: string;
  deadline: string;
  started_at_kst: string;
  drain_at_kst: string;
  deadline_kst: string;
  remaining_to_drain_ms: number;
  remaining_to_deadline_ms: number;
  stopped_at?: string;
  stopped_at_kst?: string;
  stop_reason?: WorkWindowStopReason;
  checkpoint?: WorkWindowCheckpoint;
  session_binding?: string;
}

export interface WorkWindowGuardOptions {
  homeDir?: string;
  now?: () => number;
  uuid?: () => string;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

interface HostRecord {
  version: 1;
  host_id: string;
  created_at: string;
}

const workWindowLocks = new Map<string, Promise<void>>();

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

function assertUuid(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!UUID_RE.test(text)) {
    throw new WorkWindowError(`${label} must be a strict UUID v4.`);
  }
  return text.toLowerCase();
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function kst(ms: number): string {
  const date = new Date(ms + 9 * 60 * 60 * 1000);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} KST`;
}

function boundedText(value: unknown, maxLength: number, label: string): string {
  const text = String(value ?? "").trim();
  if (text.length > maxLength) {
    throw new WorkWindowError(`${label} exceeds ${maxLength} characters.`);
  }
  return text;
}

function boundedList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new WorkWindowError(`${label} must be an array.`);
  if (value.length > MAX_CHECKPOINT_ITEMS) {
    throw new WorkWindowError(`${label} exceeds ${MAX_CHECKPOINT_ITEMS} items.`);
  }
  return value.map((item, index) => boundedText(item, MAX_CHECKPOINT_ITEM_LENGTH, `${label}[${index}]`));
}

async function withWindowLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = workWindowLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  workWindowLocks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (workWindowLocks.get(key) === tail) workWindowLocks.delete(key);
  }
}

async function readJson(pathname: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fsp.readFile(pathname, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      throw new WorkWindowError(`Corrupt Work Window registry JSON: ${pathname}`);
    }
    throw error;
  }
}

async function syncDirectoryBestEffort(dirname: string): Promise<void> {
  try {
    const handle = await fsp.open(dirname, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not portable on every supported Windows filesystem.
  }
}

async function atomicWriteJson(pathname: string, value: unknown): Promise<void> {
  const dirname = path.dirname(pathname);
  await fsp.mkdir(dirname, { recursive: true });
  const tempPath = path.join(dirname, `.${path.basename(pathname)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    handle = await fsp.open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.rename(tempPath, pathname);
    await syncDirectoryBestEffort(dirname);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fsp.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function validateHostRecord(value: unknown, pathname: string): HostRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkWindowError(`Corrupt Work Window host record: ${pathname}`);
  }
  const record = value as Partial<HostRecord>;
  if (record.version !== HOST_RECORD_VERSION) {
    throw new WorkWindowError(`Unsupported Work Window host record version: ${pathname}`);
  }
  const hostId = assertUuid(record.host_id, "host_id");
  if (typeof record.created_at !== "string" || !Number.isFinite(Date.parse(record.created_at))) {
    throw new WorkWindowError(`Corrupt Work Window host created_at: ${pathname}`);
  }
  return { version: 1, host_id: hostId, created_at: record.created_at };
}

function validateWindowRecord(value: unknown, pathname: string): WorkWindowRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkWindowError(`Corrupt Work Window record: ${pathname}`);
  }
  const record = value as Partial<WorkWindowRecord>;
  if (record.version !== WORK_WINDOW_VERSION) {
    throw new WorkWindowError(`Unsupported Work Window record version: ${pathname}`);
  }
  const hostId = assertUuid(record.host_id, "host_id");
  const windowId = assertUuid(record.work_window_id, "work_window_id");
  if (
    typeof record.workspace_id !== "string" ||
    !record.workspace_id ||
    typeof record.workspace_root !== "string" ||
    !record.workspace_root ||
    typeof record.started_at !== "string" ||
    typeof record.drain_at !== "string" ||
    typeof record.deadline !== "string" ||
    typeof record.started_at_ms !== "number" ||
    !Number.isFinite(record.started_at_ms) ||
    typeof record.drain_at_ms !== "number" ||
    !Number.isFinite(record.drain_at_ms) ||
    typeof record.deadline_ms !== "number" ||
    !Number.isFinite(record.deadline_ms)
  ) {
    throw new WorkWindowError(`Corrupt Work Window record fields: ${pathname}`);
  }
  if (
    record.drain_at_ms !== record.started_at_ms + WORK_WINDOW_ACTIVE_MS ||
    record.deadline_ms !== record.started_at_ms + WORK_WINDOW_DURATION_MS ||
    record.drain_at !== iso(record.drain_at_ms) ||
    record.deadline !== iso(record.deadline_ms) ||
    record.started_at !== iso(record.started_at_ms)
  ) {
    throw new WorkWindowError(`Corrupt Work Window immutable deadline fields: ${pathname}`);
  }
  if (record.stopped_at_ms !== undefined) {
    if (!Number.isFinite(record.stopped_at_ms) || record.stopped_at !== iso(record.stopped_at_ms)) {
      throw new WorkWindowError(`Corrupt Work Window stopped metadata: ${pathname}`);
    }
    if (
      record.stop_reason !== undefined &&
      !["MANUAL", "CHECKPOINT_TERMINAL", "DEADLINE_AUTO"].includes(record.stop_reason)
    ) {
      throw new WorkWindowError(`Corrupt Work Window stop_reason: ${pathname}`);
    }
  } else if (record.stopped_at !== undefined || record.stop_reason !== undefined) {
    throw new WorkWindowError(`Corrupt Work Window stopped metadata: ${pathname}`);
  }
  if (record.session_binding !== undefined) {
    boundedText(record.session_binding, MAX_SESSION_BINDING_LENGTH, "session_binding");
  }
  if (record.checkpoint !== undefined) {
    const checkpoint = record.checkpoint as WorkWindowCheckpoint;
    boundedList(checkpoint.completed, "checkpoint.completed");
    boundedList(checkpoint.pending, "checkpoint.pending");
    boundedText(checkpoint.resume_from, MAX_RESUME_FROM_LENGTH, "checkpoint.resume_from");
    boundedList(checkpoint.finding, "checkpoint.finding");
    boundedList(checkpoint.test_completed, "checkpoint.test_completed");
    boundedList(checkpoint.test_not_run, "checkpoint.test_not_run");
    if (typeof checkpoint.updated_at !== "string" || !Number.isFinite(Date.parse(checkpoint.updated_at))) {
      throw new WorkWindowError(`Corrupt Work Window checkpoint updated_at: ${pathname}`);
    }
  }
  return {
    ...(record as WorkWindowRecord),
    host_id: hostId,
    work_window_id: windowId
  };
}

function evaluateState(record: WorkWindowRecord, nowMs: number): WorkWindowState {
  if (record.stopped_at_ms !== undefined) return "STOPPED";
  if (nowMs >= record.deadline_ms) return "EXPIRED";
  if (nowMs >= record.drain_at_ms) return "DRAINING";
  return "ACTIVE";
}

function assertWorkspace(record: WorkWindowRecord, workspace: Workspace): void {
  if (record.workspace_id !== workspace.id || record.workspace_root !== workspace.root) {
    throw new WorkWindowError(
      `Work Window ${record.work_window_id} is bound to a different workspace.`
    );
  }
}

export class WorkWindowGuard {
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly rootDir: string;
  private readonly hostPath: string;
  private readonly windowsDir: string;
  private readonly setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly deadlineTimers = new Map<string, NodeJS.Timeout>();
  private initialization?: Promise<void>;
  private deadlineTerminalizationError?: unknown;

  constructor(options: WorkWindowGuardOptions = {}) {
    this.now = options.now ?? Date.now;
    this.uuid = options.uuid ?? randomUUID;
    this.rootDir = options.homeDir
      ? path.resolve(options.homeDir)
      : path.join(codexProHome(), "work-windows");
    this.hostPath = path.join(this.rootDir, "host.json");
    this.windowsDir = path.join(this.rootDir, "windows");
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.recoverAndScheduleDeadlines();
    }
    await this.initialization;
    if (this.deadlineTerminalizationError) throw this.deadlineTerminalizationError;
  }

  private clearDeadlineTimer(workWindowId: string): void {
    const timer = this.deadlineTimers.get(workWindowId);
    if (!timer) return;
    this.clearTimer(timer);
    this.deadlineTimers.delete(workWindowId);
  }

  private scheduleDeadlineTimer(record: WorkWindowRecord): void {
    this.clearDeadlineTimer(record.work_window_id);
    if (record.stopped_at_ms !== undefined) return;
    const delayMs = Math.max(0, record.deadline_ms - this.now());
    const timer = this.setTimer(() => {
      void this.terminalizeDeadline(record.work_window_id).catch((error) => {
        this.deadlineTerminalizationError = error;
      });
    }, delayMs);
    timer.unref?.();
    this.deadlineTimers.set(record.work_window_id, timer);
  }

  private async terminalizeDeadline(workWindowId: string): Promise<void> {
    const pathname = this.windowPath(workWindowId);
    await withWindowLock(pathname, async () => {
      const host = await this.readExistingHost();
      if (!host) return;
      const raw = await readJson(pathname);
      if (raw === undefined) {
        this.clearDeadlineTimer(workWindowId);
        return;
      }
      const record = validateWindowRecord(raw, pathname);
      if (record.host_id !== host.host_id) {
        throw new WorkWindowError(`Work Window host_id mismatch: ${record.work_window_id}`);
      }
      if (record.stopped_at_ms !== undefined) {
        this.clearDeadlineTimer(workWindowId);
        return;
      }
      const nowMs = this.now();
      if (nowMs < record.deadline_ms) {
        this.scheduleDeadlineTimer(record);
        return;
      }
      record.stopped_at_ms = record.deadline_ms;
      record.stopped_at = record.deadline;
      record.stop_reason = "DEADLINE_AUTO";
      await atomicWriteJson(pathname, record);
      this.clearDeadlineTimer(workWindowId);
    });
  }

  private async recoverAndScheduleDeadlines(): Promise<void> {
    await withWindowLock(this.registryLockKey(), async () => {
      const host = await this.readExistingHost();
      if (!host) return;
      const recordNames = await this.registryRecordNames();
      const entries: Array<{ name: string; pathname: string; record: WorkWindowRecord }> = [];

      for (const name of recordNames) {
        const id = assertUuid(name.slice(0, -5), "work_window_id");
        const pathname = path.join(this.windowsDir, name);
        const raw = await readJson(pathname);
        if (raw === undefined) continue;
        const record = validateWindowRecord(raw, pathname);
        if (record.work_window_id !== id) {
          throw new WorkWindowError(`Work Window filename/id mismatch: ${name}`);
        }
        if (record.host_id !== host.host_id) {
          throw new WorkWindowError(`Work Window host_id mismatch: ${record.work_window_id}`);
        }
        if (record.stopped_at_ms === undefined && this.now() >= record.deadline_ms) {
          record.stopped_at_ms = record.deadline_ms;
          record.stopped_at = record.deadline;
          record.stop_reason = "DEADLINE_AUTO";
          await atomicWriteJson(pathname, record);
        }
        entries.push({ name, pathname, record });
      }

      if (entries.length > MAX_WINDOW_RECORDS) {
        const latest = [...entries].sort(
          (a, b) =>
            a.record.started_at_ms - b.record.started_at_ms ||
            a.record.work_window_id.localeCompare(b.record.work_window_id)
        ).at(-1);
        if (!latest) throw new WorkWindowError("Work Window registry latest record could not be determined.");

        const archiveCount = entries.length - MAX_WINDOW_RECORDS;
        const archiveCandidates = entries
          .filter(
            (entry) =>
              entry.record.stopped_at_ms !== undefined &&
              entry.record.work_window_id !== latest.record.work_window_id
          )
          .sort(
            (a, b) =>
              a.record.started_at_ms - b.record.started_at_ms ||
              a.record.work_window_id.localeCompare(b.record.work_window_id)
          );
        if (archiveCandidates.length < archiveCount) {
          throw new WorkWindowError(
            `Work Window registry has ${entries.length} records but only ${archiveCandidates.length} archivable STOPPED records; non-terminal records will not be archived.`
          );
        }

        const archiveDir = path.join(this.rootDir, "archive");
        await fsp.mkdir(archiveDir, { recursive: true });
        const selected = archiveCandidates.slice(0, archiveCount);
        const destinations = selected.map((entry) => ({ entry, destination: path.join(archiveDir, entry.name) }));
        for (const { destination } of destinations) {
          try {
            await fsp.access(destination);
            throw new WorkWindowError(`Work Window archive destination already exists: ${destination}`);
          } catch (error) {
            if (errorCode(error) !== "ENOENT") throw error;
          }
        }

        const moved: Array<{ entry: (typeof selected)[number]; destination: string }> = [];
        try {
          for (const item of destinations) {
            await fsp.rename(item.entry.pathname, item.destination);
            moved.push(item);
          }
        } catch (error) {
          let rollbackError: unknown;
          for (const item of [...moved].reverse()) {
            try {
              await fsp.rename(item.destination, item.entry.pathname);
            } catch (caught) {
              rollbackError ??= caught;
            }
          }
          if (rollbackError) {
            throw new WorkWindowError(`Work Window archive failed and rollback also failed: ${String(rollbackError)}`);
          }
          throw error;
        }

        await syncDirectoryBestEffort(this.windowsDir);
        await syncDirectoryBestEffort(archiveDir);
        const recoveredCount = (await this.registryRecordNames()).length;
        if (recoveredCount > MAX_WINDOW_RECORDS) {
          throw new WorkWindowError(
            `Work Window registry recovery left ${recoveredCount} records, above bounded limit ${MAX_WINDOW_RECORDS}.`
          );
        }
      }

      const remainingNames = await this.registryRecordNames();
      for (const name of remainingNames) {
        const pathname = path.join(this.windowsDir, name);
        const raw = await readJson(pathname);
        if (raw === undefined) continue;
        const record = validateWindowRecord(raw, pathname);
        if (record.host_id !== host.host_id) {
          throw new WorkWindowError(`Work Window host_id mismatch: ${record.work_window_id}`);
        }
        if (record.stopped_at_ms === undefined) this.scheduleDeadlineTimer(record);
      }
    });
  }

  registryRoot(): string {
    return this.rootDir;
  }

  private windowPath(workWindowId: string): string {
    return path.join(this.windowsDir, `${assertUuid(workWindowId, "work_window_id")}.json`);
  }

  private registryLockKey(): string {
    return path.join(this.rootDir, ".registry-capacity");
  }

  private async registryRecordNames(): Promise<string[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.windowsDir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    return names.filter((name) => name.endsWith(".json")).sort();
  }

  private async reclaimStoppedRecordForStart(host: HostRecord): Promise<boolean> {
    const recordNames = await this.registryRecordNames();
    if (recordNames.length < MAX_WINDOW_RECORDS) return false;
    if (recordNames.length > MAX_WINDOW_RECORDS) {
      throw new WorkWindowError(
        `Work Window registry still exceeds bounded limit of ${MAX_WINDOW_RECORDS} records after bootstrap recovery.`
      );
    }

    const entries: Array<{ name: string; pathname: string; record: WorkWindowRecord }> = [];
    for (const name of recordNames) {
      const id = assertUuid(name.slice(0, -5), "work_window_id");
      const pathname = path.join(this.windowsDir, name);
      const raw = await readJson(pathname);
      if (raw === undefined) {
        throw new WorkWindowError(`Work Window record disappeared during capacity reclaim: ${name}`);
      }
      const record = validateWindowRecord(raw, pathname);
      if (record.work_window_id !== id) {
        throw new WorkWindowError(`Work Window filename/id mismatch: ${name}`);
      }
      if (record.host_id !== host.host_id) {
        throw new WorkWindowError(`Work Window host_id mismatch: ${record.work_window_id}`);
      }
      entries.push({ name, pathname, record });
    }

    const latest = [...entries].sort(
      (a, b) =>
        a.record.started_at_ms - b.record.started_at_ms ||
        a.record.work_window_id.localeCompare(b.record.work_window_id)
    ).at(-1);
    if (!latest) throw new WorkWindowError("Work Window registry latest record could not be determined.");

    const candidate = entries
      .filter(
        (entry) =>
          entry.record.stopped_at_ms !== undefined &&
          entry.record.work_window_id !== latest.record.work_window_id
      )
      .sort(
        (a, b) =>
          a.record.started_at_ms - b.record.started_at_ms ||
          a.record.work_window_id.localeCompare(b.record.work_window_id)
      )
      .at(0);
    if (!candidate) {
      throw new WorkWindowError(
        `Work Window registry is at bounded capacity ${recordNames.length}/${MAX_WINDOW_RECORDS} and has no reclaimable STOPPED record; start did not create a new record.`,
        { registry_count: recordNames.length, registry_limit: MAX_WINDOW_RECORDS, record_created: false }
      );
    }

    const archiveDir = path.join(this.rootDir, "archive");
    await fsp.mkdir(archiveDir, { recursive: true });
    const destination = path.join(archiveDir, candidate.name);
    try {
      await fsp.access(destination);
      throw new WorkWindowError(`Work Window archive destination already exists: ${destination}`);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }

    await fsp.rename(candidate.pathname, destination);
    await syncDirectoryBestEffort(this.windowsDir);
    await syncDirectoryBestEffort(archiveDir);
    const remainingCount = (await this.registryRecordNames()).length;
    if (remainingCount !== MAX_WINDOW_RECORDS - 1) {
      throw new WorkWindowError(
        `Work Window capacity reclaim left unexpected registry count ${remainingCount}; expected ${MAX_WINDOW_RECORDS - 1}.`
      );
    }
    return true;
  }

  private workspaceLockKey(workspace: Workspace): string {
    return path.join(this.windowsDir, `.workspace-${workspace.id}`);
  }

  private async readExistingHost(): Promise<HostRecord | undefined> {
    const raw = await readJson(this.hostPath);
    return raw === undefined ? undefined : validateHostRecord(raw, this.hostPath);
  }

  private async ensureHost(): Promise<HostRecord> {
    await fsp.mkdir(this.rootDir, { recursive: true });
    const existing = await this.readExistingHost();
    if (existing) return existing;

    const hostId = assertUuid(this.uuid(), "host_id");
    const record: HostRecord = {
      version: 1,
      host_id: hostId,
      created_at: iso(this.now())
    };
    let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
    try {
      handle = await fsp.open(this.hostPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await syncDirectoryBestEffort(this.rootDir);
      return record;
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (errorCode(error) !== "EEXIST") throw error;
      const raced = await this.readExistingHost();
      if (!raced) throw new WorkWindowError("Work Window host initialization race did not produce a host record.");
      return raced;
    }
  }

  private async loadWindow(workWindowId: string): Promise<{ host: HostRecord; record: WorkWindowRecord }> {
    await this.initialize();
    const normalized = assertUuid(workWindowId, "work_window_id");
    const host = await this.readExistingHost();
    if (!host) throw new WorkWindowError("Work Window host identity is not initialized.");
    const pathname = this.windowPath(normalized);
    const raw = await readJson(pathname);
    if (raw === undefined) throw new WorkWindowError(`Work Window not found: ${normalized}`);
    const record = validateWindowRecord(raw, pathname);
    if (record.host_id !== host.host_id) {
      throw new WorkWindowError(`Work Window host_id mismatch: ${normalized}`);
    }
    return { host, record };
  }

  private statusFrom(record: WorkWindowRecord, nowMs = this.now()): WorkWindowStatus {
    const state = evaluateState(record, nowMs);
    return {
      host_id: record.host_id,
      work_window_id: record.work_window_id,
      workspace_id: record.workspace_id,
      workspace_root: record.workspace_root,
      state,
      started_at: record.started_at,
      drain_at: record.drain_at,
      deadline: record.deadline,
      started_at_kst: kst(record.started_at_ms),
      drain_at_kst: kst(record.drain_at_ms),
      deadline_kst: kst(record.deadline_ms),
      remaining_to_drain_ms: Math.max(0, Math.floor(record.drain_at_ms - nowMs)),
      remaining_to_deadline_ms: Math.max(0, Math.floor(record.deadline_ms - nowMs)),
      ...(record.stopped_at
        ? {
            stopped_at: record.stopped_at,
            stopped_at_kst: kst(record.stopped_at_ms as number),
            ...(record.stop_reason ? { stop_reason: record.stop_reason } : {})
          }
        : {}),
      ...(record.checkpoint ? { checkpoint: record.checkpoint } : {}),
      ...(record.session_binding ? { session_binding: record.session_binding } : {})
    };
  }

  private async workspaceRecords(workspace: Workspace): Promise<WorkWindowRecord[]> {
    await this.initialize();
    const host = await this.readExistingHost();
    if (!host) return [];
    let names: string[];
    try {
      names = await fsp.readdir(this.windowsDir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    const recordNames = names.filter((name) => name.endsWith(".json")).sort();
    if (recordNames.length > MAX_WINDOW_RECORDS) {
      throw new WorkWindowError(`Work Window registry exceeds bounded limit of ${MAX_WINDOW_RECORDS} records.`);
    }
    const records: WorkWindowRecord[] = [];
    for (const name of recordNames) {
      const id = name.slice(0, -5);
      assertUuid(id, "work_window_id");
      const pathname = path.join(this.windowsDir, name);
      const raw = await readJson(pathname);
      if (raw === undefined) continue;
      let record = validateWindowRecord(raw, pathname);
      if (record.host_id !== host.host_id) {
        throw new WorkWindowError(`Work Window host_id mismatch: ${record.work_window_id}`);
      }
      if (record.stopped_at_ms === undefined && this.now() >= record.deadline_ms) {
        await this.terminalizeDeadline(record.work_window_id);
        const reconciled = await readJson(pathname);
        if (reconciled === undefined) continue;
        record = validateWindowRecord(reconciled, pathname);
      }
      if (record.workspace_id === workspace.id && record.workspace_root === workspace.root) records.push(record);
    }
    return records.sort(
      (a, b) => a.started_at_ms - b.started_at_ms || a.work_window_id.localeCompare(b.work_window_id)
    );
  }

  async latestStatus(workspace: Workspace): Promise<WorkWindowStatus | undefined> {
    const records = await this.workspaceRecords(workspace);
    const latest = records.at(-1);
    return latest ? this.statusFrom(latest) : undefined;
  }

  async assertContinuationAllowed(workspace: Workspace): Promise<WorkWindowStatus | undefined> {
    const status = await this.latestStatus(workspace);
    if (!status || status.state === "ACTIVE") return status;
    throw new WorkWindowError(
      `Work Window ${status.work_window_id} is ${status.state}; substantive workspace work must stop. Persist a checkpoint/STOPPED report and wait for a new explicit start_work_window after a new user-authorized work/resume request.`,
      {
        work_window_id: status.work_window_id,
        work_window_state: status.state,
        must_stop: true,
        checkpoint_required: status.state === "DRAINING" || status.state === "EXPIRED",
        auto_renew_allowed: false,
        drain_at: status.drain_at,
        deadline: status.deadline
      }
    );
  }

  async start(workspace: Workspace, options: { sessionBinding?: string } = {}): Promise<WorkWindowStatus> {
    await this.initialize();
    return withWindowLock(this.registryLockKey(), async () =>
      withWindowLock(this.workspaceLockKey(workspace), async () => {
        const nowMs = this.now();
        const existing = (await this.workspaceRecords(workspace))
          .map((record) => this.statusFrom(record, nowMs))
          .filter((status) => status.state === "ACTIVE" || status.state === "DRAINING")
          .at(-1);
        if (existing) {
          throw new WorkWindowError(
            `Work Window ${existing.work_window_id} is already ${existing.state} for this workspace; parallel continuation and auto-renewal are not allowed.`,
            {
              work_window_id: existing.work_window_id,
              work_window_state: existing.state,
              must_stop: existing.state === "DRAINING",
              checkpoint_required: existing.state === "DRAINING",
              auto_renew_allowed: false
            }
          );
        }

        let recordCount = (await this.registryRecordNames()).length;
        let host = await this.readExistingHost();
        if (recordCount >= MAX_WINDOW_RECORDS) {
          if (!host) {
            throw new WorkWindowError(
              "Work Window registry has records but host identity is not initialized; capacity reclaim is fail-closed."
            );
          }
          await this.reclaimStoppedRecordForStart(host);
          recordCount = (await this.registryRecordNames()).length;
        }
        if (recordCount >= MAX_WINDOW_RECORDS) {
          throw new WorkWindowError(
            `Work Window registry is at bounded capacity ${recordCount}/${MAX_WINDOW_RECORDS}; start did not create a new record.`,
            { registry_count: recordCount, registry_limit: MAX_WINDOW_RECORDS, record_created: false }
          );
        }

        host ??= await this.ensureHost();
        const workWindowId = assertUuid(this.uuid(), "work_window_id");
        const sessionBinding = options.sessionBinding === undefined
          ? undefined
          : boundedText(options.sessionBinding, MAX_SESSION_BINDING_LENGTH, "session_binding");
        const record: WorkWindowRecord = {
          version: 1,
          host_id: host.host_id,
          work_window_id: workWindowId,
          workspace_id: workspace.id,
          workspace_root: workspace.root,
          started_at: iso(nowMs),
          started_at_ms: nowMs,
          drain_at: iso(nowMs + WORK_WINDOW_ACTIVE_MS),
          drain_at_ms: nowMs + WORK_WINDOW_ACTIVE_MS,
          deadline: iso(nowMs + WORK_WINDOW_DURATION_MS),
          deadline_ms: nowMs + WORK_WINDOW_DURATION_MS,
          ...(sessionBinding ? { session_binding: sessionBinding } : {})
        };
        const pathname = this.windowPath(workWindowId);
        if (await readJson(pathname) !== undefined) {
          throw new WorkWindowError(`Work Window id collision: ${workWindowId}`);
        }
        await atomicWriteJson(pathname, record);
        this.scheduleDeadlineTimer(record);
        return this.statusFrom(record, nowMs);
      })
    );
  }

  async status(workspace: Workspace, workWindowId: string): Promise<WorkWindowStatus> {
    const { record } = await this.loadWindow(workWindowId);
    assertWorkspace(record, workspace);
    return this.statusFrom(record);
  }

  async listActive(workspace: Workspace): Promise<WorkWindowStatus[]> {
    const nowMs = this.now();
    const active = (await this.workspaceRecords(workspace))
      .map((record) => this.statusFrom(record, nowMs))
      .filter((status) => status.state === "ACTIVE" || status.state === "DRAINING");
    return active.sort((a, b) => a.started_at.localeCompare(b.started_at));
  }

  async checkpoint(
    workspace: Workspace,
    workWindowId: string,
    input: {
      completed?: unknown;
      pending?: unknown;
      resumeFrom?: unknown;
      finding?: unknown;
      testCompleted?: unknown;
      testNotRun?: unknown;
    }
  ): Promise<WorkWindowStatus> {
    const pathname = this.windowPath(workWindowId);
    return withWindowLock(pathname, async () => {
      const { record } = await this.loadWindow(workWindowId);
      assertWorkspace(record, workspace);
      const nowMs = this.now();
      const stateBeforeCheckpoint = evaluateState(record, nowMs);
      record.checkpoint = {
        completed: boundedList(input.completed, "completed"),
        pending: boundedList(input.pending, "pending"),
        resume_from: boundedText(input.resumeFrom, MAX_RESUME_FROM_LENGTH, "resume_from"),
        finding: boundedList(input.finding, "finding"),
        test_completed: boundedList(input.testCompleted, "test_completed"),
        test_not_run: boundedList(input.testNotRun, "test_not_run"),
        updated_at: iso(nowMs)
      };
      if (
        record.stopped_at_ms === undefined &&
        (stateBeforeCheckpoint === "DRAINING" || stateBeforeCheckpoint === "EXPIRED")
      ) {
        record.stopped_at_ms = nowMs;
        record.stopped_at = iso(nowMs);
        record.stop_reason = "CHECKPOINT_TERMINAL";
      }
      await atomicWriteJson(pathname, record);
      if (record.stopped_at_ms !== undefined) this.clearDeadlineTimer(record.work_window_id);
      return this.statusFrom(record, nowMs);
    });
  }

  async stop(workspace: Workspace, workWindowId: string): Promise<WorkWindowStatus> {
    const pathname = this.windowPath(workWindowId);
    return withWindowLock(pathname, async () => {
      const { record } = await this.loadWindow(workWindowId);
      assertWorkspace(record, workspace);
      if (record.stopped_at_ms === undefined) {
        const nowMs = this.now();
        record.stopped_at_ms = nowMs;
        record.stopped_at = iso(nowMs);
        record.stop_reason = "MANUAL";
        await atomicWriteJson(pathname, record);
        this.clearDeadlineTimer(record.work_window_id);
        return this.statusFrom(record, nowMs);
      }
      return this.statusFrom(record);
    });
  }

  async assertMutationAllowed(workspace: Workspace, workWindowId: string): Promise<WorkWindowStatus> {
    const { record } = await this.loadWindow(workWindowId);
    assertWorkspace(record, workspace);
    const status = this.statusFrom(record);
    if (status.state !== "ACTIVE") {
      throw new WorkWindowError(
        `Work Window ${status.work_window_id} is ${status.state}; source mutation requires ACTIVE state. Start a new window only after a new user-authorized work/resume request.`
      );
    }
    return status;
  }

  async effectiveBashTimeout(
    workspace: Workspace,
    workWindowId: string,
    requestedTimeoutMs: number | undefined,
    maxTimeoutMs: number,
    defaultTimeoutMs = 30_000
  ): Promise<{ timeoutMs: number; status: WorkWindowStatus }> {
    const status = await this.assertMutationAllowed(workspace, workWindowId);
    if (status.remaining_to_drain_ms < WORK_WINDOW_MIN_BASH_BUDGET_MS) {
      throw new WorkWindowError(
        `Work Window ${status.work_window_id} has less than ${WORK_WINDOW_MIN_BASH_BUDGET_MS} ms ACTIVE budget remaining; bash was not started.`
      );
    }
    const requested = requestedTimeoutMs ?? defaultTimeoutMs;
    const timeoutMs = Math.floor(Math.min(requested, maxTimeoutMs, status.remaining_to_drain_ms));
    if (timeoutMs < WORK_WINDOW_MIN_BASH_BUDGET_MS) {
      throw new WorkWindowError("Effective bash timeout is below the minimum safe spawn budget.");
    }
    return { timeoutMs, status };
  }
}
