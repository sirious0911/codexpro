import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { request } from "node:http";

export const DEDICATED_CHROME_CONFIRM = "START_DEDICATED_CHROME_CDP" as const;
export const DEDICATED_CHROME_EXECUTABLE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" as const;
export const DEDICATED_CHROME_PROFILE = "C:\\CoordinatorRuntime\\browser-profile" as const;
export const DEDICATED_CHROME_CDP_ADDRESS = "127.0.0.1" as const;
export const DEDICATED_CHROME_CDP_PORT = 9223 as const;
export const DEDICATED_CHROME_CDP_ENDPOINT = `http://${DEDICATED_CHROME_CDP_ADDRESS}:${DEDICATED_CHROME_CDP_PORT}` as const;
export const DEDICATED_CHROME_CDP_VERSION_PATH = "/json/version" as const;
export const DEDICATED_CHROME_CDP_PROBE_TIMEOUT_MS = 250 as const;
export const DEDICATED_CHROME_CDP_READINESS_ATTEMPTS = 20 as const;
export const DEDICATED_CHROME_CDP_READINESS_INTERVAL_MS = 150 as const;

export interface DedicatedChromeStartOptions {
  confirm: string;
  dryRun?: boolean;
}

export interface DedicatedChromeStartPlan {
  executable: typeof DEDICATED_CHROME_EXECUTABLE;
  args: readonly [
    `--user-data-dir=${typeof DEDICATED_CHROME_PROFILE}`,
    `--remote-debugging-address=${typeof DEDICATED_CHROME_CDP_ADDRESS}`,
    `--remote-debugging-port=${typeof DEDICATED_CHROME_CDP_PORT}`,
    "--no-first-run",
    "--no-default-browser-check"
  ];
  profile: typeof DEDICATED_CHROME_PROFILE;
  cdpAddress: typeof DEDICATED_CHROME_CDP_ADDRESS;
  cdpPort: typeof DEDICATED_CHROME_CDP_PORT;
  cdpEndpoint: typeof DEDICATED_CHROME_CDP_ENDPOINT;
  confirmation: typeof DEDICATED_CHROME_CONFIRM;
  dryRun: boolean;
}

export type DedicatedChromeStartStatus = "DRY_RUN" | "ALREADY_HEALTHY" | "READY";

export interface DedicatedChromeStartResult extends DedicatedChromeStartPlan {
  status: DedicatedChromeStartStatus;
  pid: number | null;
  cdpReady: boolean | null;
  launchAttempted: boolean;
  launchCount: 0 | 1;
}

export interface DedicatedChromeRuntime {
  platform: NodeJS.Platform;
  executableExists(path: string): boolean;
  probeCdp(): Promise<boolean>;
  launch(plan: DedicatedChromeStartPlan): Promise<number | null>;
  sleep(ms: number): Promise<void>;
}

export function buildDedicatedChromeStartPlan(
  options: DedicatedChromeStartOptions,
  platform: NodeJS.Platform = process.platform
): DedicatedChromeStartPlan {
  if (platform !== "win32") {
    throw new Error(`Dedicated Chrome start is only available on win32; current platform=${platform}.`);
  }
  if (options.confirm !== DEDICATED_CHROME_CONFIRM) {
    throw new Error(`Exact confirmation required: ${DEDICATED_CHROME_CONFIRM}`);
  }

  return {
    executable: DEDICATED_CHROME_EXECUTABLE,
    args: [
      `--user-data-dir=${DEDICATED_CHROME_PROFILE}`,
      `--remote-debugging-address=${DEDICATED_CHROME_CDP_ADDRESS}`,
      `--remote-debugging-port=${DEDICATED_CHROME_CDP_PORT}`,
      "--no-first-run",
      "--no-default-browser-check"
    ],
    profile: DEDICATED_CHROME_PROFILE,
    cdpAddress: DEDICATED_CHROME_CDP_ADDRESS,
    cdpPort: DEDICATED_CHROME_CDP_PORT,
    cdpEndpoint: DEDICATED_CHROME_CDP_ENDPOINT,
    confirmation: DEDICATED_CHROME_CONFIRM,
    dryRun: options.dryRun !== false
  };
}

