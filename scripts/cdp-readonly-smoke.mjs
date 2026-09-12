import assert from 'node:assert/strict';
import {
  CDP_READONLY_HOST,
  CDP_READONLY_PORT,
  CDP_READONLY_VERSION_PATH,
  CDP_READONLY_LIST_PATH,
  CDP_READONLY_TIMEOUT_MS,
  CDP_READONLY_MAX_RESPONSE_BYTES,
  buildCdpReadonlyRequestSpec,
  requestCdpReadonlyJson
} from '../dist/cdpClient.js';
import {
  getCdpReadonlyStatus,
  listCdpReadonlyTargets
} from '../dist/cdpReadonlyOps.js';

{
  const spec = buildCdpReadonlyRequestSpec(CDP_READONLY_VERSION_PATH);
  assert.deepEqual(spec, {
    host: '127.0.0.1',
    port: 9223,
    path: '/json/version',
    method: 'GET',
    timeoutMs: CDP_READONLY_TIMEOUT_MS,
    maxResponseBytes: CDP_READONLY_MAX_RESPONSE_BYTES
  });
  assert.equal(CDP_READONLY_HOST, '127.0.0.1');
  assert.equal(CDP_READONLY_PORT, 9223);
  assert.throws(
    () => buildCdpReadonlyRequestSpec('/json/new'),
    /path is not allowed/
  );
}

{
  const calls = [];
  const runtime = {
    request: async (spec) => {
      calls.push(spec);
      return {
        statusCode: 200,
        body: JSON.stringify({
          Browser: 'Chrome/999',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/browser/private'
        })
      };
    }
  };

  const result = await getCdpReadonlyStatus(runtime);
  assert.deepEqual(result, {
    ready: true,
    endpoint: 'http://127.0.0.1:9223'
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].host, '127.0.0.1');
  assert.equal(calls[0].port, 9223);
  assert.equal(calls[0].path, CDP_READONLY_VERSION_PATH);
  assert.ok(!JSON.stringify(result).includes('Chrome/999'));
  assert.ok(!JSON.stringify(result).includes('webSocketDebuggerUrl'));
}

{
  const calls = [];
  const runtime = {
    request: async (spec) => {
      calls.push(spec);
      return {
        statusCode: 200,
        body: JSON.stringify([
          {
            id: 'ABC123',
            type: 'page',
            title: 'private title',
            url: 'https://private.example/path',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/ABC123'
          },
          {
            id: 'WORKER_2',
            type: 'service_worker',
            title: 'worker title',
            url: 'https://private.example/worker'
          },
          {
            id: 'bad id with spaces',
            type: 'page',
            title: 'must be dropped'
          },
          {
            id: 'MISSING_TYPE'
          }
        ])
      };
    }
  };

  const result = await listCdpReadonlyTargets(runtime);
  assert.deepEqual(result, {
    target_count: 2,
    targets: [
      { target_id: 'ABC123', type: 'page' },
      { target_id: 'WORKER_2', type: 'service_worker' }
    ]
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, CDP_READONLY_LIST_PATH);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('private title'));
  assert.ok(!serialized.includes('private.example'));
  assert.ok(!serialized.includes('webSocketDebuggerUrl'));
}

{
  let calls = 0;
  const runtime = {
    request: async () => {
      calls += 1;
      return { statusCode: 302, body: '{}' };
    }
  };
  await assert.rejects(
    requestCdpReadonlyJson(CDP_READONLY_VERSION_PATH, runtime),
    /redirects and non-200 responses are forbidden/
  );
  assert.equal(calls, 1);
}

{
  let calls = 0;
  const runtime = {
    request: async () => {
      calls += 1;
      return {
        statusCode: 200,
        body: 'x'.repeat(CDP_READONLY_MAX_RESPONSE_BYTES + 1)
      };
    }
  };
  await assert.rejects(
    requestCdpReadonlyJson(CDP_READONLY_VERSION_PATH, runtime),
    /response exceeded/
  );
  assert.equal(calls, 1);
}

{
  const runtime = {
    request: async () => ({
      statusCode: 200,
      body: JSON.stringify(Array.from({ length: 257 }, (_, i) => ({ id: String(i), type: 'page' })))
    })
  };
  await assert.rejects(
    listCdpReadonlyTargets(runtime),
    /bounded limit of 256/
  );
}

console.log('cdp-readonly-smoke: PASS');
