import assert from "node:assert/strict";
import {
  NETWORK_HEALTH_CLASSIFICATIONS,
  classifyNetworkHealth
} from "../src/networkHealthModel.ts";

assert.deepEqual(NETWORK_HEALTH_CLASSIFICATIONS, [
  "HEALTHY_DUAL",
  "PRIMARY_DEGRADED_BACKUP_AVAILABLE",
  "BACKUP_DEGRADED_PRIMARY_AVAILABLE",
  "TRANSPORTS_DOWN_RUNTIME_HEALTHY",
  "RUNTIME_FAILURE"
]);

const cases = [
  [
    {
      runtime_healthy: true,
      primary_available: true,
      backup_available: true
    },
    "HEALTHY_DUAL"
  ],
  [
    {
      runtime_healthy: true,
      primary_available: false,
      backup_available: true
    },
    "PRIMARY_DEGRADED_BACKUP_AVAILABLE"
  ],
  [
    {
      runtime_healthy: true,
      primary_available: true,
      backup_available: false
    },
    "BACKUP_DEGRADED_PRIMARY_AVAILABLE"
  ],
  [
    {
      runtime_healthy: true,
      primary_available: false,
      backup_available: false
    },
    "TRANSPORTS_DOWN_RUNTIME_HEALTHY"
  ],
  [
    {
      runtime_healthy: false,
      primary_available: false,
      backup_available: false
    },
    "RUNTIME_FAILURE"
  ]
];

for (const [input, expected] of cases) {
  assert.equal(classifyNetworkHealth(input), expected);
  assert.equal(classifyNetworkHealth({ ...input }), expected);
}

for (const invalid of [
  null,
  [],
  "healthy",
  {},
  {
    runtime_healthy: true,
    primary_available: true
  },
  {
    runtime_healthy: "yes",
    primary_available: true,
    backup_available: true
  },
  {
    runtime_healthy: true,
    primary_available: 1,
    backup_available: true
  },
  {
    runtime_healthy: true,
    primary_available: true,
    backup_available: null
  },
  {
    runtime_healthy: true,
    primary_available: true,
    backup_available: true,
    extra: false
  }
]) {
  assert.throws(() => classifyNetworkHealth(invalid));
}

for (const ambiguous of [
  {
    runtime_healthy: false,
    primary_available: true,
    backup_available: false
  },
  {
    runtime_healthy: false,
    primary_available: false,
    backup_available: true
  },
  {
    runtime_healthy: false,
    primary_available: true,
    backup_available: true
  }
]) {
  assert.throws(
    () => classifyNetworkHealth(ambiguous),
    /ambiguous/
  );
}

console.log("network-health-model-smoke: PASS");
