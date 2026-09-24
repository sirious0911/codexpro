import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

function encode(message) {
  return `${JSON.stringify(message)}\n`;
}

class McpStdioClient {
  constructor(command, args, options) {
    this.child = spawn(command, args, options);
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    this.child.on('exit', (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`server exited ${code}`));
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(encode({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(encode({ jsonrpc: '2.0', method, params }));
  }

  close() {
    this.child.kill('SIGTERM');
  }
}

import {
  WP1_READONLY_PREFLIGHT_ANNOTATIONS,
  WP1_READONLY_PREFLIGHT_BASELINE,
  WP1_READONLY_PREFLIGHT_INPUT_KEYS,
  WP1_READONLY_PREFLIGHT_MAX_AUTHORIZATION_MS,
  WP1_READONLY_PREFLIGHT_OPERATION,
  WP1_READONLY_PREFLIGHT_PROJECT_ID,
  WP1_READONLY_PREFLIGHT_TOOL_NAME,
  validateWp1ReadonlyPreflight
} from '../dist/wp1ReadonlyPreflightOps.js';

const EXPECTED_TOOL = 'ai_project_coordinator_wp1_scroll_preflight';
const EXPECTED_BASELINE = 'd4872a68f79d982ce50f50b77e752e1e6709202a';
const EXPECTED_INPUT_KEYS = [
  'task_id',
  'execution_id',
  'user_authorization_id',
  'user_authorized_at',
  'user_expires_at'
];

assert.equal(WP1_READONLY_PREFLIGHT_TOOL_NAME, EXPECTED_TOOL);
assert.equal(WP1_READONLY_PREFLIGHT_PROJECT_ID, 'ai-project-coordinator');
assert.equal(WP1_READONLY_PREFLIGHT_OPERATION, 'CHATGPT_MENU_VISIBILITY_SCROLL_ONLY');
assert.equal(WP1_READONLY_PREFLIGHT_BASELINE, EXPECTED_BASELINE);
assert.equal(WP1_READONLY_PREFLIGHT_MAX_AUTHORIZATION_MS, 600_000);
assert.deepEqual([...WP1_READONLY_PREFLIGHT_INPUT_KEYS], EXPECTED_INPUT_KEYS);
assert.deepEqual(WP1_READONLY_PREFLIGHT_ANNOTATIONS, {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: true
});

const now = Date.parse('2026-09-09T00:00:00Z');
const validInput = {
  task_id: 'phase5-wp1',
  execution_id: 'phase5-wp1-exec-1',
  user_authorization_id: 'fresh-single-use-root',
  user_authorized_at: '2026-09-08T23:59:00Z',
  user_expires_at: '2026-09-09T00:09:00Z'
};

assert.deepEqual(validateWp1ReadonlyPreflight(validInput, now), {
  ready: false,
  reason: 'PREFLIGHT_READY'
});

const microsecondInput = {
  ...validInput,
  user_authorized_at: '2026-09-08T23:59:00.123456+00:00',
  user_expires_at: '2026-09-09T00:09:00.123456Z'
};
assert.equal(validateWp1ReadonlyPreflight(microsecondInput, now).reason, 'PREFLIGHT_READY');

for (const input of [
  {
    ...validInput,
    user_authorized_at: '2026-09-09T00:00:00.000999Z',
    user_expires_at: '2026-09-09T00:01:00.000999Z'
  },
  {
    ...validInput,
    user_authorized_at: '2026-09-08T23:59:00.000999Z',
    user_expires_at: '2026-09-09T00:00:00.000999Z'
  },
  {
    ...validInput,
    user_authorized_at: '2026-09-08T23:59:00.000000Z',
    user_expires_at: '2026-09-09T00:09:00.000001Z'
  }
]) {
  assert.equal(validateWp1ReadonlyPreflight(input, now).reason, 'AUTHORIZATION_BLOCKED');
}

assert.equal(validateWp1ReadonlyPreflight({
  ...validInput,
  user_authorized_at: '2026-09-08T23:50:00.001000Z',
  user_expires_at: '2026-09-09T00:00:00.001000Z'
}, now).reason, 'PREFLIGHT_READY');
assert.equal(validateWp1ReadonlyPreflight(validInput, now + 0.5).reason, 'INVALID_REQUEST');

for (const input of [
  { ...validInput, task_id: '' },
  { ...validInput, task_id: ' phase5-wp1' },
  { ...validInput, execution_id: 'x'.repeat(257) },
  { ...validInput, user_authorization_id: 'root\u0000bad' },
  { ...validInput, user_authorized_at: 'not-a-time' },
  { ...validInput, user_authorized_at: '2026-02-30T23:59:00Z' },
  { ...validInput, user_authorized_at: '2025-02-29T23:59:00Z' },
  { ...validInput, user_authorized_at: '2026-13-01T23:59:00Z' },
  { ...validInput, user_authorized_at: '2026-09-08T24:00:00Z' },
  { ...validInput, user_authorized_at: '2026-09-08T23:60:00Z' },
  { ...validInput, user_authorized_at: '2026-09-08T23:59:60Z' },
  { ...validInput, user_authorized_at: '2026-09-08T23:59:00+09:00' },
  { ...validInput, user_expires_at: '2026-09-09T00:09:00+09:00' }
]) {
  assert.equal(validateWp1ReadonlyPreflight(input, now).reason, 'INVALID_REQUEST');
}

for (const input of [
  { ...validInput, user_authorized_at: '2026-09-09T00:01:00Z', user_expires_at: '2026-09-09T00:09:00Z' },
  { ...validInput, user_authorized_at: '2026-09-08T23:49:00Z', user_expires_at: '2026-09-08T23:59:00Z' },
  { ...validInput, user_authorized_at: '2026-09-08T23:50:00Z', user_expires_at: '2026-09-09T00:00:00Z' },
  { ...validInput, user_authorized_at: '2026-09-08T23:58:00Z', user_expires_at: '2026-09-09T00:09:00Z' },
  { ...validInput, user_authorized_at: '2026-09-08T23:59:00Z', user_expires_at: '2026-09-08T23:59:00Z' }
]) {
  assert.equal(validateWp1ReadonlyPreflight(input, now).reason, 'AUTHORIZATION_BLOCKED');
}

const resultText = JSON.stringify(validateWp1ReadonlyPreflight(validInput, now));
assert.equal(resultText.includes(validInput.user_authorization_id), false);
assert.deepEqual(Object.keys(JSON.parse(resultText)).sort(), ['ready', 'reason']);

const opsSource = await fs.readFile(new URL('../src/wp1ReadonlyPreflightOps.ts', import.meta.url), 'utf8');
for (const forbidden of [
  'node:child_process',
  'spawn(',
  'spawnSync(',
  'execFile(',
  'execSync(',
  'runBash',
  'fetch(',
  'sqlite',
  'ApprovalGate',
  'browser',
  'CDP',
  'node:fs',
  'node:http',
  'node:https'
]) {
  assert.equal(opsSource.includes(forbidden), false, `pure validator contains forbidden surface: ${forbidden}`);
}

const serverSource = await fs.readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
const supertoolExcludedStart = serverSource.indexOf('const SUPERTOOL_EXCLUDED_TOOL_NAMES = new Set<string>([');
const supertoolExcludedEnd = serverSource.indexOf(']);', supertoolExcludedStart);
assert.ok(supertoolExcludedStart >= 0 && supertoolExcludedEnd > supertoolExcludedStart);
const supertoolExcludedBlock = serverSource.slice(supertoolExcludedStart, supertoolExcludedEnd);
assert.ok(supertoolExcludedBlock.includes('WP1_READONLY_PREFLIGHT_TOOL_NAME'));
assert.match(serverSource, /name !== SUPERTOOL_NAME && !COMBINED_DIRECT_ONLY_TOOL_NAMES\.has\(name\)/);
assert.match(serverSource, /COMBINED_DIRECT_ONLY_TOOL_NAMES\.has\(action\)/);
assert.match(serverSource, /annotations: WP1_READONLY_PREFLIGHT_ANNOTATIONS/);

const standardStart = serverSource.indexOf('const STANDARD_TOOL_NAMES = [');
const standardEnd = serverSource.indexOf('] as const;', standardStart);
const fullStart = serverSource.indexOf('const FULL_TOOL_NAMES = [');
const fullEnd = serverSource.indexOf('] as const;', fullStart);
assert.ok(standardStart >= 0 && standardEnd > standardStart);
assert.ok(fullStart >= 0 && fullEnd > fullStart);
assert.ok(serverSource.slice(standardStart, standardEnd).includes('WP1_READONLY_PREFLIGHT_TOOL_NAME'));
assert.ok(serverSource.slice(fullStart, fullEnd).includes('WP1_READONLY_PREFLIGHT_TOOL_NAME'));

const toolTitle = 'title: "AI Project Coordinator WP1 Scroll Preflight"';
const toolStart = serverSource.indexOf(toolTitle);
const toolEnd = serverSource.indexOf('"server_config"', toolStart);
assert.ok(toolStart >= 0 && toolEnd > toolStart);
const toolBlock = serverSource.slice(toolStart, toolEnd);
for (const key of EXPECTED_INPUT_KEYS) assert.ok(toolBlock.includes(`${key}: z.string()`));
for (const forbiddenKey of ['command:', 'path:', 'module:', 'mode:', 'baseline:', 'execute:']) {
  assert.equal(toolBlock.includes(forbiddenKey), false, `tool schema exposes forbidden key: ${forbiddenKey}`);
}
const handlerStart = toolBlock.indexOf('async (args) => {');
const handlerEnd = toolBlock.indexOf('return textResult(JSON.stringify(payload), payload);', handlerStart);
assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
const handlerBlock = toolBlock.slice(handlerStart, handlerEnd);
for (const forbiddenCall of ['runBash(', 'spawn(', 'spawnSync(', 'exec(', 'fetch(', 'gitStatus(', 'SQLite', 'ApprovalGate']) {
  assert.equal(handlerBlock.includes(forbiddenCall), false, `tool handler contains forbidden call: ${forbiddenCall}`);
}
assert.ok(toolBlock.includes('validateWp1ReadonlyPreflight({'));
assert.ok(toolBlock.includes('textResult(JSON.stringify(payload), payload)'));

const client = new McpStdioClient(
  process.execPath,
  [
    'dist/stdio.js',
    '--root', 'C:/Codex/projects',
    '--allow-root', 'C:/Codex/projects',
    '--bash', 'off',
    '--tool-mode', 'standard',
    '--write', 'off'
  ],
  { cwd: path.resolve('.'), env: { ...process.env, CODEXPRO_TOOL_MODE: '', CODEXPRO_ROOT: 'C:/Codex/projects' } }
);

try {
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'wp1-readonly-preflight-smoke', version: '0.1.0' }
  });
  client.notify('notifications/initialized');

