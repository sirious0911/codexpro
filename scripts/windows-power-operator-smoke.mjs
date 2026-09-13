import assert from "node:assert/strict";
import {
  WINDOWS_POWER_CONFIRMATIONS,
  buildWindowsPowerPlan
} from "../src/windowsPowerPlan.ts";
import {
  dispatchWindowsPowerPlan
} from "../src/windowsPowerDispatch.ts";
import {
  runWindowsPowerOperator
} from "../src/windowsPowerOperator.ts";

assert.deepEqual(WINDOWS_POWER_CONFIRMATIONS, {
  shutdown: "SHUTDOWN_WINDOWS",
  reboot: "REBOOT_WINDOWS"
});

const shutdownPlan = buildWindowsPowerPlan(
  {
    action: "shutdown",
    confirm: "SHUTDOWN_WINDOWS"
  },
  "win32"
);
assert.deepEqual(shutdownPlan, {
  action: "shutdown",
  executable: "shutdown.exe",
  args: ["/s", "/t", "0"],
  confirmation: "SHUTDOWN_WINDOWS",
  dry_run: true
});

const rebootPlan = buildWindowsPowerPlan(
  {
    action: "reboot",
    confirm: "REBOOT_WINDOWS"
  },
  "win32"
);
assert.deepEqual(rebootPlan, {
  action: "reboot",
  executable: "shutdown.exe",
  args: ["/r", "/t", "0"],
  confirmation: "REBOOT_WINDOWS",
  dry_run: true
});

assert.deepEqual(dispatchWindowsPowerPlan(shutdownPlan, {
  spawn: () => {
    throw new Error("dry-run must not dispatch");
  }
}), {
  status: "DRY_RUN"
});

assert.throws(
  () =>
    buildWindowsPowerPlan(
      {
        action: "shutdown",
        confirm: "WRONG"
      },
      "win32"
    ),
  /exact confirmation/
);

assert.throws(
  () =>
    buildWindowsPowerPlan(
      {
        action: "reboot",
        confirm: "REBOOT_WINDOWS"
      },
      "linux"
    ),
  /win32/
);

{
  let calls = 0;
  const result = runWindowsPowerOperator(
    {
      action: "shutdown",
      confirm: "SHUTDOWN_WINDOWS",
      dry_run: false
    },
    {
      platform: "win32",
      dispatch_runtime: {
        spawn: (executable, args, options) => {
          calls += 1;
          assert.equal(executable, "shutdown.exe");
          assert.deepEqual(args, ["/s", "/t", "0"]);
          assert.deepEqual(options, {
            windowsHide: true,
            stdio: "ignore",
            timeout: 5000,
            shell: false
          });
          return { status: 0 };
        }
      }
    }
  );

  assert.equal(calls, 1);
  assert.equal(result.status, "DISPATCHED");
  assert.equal(result.plan.dry_run, false);
}

{
  let calls = 0;
  assert.throws(
    () =>
      runWindowsPowerOperator(
        {
          action: "reboot",
          confirm: "REBOOT_WINDOWS",
          dry_run: false
        },
        {
          platform: "win32",
          dispatch_runtime: {
            spawn: () => {
              calls += 1;
              return { status: 1 };
            }
          }
        }
      ),
    /dispatch failed/
  );
  assert.equal(calls, 1);
}

{
  let calls = 0;
  assert.throws(
    () =>
      runWindowsPowerOperator(
        {
          action: "reboot",
          confirm: "REBOOT_WINDOWS",
          dry_run: false
        },
        {
          platform: "win32",
          dispatch_runtime: {
            spawn: () => {
              calls += 1;
              return { status: null, error: new Error("synthetic") };
            }
          }
        }
      ),
    /dispatch failed/
  );
  assert.equal(calls, 1);
}

for (const invalid of [
  null,
  [],
  {},
  {
    action: "hibernate",
    confirm: "SHUTDOWN_WINDOWS"
  },
  {
    action: "shutdown",
    confirm: "SHUTDOWN_WINDOWS",
    dry_run: "false"
  },
  {
    action: "shutdown",
    confirm: "SHUTDOWN_WINDOWS",
    extra: true
  }
]) {
  assert.throws(() =>
    runWindowsPowerOperator(invalid, {
      platform: "win32",
      dispatch_runtime: {
        spawn: () => {
          throw new Error("invalid input must not dispatch");
        }
      }
    })
  );
}

console.log("windows-power-operator-smoke: PASS");
