import {
  buildWindowsPowerPlan,
  type WindowsPowerAction,
  type WindowsPowerPlan
} from "./windowsPowerPlan.js";
import {
  dispatchWindowsPowerPlan,
  type WindowsPowerDispatchRuntime
} from "./windowsPowerDispatch.js";

export interface WindowsPowerOperatorInput {
  action: WindowsPowerAction;
  confirm: string;
  dry_run?: boolean;
}

export interface WindowsPowerOperatorResult {
  plan: WindowsPowerPlan;
  status: "DRY_RUN" | "DISPATCHED";
  dispatch_attempts: 0 | 1 | 2;
  locked_force_fallback_used: boolean;
}

function validateOperatorInput(input: unknown): WindowsPowerOperatorInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Windows power operator input must be a plain object.");
  }

  const value = input as Record<string, unknown>;
  const allowed = new Set(["action", "confirm", "dry_run"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error("Windows power operator input contains an unsupported field.");
    }
  }

  if (value.action !== "shutdown" && value.action !== "reboot") {
    throw new Error("Windows power operator action is invalid.");
  }
  if (typeof value.confirm !== "string") {
    throw new Error("Windows power operator confirm must be a string.");
  }
  if (value.dry_run !== undefined && typeof value.dry_run !== "boolean") {
    throw new Error("Windows power operator dry_run must be boolean.");
  }

  return {
    action: value.action,
    confirm: value.confirm,
    dry_run: value.dry_run
  };
}

export function runWindowsPowerOperator(
  input: unknown,
  options: {
    platform?: string;
    dispatch_runtime?: WindowsPowerDispatchRuntime;
  } = {}
): WindowsPowerOperatorResult {
  const validated = validateOperatorInput(input);
  const plan = buildWindowsPowerPlan(validated, options.platform ?? process.platform);
  const dispatched = dispatchWindowsPowerPlan(plan, options.dispatch_runtime);

  return {
    plan,
    status: dispatched.status,
    dispatch_attempts: dispatched.dispatch_attempts,
    locked_force_fallback_used: dispatched.locked_force_fallback_used
  };
}

function isDirectExecution(): boolean {
  const entry = (process.argv[1] ?? "").replace(/\\/g, "/");
  if (!entry) return false;
  const moduleUrl = import.meta.url.replace(/\\/g, "/");
  return (
    (entry.endsWith("/windowsPowerOperator.ts") &&
      moduleUrl.endsWith("/windowsPowerOperator.ts")) ||
    (entry.endsWith("/windowsPowerOperator.js") &&
      moduleUrl.endsWith("/windowsPowerOperator.js"))
  );
}

function main(): void {
  try {
    const [action, confirm, ...rest] = process.argv.slice(2);
    if (rest.length !== 0) {
      throw new Error("Unexpected CLI arguments.");
    }

    const result = runWindowsPowerOperator(
      {
        action,
        confirm,
        dry_run: true
      },
      {
        platform: process.platform
      }
    );

    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = 0;
  } catch {
    process.stdout.write("{}\n");
    process.exitCode = 2;
  }
}

if (isDirectExecution()) {
  main();
}