  const tools = await client.request('tools/list', {});
  const directTool = tools.tools.find((tool) => tool.name === EXPECTED_TOOL);
  assert.ok(directTool, 'dedicated read-only preflight tool missing from tools/list');
  assert.deepEqual(directTool.annotations, {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
    idempotentHint: true
  });
  assert.deepEqual(Object.keys(directTool.inputSchema?.properties ?? {}).sort(), [...EXPECTED_INPUT_KEYS].sort());
  assert.equal(directTool.inputSchema?.properties?.execute, undefined);
  assert.equal(directTool.inputSchema?.properties?.command, undefined);

  const dynamicNow = Date.now();
  const directResult = await client.request('tools/call', {
    name: EXPECTED_TOOL,
    arguments: {
      task_id: 'phase5-wp1-dynamic-smoke',
      execution_id: 'phase5-wp1-dynamic-smoke-exec',
      user_authorization_id: 'dynamic-smoke-root-not-secret',
      user_authorized_at: new Date(dynamicNow - 60_000).toISOString(),
      user_expires_at: new Date(dynamicNow + 9 * 60_000).toISOString()
    }
  });
  assert.equal(directResult.isError, undefined);
  assert.equal(directResult.structuredContent?.ready, false);
  assert.equal(directResult.structuredContent?.reason, 'PREFLIGHT_READY');

