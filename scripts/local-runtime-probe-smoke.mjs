import assert from "node:assert/strict";
import {
  LOCAL_RUNTIME_HOST,
  LOCAL_RUNTIME_PORT,
  LOCAL_RUNTIME_TIMEOUT_MS,
  createLocalRuntimeProbeSpec,
  probeLocalRuntime
} from "../src/localRuntimeProbe.ts";
import {
  createNetworkHealthSnapshot
} from "../src/networkHealthSnapshot.ts";

assert.deepEqual(createLocalRuntimeProbeSpec(), {
  host: "127.0.0.1",
  port: 8787,
  timeout_ms: 750
});

const expectedSpec = {
  host: LOCAL_RUNTIME_HOST,
  port: LOCAL_RUNTIME_PORT,
  timeout_ms: LOCAL_RUNTIME_TIMEOUT_MS
};

for (const [reason, expectedReachable] of [
  ["CONNECTED", true],
  ["REFUSED", false],
  ["TIMEOUT", false],
  ["UNREACHABLE", false]
]) {
  let attempts = 0;
  const runtime = {
    attempt: async (spec) => {
      attempts += 1;
      assert.deepEqual(spec, expectedSpec);
      return reason;
    }
  };

  assert.deepEqual(await probeLocalRuntime(runtime), {
    reachable: expectedReachable,
    reason
  });
  assert.equal(attempts, 1);
}

await assert.rejects(
  probeLocalRuntime({
    attempt: async () => "INVALID_REASON"
  }),
  /invalid reason/
);

{
  const runtime = {
    attempt: async (spec) => {
      assert.deepEqual(spec, expectedSpec);
      return "CONNECTED";
    }
  };

  assert.deepEqual(
    await createNetworkHealthSnapshot(
      {
        primary_available: true,
        backup_available: true
      },
      runtime
    ),
    {
      probe: {
        reachable: true,
        reason: "CONNECTED"
      },
      classification: "HEALTHY_DUAL"
    }
  );
}

{
  const runtime = {
    attempt: async () => "CONNECTED"
  };

  assert.equal(
    (
      await createNetworkHealthSnapshot(
        {
          primary_available: false,
          backup_available: true
        },
        runtime
      )
    ).classification,
    "PRIMARY_DEGRADED_BACKUP_AVAILABLE"
  );

  assert.equal(
    (
      await createNetworkHealthSnapshot(
        {
          primary_available: true,
          backup_available: false
        },
        runtime
      )
    ).classification,
    "BACKUP_DEGRADED_PRIMARY_AVAILABLE"
  );

  assert.equal(
    (
      await createNetworkHealthSnapshot(
        {
          primary_available: false,
          backup_available: false
        },
        runtime
      )
    ).classification,
    "TRANSPORTS_DOWN_RUNTIME_HEALTHY"
  );
}

{
  const runtimeDown = {
    attempt: async () => "REFUSED"
  };

  assert.deepEqual(
    await createNetworkHealthSnapshot(
      {
        primary_available: false,
        backup_available: false
      },
      runtimeDown
    ),
    {
      probe: {
        reachable: false,
        reason: "REFUSED"
      },
      classification: "RUNTIME_FAILURE"
    }
  );

  await assert.rejects(
    createNetworkHealthSnapshot(
      {
        primary_available: true,
        backup_available: false
      },
      runtimeDown
    ),
    /ambiguous/
  );
}

for (const invalid of [
  null,
  [],
  {},
  {
    primary_available: true
  },
  {
    primary_available: "yes",
    backup_available: true
  },
  {
    primary_available: true,
    backup_available: 1
  },
  {
    primary_available: true,
    backup_available: true,
    extra: false
  }
]) {
  await assert.rejects(
    createNetworkHealthSnapshot(
      invalid,
      {
        attempt: async () => {
          throw new Error("probe must not run for invalid input");
        }
      }
    )
  );
}

console.log("local-runtime-probe-smoke: PASS");
