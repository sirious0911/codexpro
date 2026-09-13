export type WindowsPowerAction = "shutdown" | "reboot";

export const WINDOWS_POWER_CONFIRMATIONS = Object.freeze({
  shutdown: "SHUTDOWN_WINDOWS",
  reboot: "REBOOT_WINDOWS"
} as const);

export interface WindowsPowerPlanInput {
  action: WindowsPowerAction;
  confirm: string;
  dry_run?: boolean;
}

export interface WindowsPowerPlan {
  action: WindowsPowerAction;
  executable: "shutdown.exe";
  args: readonly ["/s" | "/r", "/t", "0"];
  confirmation: "SHUTDOWN_WINDOWS" | "REBOOT_WINDOWS";
  dry_run: boolean;
}

function validateAction(value: unknown): WindowsPowerAction {
  if (value !== "shutdown" && value !== "reboot") {
    throw new Error("Windows power action must be shutdown or reboot.");
  }
  return value;
}

export function buildWindowsPowerPlan(
  input: WindowsPowerPlanInput,
  platform: string = process.platform
): WindowsPowerPlan {
  if (platform !== "win32") {
    throw new Error("Windows power action is only available on win32.");
  }

  const action = validateAction(input.action);
  if (typeof input.confirm !== "string") {
    throw new Error("Windows power confirmation must be a string.");
  }

  const confirmation = WINDOWS_POWER_CONFIRMATIONS[action];
  if (input.confirm !== confirmation) {
    throw new Error("Windows power action requires the exact confirmation.");
  }

  if (input.dry_run !== undefined && typeof input.dry_run !== "boolean") {
    throw new Error("Windows power dry_run must be boolean when provided.");
  }

  return {
    action,
    executable: "shutdown.exe",
    args: [action === "shutdown" ? "/s" : "/r", "/t", "0"],
    confirmation,
    dry_run: input.dry_run !== false
  };
}
