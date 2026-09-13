import assert from "node:assert/strict";
import {
  LOCAL_CAPABILITY_DIRECT_ONLY_TOOL_NAMES,
  LOCAL_CAPABILITY_READ_TOOL_NAMES,
  LOCAL_CAPABILITY_TOOL_ANNOTATIONS,
  LOCAL_CAPABILITY_TOOL_NAMES,
  localCapabilityModeFrom,
  localCapabilityToolNamesForPolicy
} from "../src/localCapabilityPolicy.ts";

assert.equal(localCapabilityModeFrom(undefined), "off");
assert.equal(localCapabilityModeFrom("off"), "off");
assert.equal(localCapabilityModeFrom("read"), "read");
assert.equal(localCapabilityModeFrom("full"), "full");
assert.equal(localCapabilityModeFrom("invalid"), "off");

const exact2 = ["local_runtime_probe", "windows_system_snapshot"];
const exact4 = [
  "local_runtime_probe",
  "windows_system_snapshot",
  "windows_power_action",
  "windows_desktop_ui"
];

assert.deepEqual([...LOCAL_CAPABILITY_READ_TOOL_NAMES], exact2);
assert.deepEqual([...LOCAL_CAPABILITY_TOOL_NAMES], exact4);
assert.deepEqual([...LOCAL_CAPABILITY_DIRECT_ONLY_TOOL_NAMES], exact4);

for (const toolMode of ["minimal", "standard"]) {
  for (const localCapabilityMode of ["off", "read", "full"]) {
    assert.deepEqual(
      localCapabilityToolNamesForPolicy({
        toolMode,
        localCapabilityMode,
        connectionTest: false
      }),
      []
    );
  }
}

assert.deepEqual(
  localCapabilityToolNamesForPolicy({
    toolMode: "full",
    localCapabilityMode: "off",
    connectionTest: false
  }),
  []
);
assert.deepEqual(
  localCapabilityToolNamesForPolicy({
    toolMode: "full",
    localCapabilityMode: "read",
    connectionTest: false
  }),
  exact2
);
assert.deepEqual(
  localCapabilityToolNamesForPolicy({
    toolMode: "full",
    localCapabilityMode: "full",
    connectionTest: false
  }),
  exact4
);

for (const localCapabilityMode of ["off", "read", "full"]) {
  assert.deepEqual(
    localCapabilityToolNamesForPolicy({
      toolMode: "full",
      localCapabilityMode,
      connectionTest: true
    }),
    []
  );
}

assert.deepEqual(LOCAL_CAPABILITY_TOOL_ANNOTATIONS.local_runtime_probe, {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false
});
assert.deepEqual(LOCAL_CAPABILITY_TOOL_ANNOTATIONS.windows_system_snapshot, {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false
});
assert.deepEqual(LOCAL_CAPABILITY_TOOL_ANNOTATIONS.windows_power_action, {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: true,
  idempotentHint: false
});
assert.deepEqual(LOCAL_CAPABILITY_TOOL_ANNOTATIONS.windows_desktop_ui, {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: true,
  idempotentHint: false
});

console.log("local-capability-policy-smoke: PASS");
