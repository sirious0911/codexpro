import {
  arch as osArch,
  cpus as osCpus,
  freemem as osFreeMem,
  platform as osPlatform,
  release as osRelease,
  totalmem as osTotalMem,
  uptime as osUptime
} from "node:os";

export const WINDOWS_SYSTEM_RELEASE_MAX_CHARS = 128;
export const WINDOWS_SYSTEM_ARCHES = ["x64", "arm64", "ia32"] as const;

export type WindowsSystemArch = (typeof WINDOWS_SYSTEM_ARCHES)[number];

export interface WindowsSystemSnapshot {
  platform: "win32";
  release: string;
  arch: WindowsSystemArch;
  uptime_seconds: number;
  cpu_count: number;
  total_memory_bytes: number;
  free_memory_bytes: number;
}

export interface WindowsSystemSnapshotRuntime {
  platform(): string;
  release(): string;
  arch(): string;
  uptime(): number;
  cpuCount(): number;
  totalMemory(): number;
  freeMemory(): number;
}

const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

function assertSafeNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Windows system snapshot ${field} must be a non-negative safe integer.`);
  }
  return value as number;
}

export const defaultWindowsSystemSnapshotRuntime: WindowsSystemSnapshotRuntime =
  Object.freeze({
    platform: () => osPlatform(),
    release: () => osRelease(),
    arch: () => osArch(),
    uptime: () => osUptime(),
    cpuCount: () => osCpus().length,
    totalMemory: () => osTotalMem(),
    freeMemory: () => osFreeMem()
  });

export function createWindowsSystemSnapshot(
  runtime: WindowsSystemSnapshotRuntime = defaultWindowsSystemSnapshotRuntime
): WindowsSystemSnapshot {
  const platform = runtime.platform();
  if (platform !== "win32") {
    throw new Error("Windows system snapshot platform must be win32.");
  }

  const release = runtime.release();
  if (
    typeof release !== "string" ||
    release.length < 1 ||
    release.length > WINDOWS_SYSTEM_RELEASE_MAX_CHARS ||
    !PRINTABLE_ASCII.test(release)
  ) {
    throw new Error("Windows system snapshot release is invalid or out of bounds.");
  }

  const arch = runtime.arch();
  if (!(WINDOWS_SYSTEM_ARCHES as readonly string[]).includes(arch)) {
    throw new Error("Windows system snapshot arch is not allowlisted.");
  }

  const uptime = runtime.uptime();
  if (!Number.isFinite(uptime) || uptime < 0) {
    throw new Error("Windows system snapshot uptime must be finite and non-negative.");
  }

  const cpuCount = runtime.cpuCount();
  if (!Number.isInteger(cpuCount) || cpuCount < 1 || cpuCount > 4096) {
    throw new Error("Windows system snapshot cpu_count is out of bounds.");
  }

  const totalMemory = assertSafeNonNegativeInteger(
    runtime.totalMemory(),
    "total_memory_bytes"
  );
  const freeMemory = assertSafeNonNegativeInteger(
    runtime.freeMemory(),
    "free_memory_bytes"
  );

  if (freeMemory > totalMemory) {
    throw new Error(
      "Windows system snapshot free_memory_bytes cannot exceed total_memory_bytes."
    );
  }

  return {
    platform: "win32",
    release,
    arch: arch as WindowsSystemArch,
    uptime_seconds: uptime,
    cpu_count: cpuCount,
    total_memory_bytes: totalMemory,
    free_memory_bytes: freeMemory
  };
}
