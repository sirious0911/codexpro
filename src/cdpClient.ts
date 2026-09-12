import { request } from "node:http";

export const CDP_READONLY_HOST = "127.0.0.1" as const;
export const CDP_READONLY_PORT = 9223 as const;
export const CDP_READONLY_ENDPOINT = `http://${CDP_READONLY_HOST}:${CDP_READONLY_PORT}` as const;
export const CDP_READONLY_VERSION_PATH = "/json/version" as const;
export const CDP_READONLY_LIST_PATH = "/json/list" as const;
export const CDP_READONLY_TIMEOUT_MS = 750 as const;
export const CDP_READONLY_MAX_RESPONSE_BYTES = 128 * 1024;

export type CdpReadonlyPath =
  | typeof CDP_READONLY_VERSION_PATH
  | typeof CDP_READONLY_LIST_PATH;

const ALLOWED_PATHS = new Set<string>([
  CDP_READONLY_VERSION_PATH,
  CDP_READONLY_LIST_PATH
]);

export interface CdpReadonlyRequestSpec {
  host: typeof CDP_READONLY_HOST;
  port: typeof CDP_READONLY_PORT;
  path: CdpReadonlyPath;
  method: "GET";
  timeoutMs: typeof CDP_READONLY_TIMEOUT_MS;
  maxResponseBytes: number;
}

export interface CdpReadonlyHttpResponse {
  statusCode: number;
  body: string;
}

export interface CdpReadonlyHttpRuntime {
  request(spec: Readonly<CdpReadonlyRequestSpec>): Promise<CdpReadonlyHttpResponse>;
}

export function buildCdpReadonlyRequestSpec(path: CdpReadonlyPath): CdpReadonlyRequestSpec {
  if (!ALLOWED_PATHS.has(path)) {
    throw new Error(`CDP read-only path is not allowed: ${String(path)}`);
  }

  return {
    host: CDP_READONLY_HOST,
    port: CDP_READONLY_PORT,
    path,
    method: "GET",
    timeoutMs: CDP_READONLY_TIMEOUT_MS,
    maxResponseBytes: CDP_READONLY_MAX_RESPONSE_BYTES
  };
}

function defaultRequest(spec: Readonly<CdpReadonlyRequestSpec>): Promise<CdpReadonlyHttpResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const finishResolve = (response: CdpReadonlyHttpResponse) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

    const req = request(
      {
        host: spec.host,
        port: spec.port,
        path: spec.path,
        method: spec.method,
        timeout: spec.timeoutMs,
        headers: {
          Accept: "application/json",
          Connection: "close"
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;

        res.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.length;
          if (totalBytes > spec.maxResponseBytes) {
            res.destroy(new Error(`CDP read-only response exceeded ${spec.maxResponseBytes} bytes.`));
            return;
          }
          chunks.push(buffer);
        });
        res.on("end", () => {
          finishResolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
        res.on("error", (error) => finishReject(error));
      }
    );

    req.on("timeout", () => req.destroy(new Error("CDP read-only request timed out.")));
    req.on("error", (error) => finishReject(error));
    req.end();
  });
}

export const defaultCdpReadonlyHttpRuntime: CdpReadonlyHttpRuntime = Object.freeze({
  request: defaultRequest
});

export async function requestCdpReadonlyJson(
  path: CdpReadonlyPath,
  runtime: CdpReadonlyHttpRuntime = defaultCdpReadonlyHttpRuntime
): Promise<unknown> {
  const spec = buildCdpReadonlyRequestSpec(path);
  const response = await runtime.request(Object.freeze({ ...spec }));

  if (response.statusCode !== 200) {
    throw new Error(`CDP read-only request returned HTTP ${response.statusCode}; redirects and non-200 responses are forbidden.`);
  }

  if (Buffer.byteLength(response.body, "utf8") > spec.maxResponseBytes) {
    throw new Error(`CDP read-only response exceeded ${spec.maxResponseBytes} bytes.`);
  }

  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw new Error("CDP read-only response was not valid JSON.");
  }
}
