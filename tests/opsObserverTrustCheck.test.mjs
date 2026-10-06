// The ops-observer trust check (docs/policy/sre-ops.md §3-7): a sound chain is
// trusted, every single broken fact makes it untrusted with that check's
// reason, the checks run in the fixed T0..T5 order, and nothing missing or
// malformed ever passes.

import assert from "node:assert/strict";
import test from "node:test";

import {
  GENESIS_AUDIT_ACTION,
  GENESIS_AUDIT_TARGET_TYPE,
  GENESIS_MIN_INTERVAL_MS,
  TRUST_REASONS,
  genesisTooSoon,
  judgeTrust,
} from "../scripts/ops-observer/trust-check-core.mjs";
import { OPS_OBSERVER_INVARIANT_VERSION } from "../scripts/ops-observer/genesis-core.mjs";

const GENESIS_ID = "11111111-1111-4111-8111-111111111111";
const PREVIOUS_ID = "22222222-2222-4222-8222-222222222222";
const DIGEST = "a".repeat(64);
const KEYS_SHA = "b".repeat(64);
const CHECKPOINT_SHA = "d".repeat(64);
const CREATED = new Date("2026-10-10T00:00:00.000Z");

function soundFacts() {
  return {
    auditKeyCount: 1,
    genesis: {
      id: GENESIS_ID,
      createdAt: CREATED,
      mode: "shadow",
      requestDigest: DIGEST,
      supersedesGenesisId: PREVIOUS_ID,
    },
    previousGenesisCreatedAt: new Date(CREATED.getTime() - GENESIS_MIN_INTERVAL_MS),
    state: {
      genesisId: GENESIS_ID,
      generation: 4,
      invariantVersion: OPS_OBSERVER_INVARIANT_VERSION,
      stampGeneration: 4,
      stampKeysSha256: KEYS_SHA,
      stampCheckpointSha256: CHECKPOINT_SHA,
    },
    genesisAuditRows: [
      {
        action: GENESIS_AUDIT_ACTION,
        targetType: GENESIS_AUDIT_TARGET_TYPE,
        targetId: GENESIS_ID,
        actorKind: "human",
        metadata: { requestDigest: DIGEST, supersedesGenesisId: PREVIOUS_ID, mode: "shadow" },
        hashVerified: true,
      },
    ],
    keysSchemaValid: true,
    catalogComplete: true,
    recomputedKeysSha256: KEYS_SHA,
    recomputedCheckpointSha256: CHECKPOINT_SHA,
    transitionVerdict: null,
    deliveries: [
      { invariantVersion: OPS_OBSERVER_INVARIANT_VERSION, status: "reserved", stampStatus: "reserved", mode: "shadow" },
    ],
  };
}

const untrusted = (facts) => {
  const verdict = judgeTrust(facts);
  assert.equal(verdict.trusted, false);
  assert.ok(TRUST_REASONS.includes(verdict.reason), verdict.reason);
  return verdict.reason;
};

const edit = (mutate) => {
  const facts = soundFacts();
  mutate(facts);
  return facts;
};

test("a sound chain is trusted, including a first genesis and no open deliveries", () => {
  assert.deepEqual(judgeTrust(soundFacts()), { trusted: true });
  assert.deepEqual(
    judgeTrust(
      edit((f) => {
        f.previousGenesisCreatedAt = null;
        f.genesis.supersedesGenesisId = null;
        f.genesisAuditRows[0].metadata.supersedesGenesisId = null;
        f.deliveries = [];
      }),
    ),
    { trusted: true },
  );
});

test("each broken fact names its own check's reason", () => {
  const cases = [
    ["audit_key_missing", (f) => (f.auditKeyCount = 0)],
    ["state_missing", (f) => (f.genesis = null)],
    ["state_missing", (f) => (f.state = null)],
    ["state_missing", (f) => (f.state.genesisId = PREVIOUS_ID)],
    ["genesis_unapproved", (f) => (f.genesisAuditRows = [])],
    ["genesis_unapproved", (f) => f.genesisAuditRows.push({ ...f.genesisAuditRows[0] })],
    ["genesis_unapproved", (f) => (f.genesisAuditRows[0].actorKind = "unknown")],
    ["genesis_unapproved", (f) => (f.genesisAuditRows[0].actorKind = "system")],
    ["genesis_unapproved", (f) => (f.genesisAuditRows[0].action = "ops_observer.state_advanced")],
    ["genesis_unapproved", (f) => (f.genesisAuditRows[0].targetId = PREVIOUS_ID)],
    ["genesis_unapproved", (f) => (f.genesisAuditRows[0].metadata.requestDigest = "c".repeat(64))],
    ["genesis_unapproved", (f) => (f.genesisAuditRows[0].metadata.supersedesGenesisId = null)],
    ["genesis_unapproved", (f) => (f.genesisAuditRows[0].metadata.mode = "live")],
    ["audit_unverified", (f) => (f.genesisAuditRows[0].hashVerified = false)],
    ["schema", (f) => (f.keysSchemaValid = false)],
    ["invariants_missing", (f) => (f.catalogComplete = false)],
    ["unenforced_write", (f) => (f.state.invariantVersion = OPS_OBSERVER_INVARIANT_VERSION + 1)],
    ["unenforced_write", (f) => (f.state.stampGeneration = 3)],
    ["unenforced_write", (f) => (f.recomputedKeysSha256 = "c".repeat(64))],
    ["unenforced_write", (f) => (f.recomputedCheckpointSha256 = "c".repeat(64))],
    ["unenforced_write", (f) => (f.state.stampCheckpointSha256 = "c".repeat(64))],
    ["unaudited_transition", (f) => (f.transitionVerdict = "unaudited_transition")],
    ["checkpoint_broken", (f) => (f.transitionVerdict = "checkpoint_broken")],
    ["audit_unverified", (f) => (f.transitionVerdict = "audit_unverified")],
    ["unenforced_write", (f) => (f.deliveries[0].stampStatus = "confirmed")],
    ["unenforced_write", (f) => (f.deliveries[0].mode = "live")],
    ["unenforced_write", (f) => (f.deliveries[0].invariantVersion = 0)],
    ["genesis_too_soon", (f) => (f.previousGenesisCreatedAt = new Date(CREATED.getTime() - GENESIS_MIN_INTERVAL_MS + 1))],
  ];
  for (const [reason, mutate] of cases) {
    assert.equal(untrusted(edit(mutate)), reason, String(mutate));
  }
});

