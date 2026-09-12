import {
  createWindowsSystemSnapshot,
  type WindowsSystemSnapshot,
  type WindowsSystemSnapshotRuntime
} from "./windowsSystemSnapshot.js";

export interface WindowsSystemSnapshotOperatorResult {
  payload: WindowsSystemSnapshot;
  exit_code: 0;
}

export function runWindowsSystemSnapshotOperator(
  runtime?: WindowsSystemSnapshotRuntime
): WindowsSystemSnapshotOperatorResult {
  return {
    payload: createWindowsSystemSnapshot(runtime),
    exit_code: 0
  };
}

function isDirectExecution(): boolean {
  const entry = (process.argv[1] ?? "").replace(/\\/g, "/");
  if (!entry) return false;
  const moduleUrl = import.meta.url.replace(/\\/g, "/");
  return (
    (entry.endsWith("/windowsSystemSnapshotOperator.ts") &&
      moduleUrl.endsWith("/windowsSystemSnapshotOperator.ts")) ||
    (entry.endsWith("/windowsSystemSnapshotOperator.js") &&
      moduleUrl.endsWith("/windowsSystemSnapshotOperator.js"))
  );
}

function main(): void {
  try {
    const result = runWindowsSystemSnapshotOperator();
    process.stdout.write(JSON.stringify(result.payload) + "\n");
    process.exitCode = 0;
  } catch {
    process.stdout.write("{}\n");
    process.exitCode = 2;
  }
}

if (isDirectExecution()) {
  main();
}
