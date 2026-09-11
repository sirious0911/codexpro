import { spawnSync } from "node:child_process";

export type WindowsPowerAction = "shutdown" | "reboot";

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
  options: WindowsPowerOptions
): WindowsPowerPlan & { status: "DRY_RUN" | "DISPATCHED" } {
  const plan = buildWindowsPowerPlan(action, options);
  if (plan.dryRun) return { ...plan, status: "DRY_RUN" };

  const result = spawnSync(plan.executable, plan.args, {
    windowsHide: true,
    stdio: "ignore",
    timeout: 5000
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`shutdown.exe returned non-zero status: ${String(result.status)}`);
  }

  return { ...plan, status: "DISPATCHED" };
}
