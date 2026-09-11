import assert from 'node:assert/strict';
import { DedicatedChromeStartController, DEDICATED_CHROME_CONFIRM } from '../dist/dedicatedChromeOps.js';

function makeRuntime({ probes = [], executableExists = true, launch }) {
  let probeIndex = 0;
  return {
    platform: 'win32',
    executableExists: () => executableExists,
    probeCdp: async () => {
      const value = probeIndex < probes.length ? probes[probeIndex] : probes.at(-1) ?? false;
      probeIndex += 1;
      return value;
    },
    launch,
    sleep: async () => {}
  };
}

{
  let probes = 0;
  let launches = 0;
  const controller = new DedicatedChromeStartController({
    platform: 'win32',
    executableExists: () => true,
    probeCdp: async () => {
      probes += 1;
      return false;
    },
    launch: async () => {
      launches += 1;
      return 1001;
    },
    sleep: async () => {}
  });
  const result = await controller.run({ confirm: DEDICATED_CHROME_CONFIRM, dryRun: true });
  assert.equal(result.status, 'DRY_RUN');
  assert.equal(result.launchCount, 0);
  assert.equal(result.cdpReady, null);
  assert.equal(probes, 0);
  assert.equal(launches, 0);
}

{
  let launches = 0;
  const controller = new DedicatedChromeStartController(
    makeRuntime({
      probes: [true],
      launch: async () => {
        launches += 1;
        return 1002;
      }
    })
  );
  const result = await controller.run({ confirm: DEDICATED_CHROME_CONFIRM, dryRun: false });
  assert.equal(result.status, 'ALREADY_HEALTHY');
  assert.equal(result.cdpReady, true);
  assert.equal(result.launchAttempted, false);
  assert.equal(result.launchCount, 0);
  assert.equal(launches, 0);
}

{
  let launches = 0;
  const controller = new DedicatedChromeStartController(
    makeRuntime({
      probes: [false, true],
      launch: async () => {
        launches += 1;
        return 1003;
      }
    })
  );
  const result = await controller.run({ confirm: DEDICATED_CHROME_CONFIRM, dryRun: false });
  assert.equal(result.status, 'READY');
  assert.equal(result.cdpReady, true);
  assert.equal(result.launchAttempted, true);
  assert.equal(result.launchCount, 1);
  assert.equal(result.pid, 1003);
  assert.equal(launches, 1);
}

{
  let launches = 0;
  const runtime = makeRuntime({
    probes: [false],
    launch: async () => {
      launches += 1;
      throw new Error('synthetic launch failure');
    }
  });
  const controller = new DedicatedChromeStartController(runtime);
  await assert.rejects(
    controller.run({ confirm: DEDICATED_CHROME_CONFIRM, dryRun: false }),
    /launch attempt failed; automatic retry is forbidden/
  );
  await assert.rejects(
    controller.run({ confirm: DEDICATED_CHROME_CONFIRM, dryRun: false }),
    /already attempted by this CodexPro runtime/
  );
  assert.equal(launches, 1);
}

{
  let launches = 0;
  const runtime = makeRuntime({
    probes: [false],
    launch: async () => {
      launches += 1;
      return 1004;
    }
  });
  const controller = new DedicatedChromeStartController(runtime);
  await assert.rejects(
    controller.run({ confirm: DEDICATED_CHROME_CONFIRM, dryRun: false }),
    /launched exactly once but loopback CDP did not become ready/
  );
  await assert.rejects(
    controller.run({ confirm: DEDICATED_CHROME_CONFIRM, dryRun: false }),
    /already attempted by this CodexPro runtime/
  );
  assert.equal(launches, 1);
}

console.log('dedicated-chrome-smoke: PASS');
