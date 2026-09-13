import type { ToolMode } from "./config.js";

export type LocalCapabilityMode = "off" | "read" | "full";

export const LOCAL_CAPABILITY_TOOL_NAMES = [
  "local_runtime_probe",
  "windows_system_snapshot",
  "windows_power_action",
  "windows_desktop_ui"
] as const;

export type LocalCapabilityToolName =
  (typeof LOCAL_CAPABILITY_TOOL_NAMES)[number];

export const LOCAL_CAPABILITY_DIRECT_ONLY_TOOL_NAMES =
  LOCAL_CAPABILITY_TOOL_NAMES;

export const LOCAL_CAPABILITY_READ_TOOL_NAMES = [
  "local_runtime_probe",
  "windows_system_snapshot"
] as const satisfies readonly LocalCapabilityToolName[];

export const LOCAL_CAPABILITY_TOOL_ANNOTATIONS = Object.freeze({
  local_runtime_probe: Object.freeze({
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false
  }),
  windows_system_snapshot: Object.freeze({
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false
  }),
  windows_power_action: Object.freeze({
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: true,
    idempotentHint: false
  }),
  windows_desktop_ui: Object.freeze({
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: true,
    idempotentHint: false
  })
} as const);

export function localCapabilityModeFrom(
  value: string | undefined
): LocalCapabilityMode {
  if (value === "read" || value === "full") return value;
  return "off";
}

export function isLocalCapabilityToolName(
  value: string
): value is LocalCapabilityToolName {
  return (LOCAL_CAPABILITY_TOOL_NAMES as readonly string[]).includes(value);
}

export function localCapabilityToolNamesForPolicy(input: {
  toolMode: ToolMode;
  localCapabilityMode: LocalCapabilityMode;
  connectionTest: boolean;
}): LocalCapabilityToolName[] {
  if (input.connectionTest || input.toolMode !== "full") return [];

  if (input.localCapabilityMode === "read") {
    return [...LOCAL_CAPABILITY_READ_TOOL_NAMES];
  }
  if (input.localCapabilityMode === "full") {
    return [...LOCAL_CAPABILITY_TOOL_NAMES];
  }
  return [];
}

export function localCapabilityToolEnabled(
  input: {
    toolMode: ToolMode;
    localCapabilityMode: LocalCapabilityMode;
    connectionTest: boolean;
  },
  name: LocalCapabilityToolName
): boolean {
  return localCapabilityToolNamesForPolicy(input).includes(name);
}
