import {
  CDP_READONLY_ENDPOINT,
  CDP_READONLY_LIST_PATH,
  CDP_READONLY_VERSION_PATH,
  requestCdpReadonlyJson,
  type CdpReadonlyHttpRuntime
} from "./cdpClient.js";

const TARGET_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const TARGET_TYPE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_TARGETS = 256;

export interface CdpReadonlyStatus {
  ready: true;
  endpoint: typeof CDP_READONLY_ENDPOINT;
}

export interface CdpReadonlyTargetSummary {
  target_id: string;
  type: string;
}

export interface CdpReadonlyTargetInventory {
  target_count: number;
  targets: CdpReadonlyTargetSummary[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeTarget(value: unknown): CdpReadonlyTargetSummary | null {
  if (!isRecord(value)) return null;

  const id = value.id;
  const type = value.type;
  if (typeof id !== "string" || typeof type !== "string") return null;
  if (!TARGET_ID_PATTERN.test(id) || !TARGET_TYPE_PATTERN.test(type)) return null;

  return {
    target_id: id,
    type
  };
}

export async function getCdpReadonlyStatus(
  runtime?: CdpReadonlyHttpRuntime
): Promise<CdpReadonlyStatus> {
  const payload = await requestCdpReadonlyJson(CDP_READONLY_VERSION_PATH, runtime);
  if (!isRecord(payload)) {
    throw new Error("CDP version endpoint returned an invalid payload.");
  }

  return {
    ready: true,
    endpoint: CDP_READONLY_ENDPOINT
  };
}

export async function listCdpReadonlyTargets(
  runtime?: CdpReadonlyHttpRuntime
): Promise<CdpReadonlyTargetInventory> {
  const payload = await requestCdpReadonlyJson(CDP_READONLY_LIST_PATH, runtime);
  if (!Array.isArray(payload)) {
    throw new Error("CDP target list endpoint returned an invalid payload.");
  }
  if (payload.length > MAX_TARGETS) {
    throw new Error(`CDP target list exceeded the bounded limit of ${MAX_TARGETS} entries.`);
  }

  const targets = payload
    .map(sanitizeTarget)
    .filter((target): target is CdpReadonlyTargetSummary => target !== null);

  return {
    target_count: targets.length,
    targets
  };
}
