export const CDP_PROTOCOL_MAX_TARGET_ID_CHARS = 256;
export const CDP_PROTOCOL_MAX_METHOD_CHARS = 128;
export const CDP_PROTOCOL_MAX_MESSAGE_BYTES = 64 * 1024;
export const CDP_PROTOCOL_LOCAL_PAGE_PREFIX = "ws://127.0.0.1:9223/devtools/page/" as const;

const TARGET_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_.]*$/;

export interface CdpProtocolRequestEnvelope {
  id: number;
  method: string;
  params: Readonly<Record<string, unknown>>;
}

export interface CdpProtocolResponseEnvelope {
  id: number;
  result: unknown;
}

function serializedByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object.`);
  }
}

export function validateCdpTargetId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("CDP target id must be a string.");
  }
  if (
    value.length < 1 ||
    value.length > CDP_PROTOCOL_MAX_TARGET_ID_CHARS ||
    !TARGET_ID_PATTERN.test(value)
  ) {
    throw new Error("CDP target id is invalid or out of bounds.");
  }
  return value;
}

export function validateLocalPageDevtoolsUrl(
  value: unknown,
  expectedTargetId: unknown
): string {
  if (typeof value !== "string") {
    throw new Error("CDP devtools URL must be a string.");
  }
  const targetId = validateCdpTargetId(expectedTargetId);
  const expected = `${CDP_PROTOCOL_LOCAL_PAGE_PREFIX}${targetId}`;
  if (value !== expected) {
    throw new Error("CDP devtools URL does not match the fixed local page target.");
  }
  return value;
}

export function validateCdpRequestId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error("CDP request id must be a positive safe integer.");
  }
  return value as number;
}

export function validateCdpMethodName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("CDP method name must be a string.");
  }
  if (
    value.length < 1 ||
    value.length > CDP_PROTOCOL_MAX_METHOD_CHARS ||
    !METHOD_PATTERN.test(value)
  ) {
    throw new Error("CDP method name is invalid or out of bounds.");
  }
  return value;
}

export function serializeCdpRequestEnvelope(
  input: {
    id: unknown;
    method: unknown;
    params?: unknown;
  },
  maxMessageBytes = CDP_PROTOCOL_MAX_MESSAGE_BYTES
): string {
  const id = validateCdpRequestId(input.id);
  const method = validateCdpMethodName(input.method);
  const params = input.params ?? {};
  assertPlainRecord(params, "CDP request params");

  let serialized: string;
  try {
    serialized = JSON.stringify({ id, method, params });
  } catch {
    throw new Error("CDP request envelope is not serializable.");
  }

  if (serializedByteLength(serialized) > maxMessageBytes) {
    throw new Error("CDP request envelope exceeds the bounded message size.");
  }
  return serialized;
}

export function parseCdpResponseEnvelope(
  serialized: unknown,
  expectedRequestId: unknown,
  maxMessageBytes = CDP_PROTOCOL_MAX_MESSAGE_BYTES
): CdpProtocolResponseEnvelope {
  if (typeof serialized !== "string") {
    throw new Error("CDP response envelope must be a serialized string.");
  }
  if (serializedByteLength(serialized) > maxMessageBytes) {
    throw new Error("CDP response envelope exceeds the bounded message size.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("CDP response envelope is malformed JSON.");
  }

  assertPlainRecord(parsed, "CDP response envelope");

  const expectedId = validateCdpRequestId(expectedRequestId);
  const responseId = validateCdpRequestId(parsed.id);
  if (responseId !== expectedId) {
    throw new Error("CDP response id does not match the expected request id.");
  }

  if (Object.prototype.hasOwnProperty.call(parsed, "error")) {
    throw new Error("CDP response envelope contains an error.");
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, "result")) {
    throw new Error("CDP response envelope is missing result.");
  }

  return {
    id: responseId,
    result: parsed.result
  };
}
