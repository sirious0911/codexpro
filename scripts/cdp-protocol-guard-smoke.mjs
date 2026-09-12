import assert from "node:assert/strict";
import {
  CDP_PROTOCOL_LOCAL_PAGE_PREFIX,
  CDP_PROTOCOL_MAX_MESSAGE_BYTES,
  parseCdpResponseEnvelope,
  serializeCdpRequestEnvelope,
  validateCdpMethodName,
  validateCdpRequestId,
  validateCdpTargetId,
  validateLocalPageDevtoolsUrl
} from "../src/cdpProtocolGuard.ts";

assert.equal(validateCdpTargetId("PAGE_1"), "PAGE_1");
assert.equal(validateCdpTargetId("page:1.test"), "page:1.test");
assert.throws(() => validateCdpTargetId(""), /invalid or out of bounds/);
assert.throws(() => validateCdpTargetId("bad id"), /invalid or out of bounds/);
assert.throws(
  () => validateCdpTargetId("x".repeat(257)),
  /invalid or out of bounds/
);

assert.equal(
  validateLocalPageDevtoolsUrl(
    "ws://127.0.0.1:9223/devtools/page/PAGE_1",
    "PAGE_1"
  ),
  CDP_PROTOCOL_LOCAL_PAGE_PREFIX + "PAGE_1"
);
assert.throws(
  () =>
    validateLocalPageDevtoolsUrl(
      "ws://localhost:9223/devtools/page/PAGE_1",
      "PAGE_1"
    ),
  /fixed local page target/
);
assert.throws(
  () =>
    validateLocalPageDevtoolsUrl(
      "ws://127.0.0.1:9223/devtools/page/PAGE_2",
      "PAGE_1"
    ),
  /fixed local page target/
);
assert.throws(
  () =>
    validateLocalPageDevtoolsUrl(
      "wss://127.0.0.1:9223/devtools/page/PAGE_1",
      "PAGE_1"
    ),
  /fixed local page target/
);

assert.equal(validateCdpRequestId(1), 1);
assert.equal(validateCdpRequestId(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
  assert.throws(() => validateCdpRequestId(bad), /positive safe integer/);
}

assert.equal(validateCdpMethodName("Page.getNavigationHistory"), "Page.getNavigationHistory");
assert.equal(validateCdpMethodName("DOM.getDocument"), "DOM.getDocument");
assert.throws(() => validateCdpMethodName(""), /invalid or out of bounds/);
assert.throws(() => validateCdpMethodName("Page getDocument"), /invalid or out of bounds/);
assert.throws(() => validateCdpMethodName("x".repeat(129)), /invalid or out of bounds/);

assert.equal(
  serializeCdpRequestEnvelope({
    id: 7,
    method: "DOM.getDocument",
    params: { depth: 0 }
  }),
  '{"id":7,"method":"DOM.getDocument","params":{"depth":0}}'
);
assert.throws(
  () =>
    serializeCdpRequestEnvelope({
      id: 1,
      method: "DOM.getDocument",
      params: []
    }),
  /plain object/
);
assert.throws(
  () =>
    serializeCdpRequestEnvelope(
      {
        id: 1,
        method: "DOM.getDocument",
        params: { payload: "x".repeat(CDP_PROTOCOL_MAX_MESSAGE_BYTES) }
      },
      128
    ),
  /bounded message size/
);

assert.deepEqual(
  parseCdpResponseEnvelope('{"id":9,"result":{"nodeId":42}}', 9),
  {
    id: 9,
    result: { nodeId: 42 }
  }
);
assert.throws(
  () => parseCdpResponseEnvelope('{"id":10,"result":{}}', 9),
  /does not match/
);
assert.throws(
  () => parseCdpResponseEnvelope('{"id":9,"error":{"message":"synthetic"}}', 9),
  /contains an error/
);
assert.throws(
  () => parseCdpResponseEnvelope('{"id":9}', 9),
  /missing result/
);
assert.throws(
  () => parseCdpResponseEnvelope("{", 9),
  /malformed JSON/
);
assert.throws(
  () => parseCdpResponseEnvelope("[]", 9),
  /plain object/
);
assert.throws(
  () =>
    parseCdpResponseEnvelope(
      JSON.stringify({ id: 9, result: "x".repeat(256) }),
      9,
      64
    ),
  /bounded message size/
);

console.log("cdp-protocol-guard-smoke: PASS");
