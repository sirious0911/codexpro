import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  validateDesktopUiActionSequence,
  type DesktopUiAction
} from "./desktopUiActionModel.js";

export const WINDOWS_DESKTOP_UI_POWERSHELL =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" as const;
export const WINDOWS_DESKTOP_UI_MAX_STDIN_BYTES = 8192;
export const WINDOWS_DESKTOP_UI_TIMEOUT_MS = 5000 as const;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const WINDOWS_DESKTOP_UI_DRIVER_PATH = resolve(
  MODULE_DIR,
  "..",
  "scripts",
  "windows-desktop-ui-driver.ps1"
);

export interface WindowsDesktopUiBackendResult {
  executed_count: number;
  status: "EXECUTED";
}

export interface WindowsDesktopUiSpawnRuntime {
  spawn(
    executable: typeof WINDOWS_DESKTOP_UI_POWERSHELL,
    args: readonly [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      string
    ],
    options: Readonly<{
      input: string;
      encoding: "utf8";
      windowsHide: true;
      shell: false;
      timeout: 5000;
      stdio: readonly ["pipe", "ignore", "ignore"];
    }>
  ): {
    status: number | null;
    error?: unknown;
  };
}

export const defaultWindowsDesktopUiSpawnRuntime: WindowsDesktopUiSpawnRuntime =
  Object.freeze({
    spawn(
      executable: typeof WINDOWS_DESKTOP_UI_POWERSHELL,
      args: readonly [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        string
      ],
      options: Readonly<{
        input: string;
        encoding: "utf8";
        windowsHide: true;
        shell: false;
        timeout: 5000;
        stdio: readonly ["pipe", "ignore", "ignore"];
      }>
    ) {
      const result = spawnSync(executable, [...args], {
        input: options.input,
        encoding: options.encoding,
        windowsHide: options.windowsHide,
        shell: options.shell,
        timeout: options.timeout,
        stdio: [...options.stdio]
      });

      return {
        status: result.status,
        error: result.error
      };
    }
  });

export function runWindowsDesktopUiBackend(
  input: readonly DesktopUiAction[],
  options: {
    platform?: string;
    runtime?: WindowsDesktopUiSpawnRuntime;
  } = {}
): WindowsDesktopUiBackendResult {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("Windows desktop UI backend requires win32.");
  }

  const actions = validateDesktopUiActionSequence(input);
  const serialized = JSON.stringify(actions);
  const stdinBytes = Buffer.byteLength(serialized, "utf8");

  if (
    stdinBytes < 2 ||
    stdinBytes > WINDOWS_DESKTOP_UI_MAX_STDIN_BYTES
  ) {
    throw new Error("Windows desktop UI action payload is out of bounds.");
  }

  const runtime = options.runtime ?? defaultWindowsDesktopUiSpawnRuntime;
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-File",
    WINDOWS_DESKTOP_UI_DRIVER_PATH
  ] as const;

  const result = runtime.spawn(
    WINDOWS_DESKTOP_UI_POWERSHELL,
    args,
    Object.freeze({
      input: serialized,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: WINDOWS_DESKTOP_UI_TIMEOUT_MS,
      stdio: ["pipe", "ignore", "ignore"] as const
    })
  );

  if (result.error !== undefined || result.status !== 0) {
    throw new Error("Windows desktop UI backend dispatch failed.");
  }

  return {
    executed_count: actions.length,
    status: "EXECUTED"
  };
}
