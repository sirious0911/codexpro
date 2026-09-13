import { spawnSync } from "node:child_process";

export type WindowsPowerAction = "shutdown" | "reboot";
export type WindowsPowerArgs =
  | ["/s" | "/r", "/t", "0"]
  | ["/s" | "/r", "/t", "0", "/f"];

export const WINDOWS_POWER_CONFIRM = Object.freeze({
  shutdown: "SHUTDOWN_WINDOWS",
  reboot: "REBOOT_WINDOWS"
} as const);

export interface WindowsPowerOptions {
  confirm: string;
  dryRun?: boolean;
}

export interface WindowsPowerPlan {
  action: WindowsPowerAction;
  executable: "shutdown.exe";
  args: ["/s" | "/r", "/t", "0"];
  confirmation: string;
  dryRun: boolean;
}

export interface WindowsPowerRuntime {
  spawn(
    executable: "shutdown.exe",
    args: WindowsPowerArgs,
    options: Readonly<{
      windowsHide: true;
      stdio: "ignore";
      timeout: 5000;
    }>
  ): {
    status: number | null;
    error?: unknown;
  };
}

export const defaultWindowsPowerRuntime: WindowsPowerRuntime = Object.freeze({
  spawn(
    executable: "shutdown.exe",
    args: WindowsPowerArgs,
    options: Readonly<{
      windowsHide: true;
      stdio: "ignore";
      timeout: 5000;
    }>
  ) {
    const result = spawnSync(executable, args, options);
    return {
      status: result.status,
      error: result.error
    };
  }
});

export function buildWindowsPowerPlan(
  action: WindowsPowerAction,
  options: WindowsPowerOptions,
  platform: NodeJS.Platform = process.platform
): WindowsPowerPlan {
  if (platform !== "win32") {
    throw new Error(`Windows power action is only available on win32; current platform=${platform}.`);
  }

  const confirmation = WINDOWS_POWER_CONFIRM[action];
  if (options.confirm !== confirmation) {
    throw new Error(`Exact confirmation required: ${confirmation}`);
  }

  return {
    action,
    executable: "shutdown.exe",
    args: [action === "shutdown" ? "/s" : "/r", "/t", "0"],
    confirmation,
    dryRun: options.dryRun !== false
  };
}

export function runWindowsPowerAction(
  action: WindowsPowerAction,
  options: WindowsPowerOptions,
  runtime: WindowsPowerRuntime = defaultWindowsPowerRuntime
): WindowsPowerPlan & {
  status: "DRY_RUN" | "DISPATCHED";
  dispatchAttempts: 0 | 1 | 2;
  lockedForceFallbackUsed: boolean;
} {
  const plan = buildWindowsPowerPlan(action, options);
  if (plan.dryRun) {
    return {
      ...plan,
      status: "DRY_RUN",
      dispatchAttempts: 0,
      lockedForceFallbackUsed: false
    };
  }

  const spawnOptions = Object.freeze({
    windowsHide: true as const,
    stdio: "ignore" as const,
    timeout: 5000 as const
  });

  const first = runtime.spawn(plan.executable, plan.args, spawnOptions);
  if (first.error !== undefined) throw first.error;
  if (first.status === 0) {
    return {
      ...plan,
      status: "DISPATCHED",
      dispatchAttempts: 1,
      lockedForceFallbackUsed: false
    };
  }

  if (first.status !== 1271) {
    throw new Error(`shutdown.exe returned non-zero status: ${String(first.status)}`);
  }

  const forcedArgs: WindowsPowerArgs = [...plan.args, "/f"];
  const forced = runtime.spawn(plan.executable, forcedArgs, spawnOptions);
  if (forced.error !== undefined) throw forced.error;
  if (forced.status !== 0) {
    throw new Error(`shutdown.exe locked-force fallback returned non-zero status: ${String(forced.status)}`);
  }

  return {
    ...plan,
    status: "DISPATCHED",
    dispatchAttempts: 2,
    lockedForceFallbackUsed: true
  };
}
