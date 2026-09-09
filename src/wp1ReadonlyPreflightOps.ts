export const WP1_READONLY_PREFLIGHT_TOOL_NAME = "ai_project_coordinator_wp1_scroll_preflight";
export const WP1_READONLY_PREFLIGHT_PROJECT_ID = "ai-project-coordinator";
export const WP1_READONLY_PREFLIGHT_OPERATION = "CHATGPT_MENU_VISIBILITY_SCROLL_ONLY";
export const WP1_READONLY_PREFLIGHT_BASELINE = "d4872a68f79d982ce50f50b77e752e1e6709202a";
export const WP1_READONLY_PREFLIGHT_REPOSITORY_ROOT = "C:\\Codex\\projects\\ai-project-coordinator";
export const WP1_READONLY_PREFLIGHT_MAX_AUTHORIZATION_MS = 10 * 60 * 1000;

export const WP1_READONLY_PREFLIGHT_INPUT_KEYS = Object.freeze([
  "task_id",
  "execution_id",
  "user_authorization_id",
  "user_authorized_at",
  "user_expires_at"
] as const);

export const WP1_READONLY_PREFLIGHT_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: true
});

export type Wp1ReadonlyPreflightReason =
  | "PREFLIGHT_READY"
  | "INVALID_REQUEST"
  | "AUTHORIZATION_BLOCKED";

export type Wp1ReadonlyPreflightInput = Readonly<{
  task_id: unknown;
  execution_id: unknown;
  user_authorization_id: unknown;
  user_authorized_at: unknown;
  user_expires_at: unknown;
}>;

export type Wp1ReadonlyPreflightResult = Readonly<{
  ready: false;
  reason: Wp1ReadonlyPreflightReason;
}>;

const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/;

function canonicalId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !CONTROL_CHAR.test(value)
  );
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function parseUtcMicros(value: unknown): bigint | null {
  if (typeof value !== "string" || !value || value !== value.trim()) return null;
  const match = UTC_TIMESTAMP.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  if (
    year < 1 || year > 9999 ||
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour < 0 || hour > 23 ||
    minute < 0 || minute > 59 ||
    second < 0 || second > 59
  ) {
    return null;
  }

  const microseconds = BigInt((fraction + "000000").slice(0, 6));
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  parsed.setUTCHours(hour, minute, second, 0);
  const epochMs = parsed.getTime();
  return Number.isSafeInteger(epochMs) ? BigInt(epochMs) * 1_000n + microseconds : null;
}

export function validateWp1ReadonlyPreflight(
  input: Wp1ReadonlyPreflightInput,
  nowMs: number = Date.now()
): Wp1ReadonlyPreflightResult {
  if (
    !input ||
    typeof input !== "object" ||
    !canonicalId(input.task_id) ||
    !canonicalId(input.execution_id) ||
    !canonicalId(input.user_authorization_id) ||
    !Number.isSafeInteger(nowMs)
  ) {
    return { ready: false, reason: "INVALID_REQUEST" };
  }

  const authorizedAtMicros = parseUtcMicros(input.user_authorized_at);
  const expiresAtMicros = parseUtcMicros(input.user_expires_at);
  if (authorizedAtMicros === null || expiresAtMicros === null) {
    return { ready: false, reason: "INVALID_REQUEST" };
  }

  // Date.now() identifies only a millisecond-wide interval. Treat its start as
  // the earliest possible current time for future-authority checks and its end
  // as the latest possible current time for expiry checks. This may block for
  // less than 1 ms, but it cannot return READY by truncating microseconds.
  const earliestNowMicros = BigInt(nowMs) * 1_000n;
  const latestNowMicros = earliestNowMicros + 999n;
  const maxAuthorizationMicros = BigInt(WP1_READONLY_PREFLIGHT_MAX_AUTHORIZATION_MS) * 1_000n;
  if (
    expiresAtMicros <= authorizedAtMicros ||
    expiresAtMicros - authorizedAtMicros > maxAuthorizationMicros ||
    earliestNowMicros < authorizedAtMicros ||
    latestNowMicros >= expiresAtMicros
  ) {
    return { ready: false, reason: "AUTHORIZATION_BLOCKED" };
  }

  return { ready: false, reason: "PREFLIGHT_READY" };
}
