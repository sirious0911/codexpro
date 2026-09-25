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
  return error;
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
  // A. Host identity persists and start creates one fixed window.
  const firstStart = now;
  const first = await guard.start(workspaceA, { sessionBinding: 'transport-a' });
  assert.equal(first.state, 'ACTIVE');
  assert.equal(first.work_window_id, UUIDS[1]);
  assert.equal(first.drain_at, new Date(firstStart + WORK_WINDOW_ACTIVE_MS).toISOString());
  assert.equal(first.deadline, new Date(firstStart + WORK_WINDOW_DURATION_MS).toISOString());
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

  // C. Exact drain boundary is terminal for substantive continuation.
  now = firstStart + WORK_WINDOW_ACTIVE_MS - 1;
  assert.equal((await guard.status(workspaceA, first.work_window_id)).state, 'ACTIVE');
  assert.equal((await guard.assertContinuationAllowed(workspaceA)).state, 'ACTIVE');
  now += 1;
  assert.equal((await guard.status(workspaceA, first.work_window_id)).state, 'DRAINING');
  await expectReject(() => guard.assertMutationAllowed(workspaceA, first.work_window_id), /DRAINING/);
  const drainError = await expectReject(() => guard.assertContinuationAllowed(workspaceA), /substantive workspace work must stop/i);
  assert.equal(drainError.details?.must_stop, true);
  assert.equal(drainError.details?.checkpoint_required, true);
  assert.equal(drainError.details?.auto_renew_allowed, false);

  // D. DRAINING checkpoint atomically records checkpoint + STOPPED without extending the deadline.
  const drainedCheckpoint = await guard.checkpoint(workspaceA, first.work_window_id, {
    completed: ['implementation'],
    pending: ['validation'],
    resumeFrom: 'PRECOMMIT',
    finding: [],
    testCompleted: ['guard smoke'],
    testNotRun: []
  });
  assert.equal(drainedCheckpoint.state, 'STOPPED');
  assert.equal(drainedCheckpoint.deadline, originalDeadline);
  assert(drainedCheckpoint.stopped_at);
  await expectReject(() => guard.assertContinuationAllowed(workspaceA), /STOPPED/);

  // E. A new explicit start after STOPPED gets a new UUID/deadline; the old window is immutable.
  now += 10_000;
  const resumedStart = now;
  const resumed = await guard.start(workspaceA, { sessionBinding: 'transport-b' });
  assert.notEqual(resumed.work_window_id, first.work_window_id);
  assert.equal(resumed.deadline, new Date(resumedStart + WORK_WINDOW_DURATION_MS).toISOString());
  assert.equal((await guard.status(workspaceA, first.work_window_id)).deadline, originalDeadline);
  await guard.stop(workspaceA, resumed.work_window_id);

  // F. Concurrent same-workspace start allows exactly one winner.
  now += 1_000;
  const concurrent = await Promise.allSettled([
    guard.start(workspaceA),
    guard.start(workspaceA),
    guard.start(workspaceA)
  ]);
  const fulfilled = concurrent.filter((item) => item.status === 'fulfilled');
  const rejected = concurrent.filter((item) => item.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 2);
  for (const item of rejected) assert.match(String(item.reason?.message ?? item.reason), /already ACTIVE|parallel continuation/i);
  const concurrentWinner = fulfilled[0].value;
  assert.equal((await guard.listActive(workspaceA)).filter((item) => item.state === 'ACTIVE').length, 1);

  // G. Cross-workspace window remains independent.
  const cross = await guard.start(workspaceB);
  assert.equal((await guard.listActive(workspaceB)).some((item) => item.work_window_id === cross.work_window_id), true);
  assert.equal((await guard.listActive(workspaceA)).some((item) => item.work_window_id === cross.work_window_id), false);

  // H. Exact deadline is terminal; reconciliation durably auto-stops and checkpoint remains writable afterward.
  const winnerStart = Date.parse(concurrentWinner.started_at);
  now = winnerStart + WORK_WINDOW_DURATION_MS;
  assert.equal((await guard.status(workspaceA, concurrentWinner.work_window_id)).state, 'EXPIRED');
  const expiredError = await expectReject(() => guard.assertContinuationAllowed(workspaceA), /STOPPED/);
  assert.equal(expiredError.details?.must_stop, true);
  const autoStopped = await guard.status(workspaceA, concurrentWinner.work_window_id);
  assert.equal(autoStopped.state, 'STOPPED');
  assert.equal(autoStopped.stop_reason, 'DEADLINE_AUTO');
  assert.equal(autoStopped.stopped_at, concurrentWinner.deadline);
  const expiredCheckpoint = await guard.checkpoint(workspaceA, concurrentWinner.work_window_id, {
    completed: ['active work'],
    pending: ['next user turn'],
    resumeFrom: 'STOPPED'
  });
  assert.equal(expiredCheckpoint.state, 'STOPPED');
  assert.equal(expiredCheckpoint.stop_reason, 'DEADLINE_AUTO');
  assert.equal(expiredCheckpoint.deadline, concurrentWinner.deadline);
  assert.deepEqual(expiredCheckpoint.checkpoint?.completed, ['active work']);

  // I. A fresh explicit start after terminal STOPPED restores ACTIVE and keeps bash clamped to drain.
  now += 10_000;
  const bashStart = now;
  const bashWindow = await guard.start(workspaceA);
  now = bashStart + WORK_WINDOW_ACTIVE_MS - 5_000;
  const clamped = await guard.effectiveBashTimeout(workspaceA, bashWindow.work_window_id, 20_000, 60_000);
  assert.equal(clamped.timeoutMs, 5_000);
  now = bashStart + WORK_WINDOW_ACTIVE_MS - (WORK_WINDOW_MIN_BASH_BUDGET_MS - 1);
  await expectReject(
    () => guard.effectiveBashTimeout(workspaceA, bashWindow.work_window_id, 20_000, 60_000),
    /less than 1000 ms ACTIVE budget/i
  );

  // J. Concurrent checkpoints still serialize while ACTIVE.
  now = bashStart + 1_000;
  await Promise.all([
    guard.checkpoint(workspaceA, bashWindow.work_window_id, { completed: ['a'], pending: ['b'] }),
    recovered.checkpoint(workspaceA, bashWindow.work_window_id, { completed: ['c'], pending: ['d'] })
  ]);
  const afterConcurrentCheckpoint = await guard.status(workspaceA, bashWindow.work_window_id);
  assert(afterConcurrentCheckpoint.checkpoint);
  assert(
    JSON.stringify(afterConcurrentCheckpoint.checkpoint.completed) === JSON.stringify(['a']) ||
      JSON.stringify(afterConcurrentCheckpoint.checkpoint.completed) === JSON.stringify(['c'])
  );

  // K. Explicit stop preserves immutable deadlines, excludes list, and blocks continuation.
  const beforeStop = await guard.status(workspaceA, bashWindow.work_window_id);
  const stopped = await guard.stop(workspaceA, bashWindow.work_window_id);
  assert.equal(stopped.state, 'STOPPED');
  assert.equal(stopped.started_at, beforeStop.started_at);
  assert.equal(stopped.drain_at, beforeStop.drain_at);
  assert.equal(stopped.deadline, beforeStop.deadline);
  assert.equal((await guard.listActive(workspaceA)).some((item) => item.work_window_id === stopped.work_window_id), false);
  await expectReject(() => guard.assertMutationAllowed(workspaceA, stopped.work_window_id), /STOPPED/);
  const stoppedCheckpoint = await guard.checkpoint(workspaceA, stopped.work_window_id, {
    completed: ['final report'],
    pending: []
  });
  assert.equal(stoppedCheckpoint.state, 'STOPPED');
  assert.equal(stoppedCheckpoint.stop_reason, 'MANUAL');
  assert.deepEqual(stoppedCheckpoint.checkpoint?.completed, ['final report']);
  await expectReject(() => guard.assertContinuationAllowed(workspaceA), /STOPPED/);

  // L. Corrupt durable state fails closed and is not silently replaced.
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
  await expectReject(() => corruptGuard.assertContinuationAllowed(workspaceA), /Corrupt Work Window registry JSON/);

  // M. Corrupt host identity fails closed; no silent host remint.
  const corruptHostHome = path.join(tmp, 'corrupt-host');
  await fs.mkdir(corruptHostHome, { recursive: true });
  await fs.writeFile(path.join(corruptHostHome, 'host.json'), '{"version":1,"host_id":"bad"}\n', 'utf8');
  const corruptHostGuard = new WorkWindowGuard({ homeDir: corruptHostHome, now: () => now, uuid: sequenceUuid(UUIDS.slice(12)) });
  await expectReject(() => corruptHostGuard.start(workspaceA), /strict UUID|Corrupt|host/i);
  const hostAfter = await fs.readFile(path.join(corruptHostHome, 'host.json'), 'utf8');
  assert.match(hostAfter, /"bad"/);

  // N. Restart recovery durably terminalizes an overdue unstopped record at the immutable deadline.
  const recoveryHome = path.join(tmp, 'restart-recovery');
  let recoveryNow = 1_900_000_000_000;
  const recoveryGuard = new WorkWindowGuard({
    homeDir: recoveryHome,
    now: () => recoveryNow,
    uuid: sequenceUuid([
      '12121212-1212-4212-8212-121212121212',
      '13131313-1313-4313-8313-131313131313'
    ])
  });
  const recoveryWindow = await recoveryGuard.start(workspaceA);
  recoveryNow = Date.parse(recoveryWindow.deadline) + 1_000;
  const restartedGuard = new WorkWindowGuard({ homeDir: recoveryHome, now: () => recoveryNow });
  await restartedGuard.initialize();
  const recoveredDeadlineStop = await restartedGuard.status(workspaceA, recoveryWindow.work_window_id);
  assert.equal(recoveredDeadlineStop.state, 'STOPPED');
  assert.equal(recoveredDeadlineStop.stop_reason, 'DEADLINE_AUTO');
  assert.equal(recoveredDeadlineStop.stopped_at, recoveryWindow.deadline);
  const recoveredCheckpoint = await restartedGuard.checkpoint(workspaceA, recoveryWindow.work_window_id, {
    completed: ['recovered after restart'],
    pending: ['new user turn']
  });
  assert.equal(recoveredCheckpoint.state, 'STOPPED');
  assert.equal(recoveredCheckpoint.stop_reason, 'DEADLINE_AUTO');

  // O. The scheduled deadline callback terminalizes without requiring another MCP request.
  const timerHome = path.join(tmp, 'timer-terminalization');
  let timerNow = 2_000_000_000_000;
  let deadlineCallback;
  let scheduledDelay = -1;
  const timerGuard = new WorkWindowGuard({
    homeDir: timerHome,
    now: () => timerNow,
    uuid: sequenceUuid([
      '14141414-1414-4414-8414-141414141414',
      '15151515-1515-4515-8515-151515151515'
    ]),
    setTimer: (callback, delayMs) => {
      deadlineCallback = callback;
      scheduledDelay = delayMs;
      return { unref() {} };
    },
    clearTimer: () => {}
  });
  const timerWindow = await timerGuard.start(workspaceA);
  assert.equal(scheduledDelay, WORK_WINDOW_DURATION_MS);
  timerNow = Date.parse(timerWindow.deadline);
  assert.equal(typeof deadlineCallback, 'function');
  deadlineCallback();
  const timerRecordPath = path.join(timerHome, 'windows', `${timerWindow.work_window_id}.json`);
  let timerRecord;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    timerRecord = JSON.parse(await fs.readFile(timerRecordPath, 'utf8'));
    if (timerRecord.stop_reason === 'DEADLINE_AUTO') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(timerRecord.stop_reason, 'DEADLINE_AUTO');
  assert.equal(timerRecord.stopped_at, timerWindow.deadline);

  console.log('work-window-guard-smoke: PASS (A-O)');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
