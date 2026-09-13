import assert from "node:assert/strict";
import {
  WINDOWS_DESKTOP_UI_DRIVER_PATH,
  WINDOWS_DESKTOP_UI_MAX_STDIN_BYTES,
  WINDOWS_DESKTOP_UI_POWERSHELL,
  runWindowsDesktopUiBackend
} from "../src/windowsDesktopUiBackend.ts";
import {
  runWindowsDesktopUiLiveOperator
} from "../src/windowsDesktopUiLiveOperator.ts";

const actions = [
  {
    type: "POINTER_MOVE",
    x: 123,
    y: 456
  },
  {
    type: "POINTER_CLICK",
    button: "left"
  },
  {
    type: "KEY_PRESS",
    key: "TAB"
  },
  {
    type: "TYPE_TEXT",
    text: "Synthetic only"
  }
];

{
  let calls = 0;

  const result = runWindowsDesktopUiBackend(actions, {
    platform: "win32",
    runtime: {
      spawn: (executable, args, options) => {
        calls += 1;
        assert.equal(executable, WINDOWS_DESKTOP_UI_POWERSHELL);
        assert.deepEqual(args.slice(0, 4), [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File"
        ]);
        assert.equal(args.length, 5);
        assert.equal(args[4], WINDOWS_DESKTOP_UI_DRIVER_PATH);
        assert.deepEqual(JSON.parse(options.input), actions);
        assert.equal(
          Buffer.byteLength(options.input, "utf8") <=
            WINDOWS_DESKTOP_UI_MAX_STDIN_BYTES,
          true
        );
        assert.deepEqual(
          {
            encoding: options.encoding,
            windowsHide: options.windowsHide,
            shell: options.shell,
            timeout: options.timeout,
            stdio: options.stdio
          },
          {
            encoding: "utf8",
            windowsHide: true,
            shell: false,
            timeout: 5000,
            stdio: ["pipe", "ignore", "ignore"]
          }
        );

        return { status: 0 };
      }
    }
  });

  assert.equal(calls, 1);
  assert.deepEqual(result, {
    executed_count: 4,
    status: "EXECUTED"
  });
}

{
  let calls = 0;
  assert.deepEqual(
    runWindowsDesktopUiLiveOperator({
      actions,
      dry_run: true
    }, {
      platform: "win32",
      runtime: {
        spawn: () => {
          calls += 1;
          throw new Error("dry-run must not spawn");
        }
      }
    }),
    {
      action_count: 4,
      actions,
      status: "DRY_RUN"
    }
  );
  assert.equal(calls, 0);
}

{
  let calls = 0;
  const result = runWindowsDesktopUiLiveOperator(
    {
      actions,
      dry_run: false
    },
    {
      platform: "win32",
      runtime: {
        spawn: () => {
          calls += 1;
          return { status: 0 };
        }
      }
    }
  );

  assert.equal(calls, 1);
  assert.deepEqual(result, {
    action_count: 4,
    status: "EXECUTED"
  });
}

assert.throws(
  () =>
    runWindowsDesktopUiBackend(actions, {
      platform: "linux",
      runtime: {
        spawn: () => {
          throw new Error("must not spawn");
        }
      }
    }),
  /win32/
);

assert.throws(
  () =>
    runWindowsDesktopUiBackend(actions, {
      platform: "win32",
      runtime: {
        spawn: () => ({ status: 1 })
      }
    }),
  /dispatch failed/
);

assert.throws(
  () =>
    runWindowsDesktopUiBackend(actions, {
      platform: "win32",
      runtime: {
        spawn: () => ({
          status: null,
          error: new Error("synthetic")
        })
      }
    }),
  /dispatch failed/
);

for (const invalid of [
  null,
  [],
  { actions },
  { actions, dry_run: "true" },
  { actions, dry_run: true, extra: false }
]) {
  assert.throws(() => runWindowsDesktopUiLiveOperator(invalid));
}

console.log("windows-desktop-ui-backend-smoke: PASS");
