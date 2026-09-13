import type { DesktopUiAction } from "./desktopUiActionModel.js";

export interface DesktopUiExecutionRuntime {
  perform(action: Readonly<DesktopUiAction>): void;
}

export interface DesktopUiExecutionResult {
  executed_count: number;
  status: "EXECUTED";
}

export function executeDesktopUiActions(
  actions: readonly DesktopUiAction[],
  runtime?: DesktopUiExecutionRuntime
): DesktopUiExecutionResult {
  if (!runtime) {
    throw new Error("Desktop UI execution requires an injected runtime.");
  }

  let executedCount = 0;
  for (const action of actions) {
    runtime.perform(action);
    executedCount += 1;
  }

  return {
    executed_count: executedCount,
    status: "EXECUTED"
  };
}
