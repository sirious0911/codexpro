import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

class McpStdioClient {
  constructor() {
    this.child = spawn('node', ['dist/stdio.js', '--root', path.resolve('.'), '--allow-root', path.resolve('.'), '--bash', 'safe'], {
      cwd: path.resolve('.'),
      env: { ...process.env, CODEXPRO_TOOL_MODE: 'standard' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    this.child.on('exit', (code) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`server exited ${code}`));
      }
      this.pending.clear();
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
      if (!message.id || !this.pending.has(message.id)) continue;
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async close() {
    this.child.stdin.end();
    if (this.child.exitCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.child.exitCode === null) this.child.kill();
        resolve();
      }, 1000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

const directOnly = ['start_dedicated_chrome'];
const client = new McpStdioClient();
try {
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'codexpro-direct-only-smoke', version: '0.1.0' }
  });
  client.notify('notifications/initialized');

  const tools = await client.request('tools/list', {});
  const toolNames = tools.tools.map((tool) => tool.name);
  for (const name of directOnly) {
    assert.ok(toolNames.includes(name), `expected explicit direct-only tool ${name} in tools/list`);
  }

  const actions = await client.request('tools/call', { name: 'codexpro', arguments: { action: 'list_actions' } });
  const actionNames = actions.structuredContent.actions;
  for (const name of directOnly) {
    assert.ok(!actionNames.includes(name), `direct-only tool ${name} must not appear in codexpro list_actions`);
  }

  console.log('direct-only-actions-smoke: PASS');
} finally {
  await client.close();
}
