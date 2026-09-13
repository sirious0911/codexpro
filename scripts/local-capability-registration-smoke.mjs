import assert from "node:assert/strict";
import fs from "node:fs";
import {
  LOCAL_CAPABILITY_DIRECT_ONLY_TOOL_NAMES,
  LOCAL_CAPABILITY_TOOL_ANNOTATIONS,
  localCapabilityToolNamesForPolicy
} from "../src/localCapabilityPolicy.ts";

const serverSource = fs.readFileSync(
  new URL("../src/server.ts", import.meta.url),
  "utf8"
);
const configSource = fs.readFileSync(
  new URL("../src/config.ts", import.meta.url),
  "utf8"
);

const exact4 = [
  "local_runtime_probe",
  "windows_system_snapshot",
  "windows_power_action",
  "windows_desktop_ui"
];

assert.deepEqual([...LOCAL_CAPABILITY_DIRECT_ONLY_TOOL_NAMES], exact4);
assert.deepEqual(
  localCapabilityToolNamesForPolicy({
    toolMode: "full",
    localCapabilityMode: "full",
    connectionTest: false
  }),
  exact4
);

for (const name of exact4) {
  const registration = new RegExp(
    String.raw`registerCodexTool\(\s*config,\s*server,\s*"${name}"`
  );
  assert.match(serverSource, registration);
}

assert.match(
  serverSource,
  /const SUPERTOOL_EXCLUDED_TOOL_NAMES = new Set<string>\(\[\s*WP1_READONLY_PREFLIGHT_TOOL_NAME,\s*\.\.\.LOCAL_CAPABILITY_DIRECT_ONLY_TOOL_NAMES\s*\]\);/
);
assert.match(
  serverSource,
  /if \(isLocalCapabilityToolName\(name\)\) return localCapabilityToolEnabled\(config, name\);/
);
assert.match(
  serverSource,
  /for \(const name of localCapabilityToolNamesForPolicy\(config\)\)/
);
assert.match(
  serverSource,
  /localCapabilityMode: config\.localCapabilityMode/
);
assert.match(
  serverSource,
  /local_capabilities=\$\{config\.localCapabilityMode\}/
);
assert.match(
  serverSource,
  /Local capability tools are first-class direct-only tools and are never routed through the codexpro supertool\./
);

assert.match(
  configSource,
  /localCapabilityMode: LocalCapabilityMode;/
);
assert.match(
  configSource,
  /args\["local-capabilities"\]/
);
assert.match(
  configSource,
  /process\.env\.CODEXPRO_LOCAL_CAPABILITIES/
);

assert.match(
  serverSource,
  /"windows_power_action"[\s\S]*?action: z\.enum\(\["shutdown", "reboot"\]\)[\s\S]*?confirm: z\.string\(\)[\s\S]*?dry_run: z\.boolean\(\)/
);
assert.match(
  serverSource,
  /"windows_desktop_ui"[\s\S]*?actions: z\.array\([\s\S]*?\.min\(1\)\.max\(16\),[\s\S]*?dry_run: z\.boolean\(\)/
);

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

for (const forbidden of [
  "arbitrary_endpoint",
  "arbitrary_command",
  "arbitrary_path"
]) {
  assert.equal(serverSource.includes(forbidden), false);
}

console.log("local-capability-registration-smoke: PASS");