test("a missing or malformed fact fails closed rather than passing", () => {
  const removals = [
    "auditKeyCount",
    "genesisAuditRows",
    "keysSchemaValid",
    "catalogComplete",
    "recomputedKeysSha256",
    "recomputedCheckpointSha256",
    "transitionVerdict",
    "deliveries",
    "previousGenesisCreatedAt",
  ];
  for (const key of removals) {
    untrusted(edit((f) => delete f[key]));
  }
  for (const [key, value] of [
    ["keysSchemaValid", "true"],
    ["catalogComplete", 1],
    ["transitionVerdict", "something_else"],
    ["auditKeyCount", 1.5],
  ]) {
    untrusted(edit((f) => (f[key] = value)));
  }
  untrusted(edit((f) => (f.genesisAuditRows = [null])));
  untrusted(edit((f) => (f.genesisAuditRows[0].metadata = null)));
  untrusted(edit((f) => (f.genesisAuditRows[0].hashVerified = "true")));
  untrusted(edit((f) => (f.deliveries = [null])));
  untrusted(edit((f) => (f.genesis.mode = "paused")));
  untrusted(edit((f) => (f.genesis.createdAt = new Date(Number.NaN))));
  untrusted(undefined);
  untrusted({});
});

test("absent approval fields never match each other", () => {
  for (const field of ["requestDigest", "supersedesGenesisId"]) {
    assert.equal(
      untrusted(
        edit((f) => {
          delete f.genesis[field];
          delete f.genesisAuditRows[0].metadata[field];
        }),
      ),
      "state_missing",
      field,
    );
  }
  assert.equal(untrusted(edit((f) => (f.genesis.requestDigest = "A".repeat(64)))), "state_missing");
  assert.equal(untrusted(edit((f) => (f.genesis.supersedesGenesisId = "not-a-uuid"))), "state_missing");
  assert.equal(untrusted(edit((f) => delete f.genesis.createdAt)), "state_missing");
});

test("only the first genesis may come without a predecessor time", () => {
  // A replacing genesis whose predecessor lookup came back empty cannot skip D5b.
  assert.equal(untrusted(edit((f) => (f.previousGenesisCreatedAt = null))), "genesis_too_soon");
  // A first genesis that somehow has a predecessor time is inconsistent.
  assert.equal(
    untrusted(
      edit((f) => {
        f.genesis.supersedesGenesisId = null;
        f.genesisAuditRows[0].metadata.supersedesGenesisId = null;
      }),
    ),
    "genesis_too_soon",
  );
});

test("the first failing check in T0..T5 order names the reason", () => {
  const facts = edit((f) => {
    f.keysSchemaValid = false;
    f.catalogComplete = false;
    f.transitionVerdict = "checkpoint_broken";
    f.previousGenesisCreatedAt = CREATED;
  });
  assert.equal(untrusted(facts), "schema");
  facts.auditKeyCount = 0;
  assert.equal(untrusted(facts), "audit_key_missing");
});

test("seven days to the millisecond is the boundary of genesis_too_soon", () => {
  const previous = new Date("2026-10-01T00:00:00.000Z");
  const at = (ms) => ({ createdAt: new Date(previous.getTime() + ms), supersedesGenesisId: PREVIOUS_ID });
  assert.equal(genesisTooSoon(at(GENESIS_MIN_INTERVAL_MS), previous), false);
  assert.equal(genesisTooSoon(at(GENESIS_MIN_INTERVAL_MS - 1), previous), true);
  assert.equal(genesisTooSoon({ createdAt: previous, supersedesGenesisId: null }, null), false);
  assert.equal(genesisTooSoon({ createdAt: previous, supersedesGenesisId: PREVIOUS_ID }, null), true);
  assert.equal(genesisTooSoon({ supersedesGenesisId: null }, null), true);
});

test("the reasons are the closed list the design names", () => {
  assert.deepEqual([...TRUST_REASONS].sort(), [
    "audit_key_missing",
    "audit_unverified",
    "checkpoint_broken",
    "genesis_too_soon",
    "genesis_unapproved",
    "invariants_missing",
    "schema",
    "state_missing",
    "unaudited_transition",
    "unenforced_write",
  ]);
  assert.ok(Object.isFrozen(TRUST_REASONS));
});
