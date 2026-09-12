import assert from "node:assert/strict";
import {
  runLocalRuntimeProbeOperator
} from "../src/localRuntimeProbeOperator.ts";

const expectedSpec = {
  host: "127.0.0.1",
  port: 8787,
  timeout_ms: 750
};

for (const [reason, reachable, exitCode] of [
  ["CONNECTED", true, 0],
  ["REFUSED", false, 2],
  ["TIMEOUT", false, 2],
  ["UNREACHABLE", false, 2]
]) {
  let attempts = 0;

  const result = await runLocalRuntimeProbeOperator({
    attempt: async (spec) => {
      attempts += 1;
      assert.deepEqual(spec, expectedSpec);
      return reason;
    }
  });

  assert.deepEqual(result, {
    payload: {
      reachable,
      reason
    },
    exit_code: exitCode
  });
  assert.equal(attempts, 1);
  assert.ok(JSON.stringify(result.payload).length < 96);
}

let importOnlyAttempts = 0;
const importOnlyRuntime = {
  attempt: async () => {
    importOnlyAttempts += 1;
    return "CONNECTED";
  }
};
assert.equal(importOnlyAttempts, 0);
void importOnlyRuntime;
assert.equal(importOnlyAttempts, 0);

await assert.rejects(
  runLocalRuntimeProbeOperator({
    attempt: async () => "INVALID_REASON"
  }),
  /invalid reason/
);

console.log("local-runtime-probe-operator-smoke: PASS");
