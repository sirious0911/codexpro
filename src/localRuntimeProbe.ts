import { connect } from "node:net";

export const LOCAL_RUNTIME_HOST = "127.0.0.1" as const;
export const LOCAL_RUNTIME_PORT = 8787 as const;
export const LOCAL_RUNTIME_TIMEOUT_MS = 750 as const;

export const LOCAL_RUNTIME_PROBE_REASONS = [
  "CONNECTED",
  "REFUSED",
  "TIMEOUT",
  "UNREACHABLE"
] as const;

export type LocalRuntimeProbeReason =
  (typeof LOCAL_RUNTIME_PROBE_REASONS)[number];

export interface LocalRuntimeProbeSpec {
  host: typeof LOCAL_RUNTIME_HOST;
  port: typeof LOCAL_RUNTIME_PORT;
  timeout_ms: typeof LOCAL_RUNTIME_TIMEOUT_MS;
}

export interface LocalRuntimeProbeResult {
  reachable: boolean;
  reason: LocalRuntimeProbeReason;
}

export interface LocalRuntimeProbeRuntime {
  attempt(spec: Readonly<LocalRuntimeProbeSpec>): Promise<LocalRuntimeProbeReason>;
}

export function createLocalRuntimeProbeSpec(): LocalRuntimeProbeSpec {
  return {
    host: LOCAL_RUNTIME_HOST,
    port: LOCAL_RUNTIME_PORT,
    timeout_ms: LOCAL_RUNTIME_TIMEOUT_MS
  };
}

function defaultAttempt(
  spec: Readonly<LocalRuntimeProbeSpec>
): Promise<LocalRuntimeProbeReason> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason: LocalRuntimeProbeReason) => {
      if (settled) return;
      settled = true;
      resolve(reason);
    };

    const socket = connect({
      host: spec.host,
      port: spec.port
    });

    socket.setTimeout(spec.timeout_ms);

    socket.once("connect", () => {
      socket.destroy();
      finish("CONNECTED");
    });

    socket.once("timeout", () => {
      socket.destroy();
      finish("TIMEOUT");
    });

    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      finish(error.code === "ECONNREFUSED" ? "REFUSED" : "UNREACHABLE");
    });
  });
}

export const defaultLocalRuntimeProbeRuntime: LocalRuntimeProbeRuntime =
  Object.freeze({
    attempt: defaultAttempt
  });

export async function probeLocalRuntime(
  runtime: LocalRuntimeProbeRuntime = defaultLocalRuntimeProbeRuntime
): Promise<LocalRuntimeProbeResult> {
  const reason = await runtime.attempt(
    Object.freeze(createLocalRuntimeProbeSpec())
  );

  if (!(LOCAL_RUNTIME_PROBE_REASONS as readonly string[]).includes(reason)) {
    throw new Error("Local runtime probe returned an invalid reason.");
  }

  return {
    reachable: reason === "CONNECTED",
    reason
  };
}
