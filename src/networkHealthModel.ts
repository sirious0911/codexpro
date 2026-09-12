export const NETWORK_HEALTH_CLASSIFICATIONS = [
  "HEALTHY_DUAL",
  "PRIMARY_DEGRADED_BACKUP_AVAILABLE",
  "BACKUP_DEGRADED_PRIMARY_AVAILABLE",
  "TRANSPORTS_DOWN_RUNTIME_HEALTHY",
  "RUNTIME_FAILURE"
] as const;

export type NetworkHealthClassification =
  (typeof NETWORK_HEALTH_CLASSIFICATIONS)[number];

export interface NetworkHealthState {
  runtime_healthy: boolean;
  primary_available: boolean;
  backup_available: boolean;
}

function assertBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Network health field ${field} must be boolean.`);
  }
}

export function classifyNetworkHealth(input: unknown): NetworkHealthClassification {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Network health state must be a plain object.");
  }

  const state = input as Record<string, unknown>;
  const allowedKeys = new Set([
    "runtime_healthy",
    "primary_available",
    "backup_available"
  ]);

  for (const key of Object.keys(state)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Network health state contains unsupported field: ${key}.`);
    }
  }

  assertBoolean(state.runtime_healthy, "runtime_healthy");
  assertBoolean(state.primary_available, "primary_available");
  assertBoolean(state.backup_available, "backup_available");

  const runtimeHealthy = state.runtime_healthy;
  const primaryAvailable = state.primary_available;
  const backupAvailable = state.backup_available;

  if (!runtimeHealthy) {
    if (primaryAvailable || backupAvailable) {
      throw new Error(
        "Network health state is ambiguous: a transport cannot be available when runtime is unhealthy."
      );
    }
    return "RUNTIME_FAILURE";
  }

  if (primaryAvailable && backupAvailable) {
    return "HEALTHY_DUAL";
  }

  if (!primaryAvailable && backupAvailable) {
    return "PRIMARY_DEGRADED_BACKUP_AVAILABLE";
  }

  if (primaryAvailable && !backupAvailable) {
    return "BACKUP_DEGRADED_PRIMARY_AVAILABLE";
  }

  if (!primaryAvailable && !backupAvailable) {
    return "TRANSPORTS_DOWN_RUNTIME_HEALTHY";
  }

  throw new Error("Network health state could not be classified.");
}
