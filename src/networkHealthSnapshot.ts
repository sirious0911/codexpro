import {
  probeLocalRuntime,
  type LocalRuntimeProbeResult,
  type LocalRuntimeProbeRuntime
} from "./localRuntimeProbe.js";
import {
  classifyNetworkHealth,
  type NetworkHealthClassification
} from "./networkHealthModel.js";

export interface NetworkHealthSnapshotInput {
  primary_available: boolean;
  backup_available: boolean;
}

export interface NetworkHealthSnapshot {
  probe: LocalRuntimeProbeResult;
  classification: NetworkHealthClassification;
}

function validateSnapshotInput(input: unknown): NetworkHealthSnapshotInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Network health snapshot input must be a plain object.");
  }

  const value = input as Record<string, unknown>;
  const allowed = new Set(["primary_available", "backup_available"]);

  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(
        `Network health snapshot input contains unsupported field: ${key}.`
      );
    }
  }

  if (typeof value.primary_available !== "boolean") {
    throw new Error("Network health snapshot primary_available must be boolean.");
  }
  if (typeof value.backup_available !== "boolean") {
    throw new Error("Network health snapshot backup_available must be boolean.");
  }

  return {
    primary_available: value.primary_available,
    backup_available: value.backup_available
  };
}

export async function createNetworkHealthSnapshot(
  input: unknown,
  runtime?: LocalRuntimeProbeRuntime
): Promise<NetworkHealthSnapshot> {
  const transports = validateSnapshotInput(input);
  const probe = await probeLocalRuntime(runtime);

  const classification = classifyNetworkHealth({
    runtime_healthy: probe.reachable,
    primary_available: transports.primary_available,
    backup_available: transports.backup_available
  });

  return {
    probe,
    classification
  };
}