function parseHealthyCdpVersionPayload(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { webSocketDebuggerUrl?: unknown };
    const webSocketDebuggerUrl = parsed.webSocketDebuggerUrl;
    if (typeof webSocketDebuggerUrl !== "string") return false;
    const allowedPrefixes = [
      `ws://${DEDICATED_CHROME_CDP_ADDRESS}:${DEDICATED_CHROME_CDP_PORT}/`,
      `ws://localhost:${DEDICATED_CHROME_CDP_PORT}/`
    ];
    return allowedPrefixes.some((prefix) => webSocketDebuggerUrl.startsWith(prefix));
  } catch {
    return false;
  }
}

export async function probeDedicatedChromeCdp(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = request(
      {
        host: DEDICATED_CHROME_CDP_ADDRESS,
        port: DEDICATED_CHROME_CDP_PORT,
        path: DEDICATED_CHROME_CDP_VERSION_PATH,
        method: "GET",
        timeout: DEDICATED_CHROME_CDP_PROBE_TIMEOUT_MS,
        headers: { Connection: "close" }
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          finish(false);
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        res.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.length;
          if (totalBytes > 64 * 1024) {
            res.destroy();
            finish(false);
            return;
          }
          chunks.push(buffer);
        });
        res.on("end", () => finish(parseHealthyCdpVersionPayload(Buffer.concat(chunks).toString("utf8"))));
        res.on("error", () => finish(false));
      }
    );

    req.on("timeout", () => req.destroy(new Error("Dedicated Chrome CDP probe timed out.")));
    req.on("error", () => finish(false));
    req.end();
  });
}

async function launchCanonicalDedicatedChrome(plan: DedicatedChromeStartPlan): Promise<number | null> {
  const child = spawn(plan.executable, [...plan.args], {
    detached: true,
    shell: false,
    stdio: "ignore",
    windowsHide: false
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });

  child.unref();
  return child.pid ?? null;
}

const defaultDedicatedChromeRuntime: DedicatedChromeRuntime = {
  platform: process.platform,
  executableExists: existsSync,
  probeCdp: probeDedicatedChromeCdp,
  launch: launchCanonicalDedicatedChrome,
  sleep: async (ms: number) => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
};

export class DedicatedChromeStartController {
  private actualStartAttempted = false;

  constructor(private readonly runtime: DedicatedChromeRuntime = defaultDedicatedChromeRuntime) {}

  async run(options: DedicatedChromeStartOptions): Promise<DedicatedChromeStartResult> {
    const plan = buildDedicatedChromeStartPlan(options, this.runtime.platform);
    if (plan.dryRun) {
      return {
        ...plan,
        status: "DRY_RUN",
        pid: null,
        cdpReady: null,
        launchAttempted: false,
        launchCount: 0
      };
    }

    if (await this.runtime.probeCdp()) {
      return {
        ...plan,
        status: "ALREADY_HEALTHY",
        pid: null,
        cdpReady: true,
        launchAttempted: false,
        launchCount: 0
      };
    }

    if (this.actualStartAttempted) {
      throw new Error("Dedicated Chrome start was already attempted by this CodexPro runtime; retry/duplicate launch is forbidden.");
    }
    if (!this.runtime.executableExists(plan.executable)) {
      throw new Error(`Canonical Chrome executable not found: ${plan.executable}`);
    }

    this.actualStartAttempted = true;
    let pid: number | null;
    try {
      pid = await this.runtime.launch(plan);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Dedicated Chrome launch attempt failed; automatic retry is forbidden. ${detail}`);
    }

    for (let attempt = 0; attempt < DEDICATED_CHROME_CDP_READINESS_ATTEMPTS; attempt += 1) {
      if (await this.runtime.probeCdp()) {
        return {
          ...plan,
          status: "READY",
          pid,
          cdpReady: true,
          launchAttempted: true,
          launchCount: 1
        };
      }
      if (attempt + 1 < DEDICATED_CHROME_CDP_READINESS_ATTEMPTS) {
        await this.runtime.sleep(DEDICATED_CHROME_CDP_READINESS_INTERVAL_MS);
      }
    }

    throw new Error(
      `Dedicated Chrome was launched exactly once but loopback CDP did not become ready at ${plan.cdpEndpoint}${DEDICATED_CHROME_CDP_VERSION_PATH}; automatic retry is forbidden.`
    );
  }
}

const dedicatedChromeStartController = new DedicatedChromeStartController();

export async function runDedicatedChromeStart(options: DedicatedChromeStartOptions): Promise<DedicatedChromeStartResult> {
  return await dedicatedChromeStartController.run(options);
}
