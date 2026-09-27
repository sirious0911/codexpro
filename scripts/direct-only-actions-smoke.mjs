import assert from 'node:assert/strict';
import fs from 'node:fs';

const serverSource = fs.readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const policySource = fs.readFileSync(new URL('../src/localCapabilityPolicy.ts', import.meta.url), 'utf8');
const httpSource = fs.readFileSync(new URL('../src/http.ts', import.meta.url), 'utf8');
const guardSource = fs.readFileSync(new URL('../src/guard.ts', import.meta.url), 'utf8');

const legacyExact4 = [
  'codexpro_controlled_handover',
  'shutdown_windows',
  'reboot_windows',
  'start_dedicated_chrome'
];
const localExact4 = [
  'local_runtime_probe',
  'windows_system_snapshot',
  'windows_power_action',
  'windows_desktop_ui'
];
const confirmCarriedExact5 = [
  'codexpro_controlled_handover',
  'shutdown_windows',
  'reboot_windows',
  'start_dedicated_chrome',
  'windows_power_action'
];

const standardBlock = serverSource.match(/const STANDARD_TOOL_NAMES = \[([\s\S]*?)\] as const;/)?.[1] ?? '';
const fullBlock = serverSource.match(/const FULL_TOOL_NAMES = \[([\s\S]*?)\] as const;/)?.[1] ?? '';

assert.match(standardBlock, /CODEXPRO_CONTROLLED_HANDOVER_TOOL_NAME/);
assert.match(fullBlock, /CODEXPRO_CONTROLLED_HANDOVER_TOOL_NAME/);
for (const name of legacyExact4.slice(1)) {
  assert.ok(standardBlock.includes(`"${name}"`), `STANDARD tools must include ${name}`);
  assert.ok(fullBlock.includes(`"${name}"`), `FULL tools must include ${name}`);
}

assert.match(
  serverSource,
  /registerCodexTool\(\s*config,\s*server,\s*CODEXPRO_CONTROLLED_HANDOVER_TOOL_NAME/
);
for (const name of legacyExact4.slice(1)) {
  assert.match(
    serverSource,
    new RegExp(String.raw`registerCodexTool\(\s*config,\s*server,\s*"${name}"`)
  );
}
for (const name of localExact4) {
  assert.match(
    serverSource,
    new RegExp(String.raw`registerCodexTool\(\s*config,\s*server,\s*"${name}"`)
  );
}

assert.match(
  serverSource,
  /const SUPERTOOL_EXCLUDED_TOOL_NAMES = new Set<string>\(\[\s*WP1_READONLY_PREFLIGHT_TOOL_NAME,\s*\.\.\.LOCAL_CAPABILITY_DIRECT_ONLY_TOOL_NAMES\s*\]\);/
);
assert.match(
  serverSource,
  /const LEGACY_DIRECT_ONLY_TOOL_NAMES = new Set<string>\(\[\s*CODEXPRO_CONTROLLED_HANDOVER_TOOL_NAME,\s*"shutdown_windows",\s*"reboot_windows",\s*"start_dedicated_chrome"\s*\]\);/
);
assert.match(
  serverSource,
  /const COMBINED_DIRECT_ONLY_TOOL_NAMES = new Set<string>\(\[\s*\.\.\.SUPERTOOL_EXCLUDED_TOOL_NAMES,\s*\.\.\.LEGACY_DIRECT_ONLY_TOOL_NAMES\s*\]\);/
);
assert.match(
  serverSource,
  /name !== SUPERTOOL_NAME && !COMBINED_DIRECT_ONLY_TOOL_NAMES\.has\(name\)/
);
assert.match(
  serverSource,
  /if \(COMBINED_DIRECT_ONLY_TOOL_NAMES\.has\(action\)\)/
);

const confirmCarriedBlock =
  serverSource.match(/const WORK_WINDOW_CONFIRM_CARRIED_BINDING_TOOL_NAMES = new Set<string>\(\[([\s\S]*?)\]\);/)?.[1] ?? '';
for (const name of confirmCarriedExact5) {
  assert.ok(
    confirmCarriedBlock.includes(name === 'codexpro_controlled_handover' ? 'CODEXPRO_CONTROLLED_HANDOVER_TOOL_NAME' : `"${name}"`),
    `confirmation-carried exact5 must include ${name}`
  );
}
assert.ok(!confirmCarriedBlock.includes('"windows_desktop_ui"'));
assert.match(serverSource, /const WORKSPACE_ID_PATTERN = \/\^ws_\[0-9a-f\]\{24\}\$\//);
assert.match(serverSource, /if \(carriedBinding\) args\.confirm = carriedBinding\.baseConfirmation;/);
assert.match(serverSource, /hostBoundTool && !explicitWorkspaceId \? parseConfirmCarriedWorkspaceBinding\(name, args\) : undefined/);
assert.match(httpSource, /const workspaceRegistry = new WorkspaceRegistry\(\);/);
assert.match(httpSource, /createCodexProServer\(config, \{ workspaceRegistry \}\)/);
assert.match(guardSource, /if \(!allowed \|\| workspaceIdForRoot\(realRoot\) !== id\)/);

for (const name of localExact4) {
  assert.ok(policySource.includes(`"${name}"`), `local policy must preserve ${name}`);
}
assert.match(
  policySource,
  /input\.connectionTest \|\| input\.toolMode !== "full"/
);
assert.match(
  policySource,
  /input\.localCapabilityMode === "full"/
);

assert.equal(1 + legacyExact4.length + localExact4.length, 9);
console.log('direct-only-actions-smoke: PASS');
