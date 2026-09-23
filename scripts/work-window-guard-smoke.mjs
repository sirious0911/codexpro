import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const {
  WorkWindowGuard,
  WORK_WINDOW_ACTIVE_MS,
  WORK_WINDOW_DURATION_MS,
  WORK_WINDOW_MIN_BASH_BUDGET_MS
} = await import(pathToFileURL(path.join(path.resolve('.'), 'dist', 'workWindowGuard.js')).href);

const UUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
  '77777777-7777-4777-8777-777777777777',
  '88888888-8888-4888-8888-888888888888',
  '99999999-9999-4999-8999-999999999999',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
];

function sequenceUuid(values = UUIDS) {
  let index = 0;
  return () => {
    if (index >= values.length) throw new Error('deterministic UUID sequence exhausted');
    return values[index++];
  };
}

async function expectReject(fn, pattern) {
  let error;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  assert(error, 'expected rejection');
  if (pattern) assert.match(String(error.message ?? error), pattern);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-work-window-'));
const registry = path.join(tmp, 'work-windows');
const workspaceA = { id: 'ws_a', root: path.join(tmp, 'workspace-a'), openedAt: new Date(0).toISOString() };
const workspaceB = { id: 'ws_b', root: path.join(tmp, 'workspace-b'), openedAt: new Date(0).toISOString() };
await fs.mkdir(workspaceA.root, { recursive: true });
await fs.mkdir(workspaceB.root, { recursive: true });

let now = 1_800_000_000_000;
const uuid = sequenceUuid();
const guard = new WorkWindowGuard({ homeDir: registry, now: () => now, uuid });

try {
  // A. Host identity persists and start creates a fixed window.
  const first = await guard.start(workspaceA, { sessionBinding: 'transport-a' });
  assert.equal(first.state, 'ACTIVE');
  assert.equal(first.work_window_id, UUIDS[1]);
  assert.equal(first.drain_at, new Date(now + WORK_WINDOW_ACTIVE_MS).toISOString());
  assert.equal(first.deadline, new Date(now + WORK_WINDOW_DURATION_MS).toISOString());
  const hostId = first.host_id;
  const originalDeadline = first.deadline;

  const recovered = new WorkWindowGuard({ homeDir: registry, now: () => now, uuid });
  const recoveredStatus = await recovered.status(workspaceA, first.work_window_id);
  assert.equal(recoveredStatus.host_id, hostId);
  assert.equal(recoveredStatus.session_binding, 'transport-a');

  // B. Explicit wrong/missing/cross-workspace ids fail closed.
  await expectReject(() => guard.assertMutationAllowed(workspaceA, 'not-a-uuid'), /strict UUID/i);
  await expectReject(
    () => guard.assertMutationAllowed(workspaceA, 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
    /not found/i
  );
  await expectReject(() => guard.assertMutationAllowed(workspaceB, first.work_window_id), /different workspace/i);

  // C. Exact 27-minute boundary enters DRAINING and blocks mutation.
  now = 1_800_000_000_000 + WORK_WINDOW_ACTIVE_MS - 1;
  assert.equal((await guard.status(workspaceA, first.work_window_id)).state, 'ACTIVE');
  now += 1;
  assert.equal((await guard.status(workspaceA, first.work_window_id)).state, 'DRAINING');
  await expectReject(() => guard.assertMutationAllowed(workspaceA, first.work_window_id), /DRAINING/);

  // D. Exact 30-minute boundary is EXPIRED; checkpoint remains allowed.
  now = 1_800_000_000_000 + WORK_WINDOW_DURATION_MS;
  assert.equal((await guard.status(workspaceA, first.work_window_id)).state, 'EXPIRED');
  const expiredCheckpoint = await guard.checkpoint(workspaceA, first.work_window_id, {
    completed: ['implementation'],
    pending: ['validation'],
    resumeFrom: 'PRECOMMIT',
    finding: [],
    testCompleted: ['guard smoke'],
    testNotRun: []
  });
  assert.equal(expiredCheckpoint.state, 'EXPIRED');
  assert.equal(expiredCheckpoint.deadline, originalDeadline);

  // E. A new continuation creates a new UUID/deadline and never mutates the old deadline.
  now += 10_000;
  const continuation = await guard.start(workspaceA, { sessionBinding: 'transport-b' });
  assert.notEqual(continuation.work_window_id, first.work_window_id);
  assert.equal((await guard.status(workspaceA, first.work_window_id)).deadline, originalDeadline);
  assert.equal(continuation.deadline, new Date(now + WORK_WINDOW_DURATION_MS).toISOString());

  // F. Three same-workspace windows coexist instead of overwriting a singleton.
  const sameWorkspace = await Promise.all([
    guard.start(workspaceA),
    guard.start(workspaceA),
    guard.start(workspaceA)
  ]);
  assert.equal(new Set(sameWorkspace.map((item) => item.work_window_id)).size, 3);
  const activeA = await guard.listActive(workspaceA);
  for (const item of sameWorkspace) assert(activeA.some((entry) => entry.work_window_id === item.work_window_id));
  assert(activeA.every((entry) => entry.state === 'ACTIVE' || entry.state === 'DRAINING'));

  // G. Cross-workspace window is independent.
  const cross = await guard.start(workspaceB);
  assert.equal((await guard.listActive(workspaceB)).some((item) => item.work_window_id === cross.work_window_id), true);
  assert.equal((await guard.listActive(workspaceA)).some((item) => item.work_window_id === cross.work_window_id), false);

  // H. Concurrent checkpoints serialize through module-scope per-window locks.
  const concurrentTarget = sameWorkspace[0];
  await Promise.all([
    guard.checkpoint(workspaceA, concurrentTarget.work_window_id, { completed: ['a'], pending: ['b'] }),
    recovered.checkpoint(workspaceA, concurrentTarget.work_window_id, { completed: ['c'], pending: ['d'] })
  ]);
  const afterConcurrent = await guard.status(workspaceA, concurrentTarget.work_window_id);
  assert(afterConcurrent.checkpoint);
  assert(
    JSON.stringify(afterConcurrent.checkpoint.completed) === JSON.stringify(['a']) ||
      JSON.stringify(afterConcurrent.checkpoint.completed) === JSON.stringify(['c'])
  );

  // I. Bash timeout clamps to the drain boundary.
  const bashWindowStart = now;
  const bashWindow = await guard.start(workspaceA);
  now = bashWindowStart + WORK_WINDOW_ACTIVE_MS - 5_000;
  const clamped = await guard.effectiveBashTimeout(workspaceA, bashWindow.work_window_id, 20_000, 60_000);
  assert.equal(clamped.timeoutMs, 5_000);
  now = bashWindowStart + WORK_WINDOW_ACTIVE_MS - (WORK_WINDOW_MIN_BASH_BUDGET_MS - 1);
  await expectReject(
    () => guard.effectiveBashTimeout(workspaceA, bashWindow.work_window_id, 20_000, 60_000),
    /less than 1000 ms ACTIVE budget/i
  );

  // J. stop preserves immutable deadlines, excludes list, and blocks mutation.
  now = bashWindowStart + 1_000;
  const beforeStop = await guard.status(workspaceA, bashWindow.work_window_id);
  const stopped = await guard.stop(workspaceA, bashWindow.work_window_id);
  assert.equal(stopped.state, 'STOPPED');
  assert.equal(stopped.started_at, beforeStop.started_at);
  assert.equal(stopped.drain_at, beforeStop.drain_at);
  assert.equal(stopped.deadline, beforeStop.deadline);
  assert.equal((await guard.listActive(workspaceA)).some((item) => item.work_window_id === stopped.work_window_id), false);
  await expectReject(() => guard.assertMutationAllowed(workspaceA, stopped.work_window_id), /STOPPED/);
  await expectReject(() => guard.checkpoint(workspaceA, stopped.work_window_id, {}), /stopped/i);

  // K. Corrupt durable state fails closed and is not silently replaced.
  const corruptHome = path.join(tmp, 'corrupt-registry');
  const corruptWindows = path.join(corruptHome, 'windows');
  await fs.mkdir(corruptWindows, { recursive: true });
  await fs.writeFile(
    path.join(corruptHome, 'host.json'),
    JSON.stringify({ version: 1, host_id: UUIDS[10], created_at: new Date(now).toISOString() }) + '\n',
    'utf8'
  );
  const corruptId = UUIDS[11];
  await fs.writeFile(path.join(corruptWindows, `${corruptId}.json`), '{broken json\n', 'utf8');
  const corruptGuard = new WorkWindowGuard({ homeDir: corruptHome, now: () => now, uuid: sequenceUuid(UUIDS.slice(12)) });
  await expectReject(() => corruptGuard.status(workspaceA, corruptId), /Corrupt Work Window registry JSON/);
  await expectReject(() => corruptGuard.assertMutationAllowed(workspaceA, corruptId), /Corrupt Work Window registry JSON/);

  // L. Corrupt host identity fails closed; no silent host remint.
  const corruptHostHome = path.join(tmp, 'corrupt-host');
  await fs.mkdir(corruptHostHome, { recursive: true });
  await fs.writeFile(path.join(corruptHostHome, 'host.json'), '{"version":1,"host_id":"bad"}\n', 'utf8');
  const corruptHostGuard = new WorkWindowGuard({ homeDir: corruptHostHome, now: () => now, uuid: sequenceUuid(UUIDS.slice(12)) });
  await expectReject(() => corruptHostGuard.start(workspaceA), /strict UUID|Corrupt|host/i);
  const hostAfter = await fs.readFile(path.join(corruptHostHome, 'host.json'), 'utf8');
  assert.match(hostAfter, /"bad"/);

  console.log('work-window-guard-smoke: PASS (A-L)');
} finally {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
