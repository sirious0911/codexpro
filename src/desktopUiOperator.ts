import {
  validateDesktopUiActionSequence,
  type DesktopUiAction
} from "./desktopUiActionModel.js";

export interface DesktopUiOperatorInput {
  actions: unknown;
  dry_run?: boolean;
}

export interface DesktopUiOperatorResult {
  action_count: number;
  actions: DesktopUiAction[];
  status: "DRY_RUN";
}

function validateOperatorInput(input: unknown): DesktopUiOperatorInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Desktop UI operator input must be a plain object.");
  }

  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const allowed =
    value.dry_run === undefined ? ["actions"] : ["actions", "dry_run"];

  if (
    keys.length !== allowed.length ||
    keys.some((key, index) => key !== [...allowed].sort()[index])
  ) {
    throw new Error("Desktop UI operator input contains unsupported fields.");
  }

  if (value.dry_run !== undefined && typeof value.dry_run !== "boolean") {
    throw new Error("Desktop UI operator dry_run must be boolean.");
  }

  if (value.dry_run === false) {
    throw new Error("Desktop UI operator supports dry-run only.");
  }

  return {
    actions: value.actions,
    dry_run: value.dry_run as boolean | undefined
  };
}

export function runDesktopUiOperator(input: unknown): DesktopUiOperatorResult {
  const validated = validateOperatorInput(input);
  const actions = validateDesktopUiActionSequence(validated.actions);

  return {
    action_count: actions.length,
    actions,
    status: "DRY_RUN"
  };
}
