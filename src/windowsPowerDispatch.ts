import { spawnSync } from "node:child_process";
import type { WindowsPowerPlan } from "./windowsPowerPlan.js";

export interface WindowsPowerDispatchResult {
  status: "DRY_RUN" | "DISPATCHED";
}

export interface WindowsPowerDispatchRuntime {
  spawn(
    executable: "shutdown.exe",
    args: readonly ["/s" | "/r", "/t", "0"],
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
      args: readonly ["/s" | "/r", "/t", "0"],
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
    return { status: "DRY_RUN" };
  }

  const result = runtime.spawn(
    plan.executable,
    plan.args,
    Object.freeze({
      windowsHide: true,
      stdio: "ignore",
      timeout: 5000,
      shell: false
    })
  );

  if (result.error !== undefined || result.status !== 0) {
    throw new Error("Windows power dispatch failed.");
  }

  return { status: "DISPATCHED" };
}