  const microsecondAuthorizedAt = new Date(dynamicNow - 60_000).toISOString().replace(/(\.\d{3})Z$/, '$1456Z');
  const microsecondExpiresAt = new Date(dynamicNow + 9 * 60_000).toISOString().replace(/(\.\d{3})Z$/, '$1456Z');
  const directMicrosecondResult = await client.request('tools/call', {
    name: EXPECTED_TOOL,
    arguments: {
      task_id: 'phase5-wp1-dynamic-microsecond-smoke',
      execution_id: 'phase5-wp1-dynamic-microsecond-smoke-exec',
      user_authorization_id: 'dynamic-microsecond-smoke-root-not-secret',
      user_authorized_at: microsecondAuthorizedAt,
      user_expires_at: microsecondExpiresAt
    }
  });
  assert.equal(directMicrosecondResult.isError, undefined);
  assert.equal(directMicrosecondResult.structuredContent?.ready, false);
  assert.equal(directMicrosecondResult.structuredContent?.reason, 'PREFLIGHT_READY');

  const superActions = await client.request('tools/call', {
    name: 'codexpro',
    arguments: { action: 'list_actions' }
  });
  assert.equal(superActions.structuredContent?.actions?.includes(EXPECTED_TOOL), false);

  const wrappedAttempt = await client.request('tools/call', {
    name: 'codexpro',
    arguments: { action: EXPECTED_TOOL, args: validInput }
  });
  assert.equal(wrappedAttempt.isError, true);
  assert.match(wrappedAttempt.content?.[0]?.text ?? '', /direct-only MCP tool/);
} finally {
  client.close();
}

console.log('wp1 readonly preflight smoke: PASS');
