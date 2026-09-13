import { spawnSync } from "node:child_process";
import type { WindowsPowerPlan } from "./windowsPowerPlan.js";

export type WindowsPowerDispatchArgs =
  | readonly ["/s" | "/r", "/t", "0"]
  | readonly ["/s" | "/r", "/t", "0", "/f"];

export interface WindowsPowerDispatchResult {
  status: "DRY_RUN" | "DISPATCHED";
  dispatch_attempts: 0 | 1 | 2;
  locked_force_fallback_used: boolean;
}

export interface WindowsPowerDispatchRuntime {
  spawn(
    executable: "shutdown.exe",
    args: WindowsPowerDispatchArgs,
    options: Readonly<{
      windowsHide: true;
      stdio: "ignore";
      timeout: 5000;
      shell: false;
    }>
  ): {
    status: number | null;
    error?: unknown;
  };
}

export const defaultWindowsPowerDispatchRuntime: WindowsPowerDispatchRuntime =
  Object.freeze({
    spawn(
      executable: "shutdown.exe",
      args: WindowsPowerDispatchArgs,
      options: Readonly<{
        windowsHide: true;
        stdio: "ignore";
        timeout: 5000;
        shell: false;
      }>
    ) {
      const result = spawnSync(executable, [...args], options);
      return {
        status: result.status,
        error: result.error
      };
    }
  });

export function dispatchWindowsPowerPlan(
  plan: WindowsPowerPlan,
  runtime: WindowsPowerDispatchRuntime = defaultWindowsPowerDispatchRuntime
): WindowsPowerDispatchResult {
  if (plan.dry_run) {
    return {
      status: "DRY_RUN",
      dispatch_attempts: 0,
      locked_force_fallback_used: false
    };
  }

  const spawnOptions = Object.freeze({
    windowsHide: true as const,
    stdio: "ignore" as const,
    timeout: 5000 as const,
    shell: false as const
  });

  const first = runtime.spawn(plan.executable, plan.args, spawnOptions);
  if (first.error !== undefined) {
    throw new Error("Windows power dispatch failed.");
  }
  if (first.status === 0) {
    return {
      status: "DISPATCHED",
      dispatch_attempts: 1,
      locked_force_fallback_used: false
    };
  }
  if (first.status !== 1271) {
    throw new Error("Windows power dispatch failed.");
  }

  const forcedArgs = [...plan.args, "/f"] as const;
  const forced = runtime.spawn(plan.executable, forcedArgs, spawnOptions);
  if (forced.error !== undefined || forced.status !== 0) {
    throw new Error("Windows locked power fallback dispatch failed.");
  }

  return {
    status: "DISPATCHED",
    dispatch_attempts: 2,
    locked_force_fallback_used: true
  };
}
