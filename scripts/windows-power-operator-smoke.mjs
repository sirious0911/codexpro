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
import {
  runWindowsPowerAction
} from "../src/powerOps.ts";

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
  status: "DRY_RUN",
  dispatch_attempts: 0,
  locked_force_fallback_used: false
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
  assert.equal(result.dispatch_attempts, 1);
  assert.equal(result.locked_force_fallback_used, false);
}

{
  const calls = [];
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
          calls.push({ executable, args: [...args], options });
          return { status: calls.length === 1 ? 1271 : 0 };
        }
      }
    }
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["/s", "/t", "0"]);
  assert.deepEqual(calls[1].args, ["/s", "/t", "0", "/f"]);
  assert.equal(result.status, "DISPATCHED");
  assert.equal(result.dispatch_attempts, 2);
  assert.equal(result.locked_force_fallback_used, true);
}

{
  const calls = [];
  const result = runWindowsPowerAction(
    "reboot",
    {
      confirm: "REBOOT_WINDOWS",
      dryRun: false
    },
    {
      spawn: (executable, args, options) => {
        calls.push({ executable, args: [...args], options });
        return { status: calls.length === 1 ? 1271 : 0 };
      }
    }
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["/r", "/t", "0"]);
  assert.deepEqual(calls[1].args, ["/r", "/t", "0", "/f"]);
  assert.equal(result.status, "DISPATCHED");
  assert.equal(result.dispatchAttempts, 2);
  assert.equal(result.lockedForceFallbackUsed, true);
}

{
  let calls = 0;
  assert.throws(
    () =>
      runWindowsPowerAction(
        "shutdown",
        {
          confirm: "SHUTDOWN_WINDOWS",
          dryRun: false
        },
        {
          spawn: () => {
            calls += 1;
            return { status: 5 };
          }
        }
      ),
    /non-zero status: 5/
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
