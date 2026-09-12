import { pathToFileURL } from "node:url";
import {
  defaultLocalRuntimeProbeRuntime,
  probeLocalRuntime,
  type LocalRuntimeProbeResult,
  type LocalRuntimeProbeRuntime
} from "./localRuntimeProbe.js";

export interface LocalRuntimeProbeOperatorResult {
  payload: LocalRuntimeProbeResult;
  exit_code: 0 | 2;
}

export async function runLocalRuntimeProbeOperator(
  runtime: LocalRuntimeProbeRuntime = defaultLocalRuntimeProbeRuntime
): Promise<LocalRuntimeProbeOperatorResult> {
  const payload = await probeLocalRuntime(runtime);

  return {
    payload,
    exit_code: payload.reason === "CONNECTED" ? 0 : 2
  };
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;

  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  try {
    const result = await runLocalRuntimeProbeOperator();
    process.stdout.write(JSON.stringify(result.payload) + "\n");
    process.exitCode = result.exit_code;
  } catch {
    process.stdout.write(
      JSON.stringify({
        reachable: false,
        reason: "UNREACHABLE"
      }) + "\n"
    );
    process.exitCode = 2;
  }
}

if (isDirectExecution()) {
  void main();
}
