import {
  validateDesktopUiActionSequence,
  type DesktopUiAction
} from "./desktopUiActionModel.js";
import {
  runWindowsDesktopUiBackend,
  type WindowsDesktopUiSpawnRuntime
} from "./windowsDesktopUiBackend.js";

export type WindowsDesktopUiLiveOperatorResult =
  | {
      action_count: number;
      actions: DesktopUiAction[];
      status: "DRY_RUN";
    }
  | {
      action_count: number;
      status: "EXECUTED";
    };

function validateInput(input: unknown): {
  actions: DesktopUiAction[];
  dry_run: boolean;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Windows desktop UI operator input must be a plain object.");
  }

  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "actions" ||
    keys[1] !== "dry_run"
  ) {
    throw new Error("Windows desktop UI operator input requires exact fields.");
  }

  if (typeof value.dry_run !== "boolean") {
    throw new Error("Windows desktop UI operator dry_run must be boolean.");
  }

  return {
    actions: validateDesktopUiActionSequence(value.actions),
    dry_run: value.dry_run
  };
}

export function runWindowsDesktopUiLiveOperator(
  input: unknown,
  options: {
    platform?: string;
    runtime?: WindowsDesktopUiSpawnRuntime;
  } = {}
): WindowsDesktopUiLiveOperatorResult {
  const validated = validateInput(input);

  if (validated.dry_run) {
    return {
      action_count: validated.actions.length,
      actions: validated.actions,
      status: "DRY_RUN"
    };
  }

  const result = runWindowsDesktopUiBackend(validated.actions, options);
  return {
    action_count: result.executed_count,
    status: result.status
  };
}

function isDirectExecution(): boolean {
  const entry = (process.argv[1] ?? "").replace(/\\/g, "/");
  if (!entry) return false;
  const moduleUrl = import.meta.url.replace(/\\/g, "/");
  return (
    (entry.endsWith("/windowsDesktopUiLiveOperator.ts") &&
      moduleUrl.endsWith("/windowsDesktopUiLiveOperator.ts")) ||
    (entry.endsWith("/windowsDesktopUiLiveOperator.js") &&
      moduleUrl.endsWith("/windowsDesktopUiLiveOperator.js"))
  );
}

function main(): void {
  try {
    const [json, ...rest] = process.argv.slice(2);
    if (!json || rest.length !== 0 || json.length > 8192) {
      throw new Error("Invalid CLI input.");
    }

    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("Invalid CLI input.");
    }

    const value = parsed as Record<string, unknown>;
    if (value.dry_run !== true) {
      throw new Error("Direct CLI is dry-run only.");
    }

    const result = runWindowsDesktopUiLiveOperator(parsed);
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
