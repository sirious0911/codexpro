import assert from "node:assert/strict";
import {
  WINDOWS_SYSTEM_ARCHES,
  WINDOWS_SYSTEM_RELEASE_MAX_CHARS,
  createWindowsSystemSnapshot
} from "../src/windowsSystemSnapshot.ts";
import {
  runWindowsSystemSnapshotOperator
} from "../src/windowsSystemSnapshotOperator.ts";

function runtime(overrides = {}) {
  return {
    platform: () => "win32",
    release: () => "10.0.26100",
    arch: () => "x64",
    uptime: () => 12345.5,
    cpuCount: () => 8,
    totalMemory: () => 34_359_738_368,
    freeMemory: () => 12_884_901_888,
    ...overrides
  };
}

assert.deepEqual(WINDOWS_SYSTEM_ARCHES, ["x64", "arm64", "ia32"]);

const expected = {
  platform: "win32",
  release: "10.0.26100",
  arch: "x64",
  uptime_seconds: 12345.5,
  cpu_count: 8,
  total_memory_bytes: 34_359_738_368,
  free_memory_bytes: 12_884_901_888
};

assert.deepEqual(createWindowsSystemSnapshot(runtime()), expected);
assert.deepEqual(runWindowsSystemSnapshotOperator(runtime()), {
  payload: expected,
  exit_code: 0
});

for (const arch of WINDOWS_SYSTEM_ARCHES) {
  assert.equal(
    createWindowsSystemSnapshot(runtime({ arch: () => arch })).arch,
    arch
  );
}

for (const badRuntime of [
  runtime({ platform: () => "linux" }),
  runtime({ release: () => "" }),
  runtime({ release: () => "x".repeat(WINDOWS_SYSTEM_RELEASE_MAX_CHARS + 1) }),
  runtime({ release: () => "bad\nrelease" }),
  runtime({ arch: () => "mips" }),
  runtime({ uptime: () => -1 }),
  runtime({ uptime: () => Number.NaN }),
  runtime({ uptime: () => Number.POSITIVE_INFINITY }),
  runtime({ cpuCount: () => 0 }),
  runtime({ cpuCount: () => 4097 }),
  runtime({ cpuCount: () => 1.5 }),
  runtime({ totalMemory: () => -1 }),
  runtime({ totalMemory: () => Number.MAX_SAFE_INTEGER + 1 }),
  runtime({ freeMemory: () => -1 }),
  runtime({ freeMemory: () => Number.MAX_SAFE_INTEGER + 1 }),
  runtime({
    totalMemory: () => 1024,
    freeMemory: () => 2048
  })
]) {
  assert.throws(() => createWindowsSystemSnapshot(badRuntime));
}

let reads = 0;
const countingRuntime = {
  platform: () => {
    reads += 1;
    return "win32";
  },
  release: () => {
    reads += 1;
    return "10.0";
  },
  arch: () => {
    reads += 1;
    return "arm64";
  },
  uptime: () => {
    reads += 1;
    return 0;
  },
  cpuCount: () => {
    reads += 1;
    return 1;
  },
  totalMemory: () => {
    reads += 1;
    return 0;
  },
  freeMemory: () => {
    reads += 1;
    return 0;
  }
};

assert.equal(reads, 0);
const counted = runWindowsSystemSnapshotOperator(countingRuntime);
assert.equal(reads, 7);
assert.equal(JSON.stringify(counted.payload).length < 512, true);

console.log("windows-system-snapshot-smoke: PASS");
