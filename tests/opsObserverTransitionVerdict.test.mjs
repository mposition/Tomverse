// T3c of the ops-observer trust check: the ledger since the checkpoint is
// complete, each row names the signed ops-observer state advance it records,
// the checkpoint agrees with its own row, and anything missing fails.

import assert from "node:assert/strict";
import test from "node:test";

import { transitionVerdict } from "../scripts/ops-observer/transition-verdict-core.mjs";

const GENESIS = "11111111-1111-4111-8111-111111111111";
const hex = (c) => c.repeat(64);

/** A chain at generation 4 with its checkpoint at 3: ledger rows 3 and 4. */
function chain({ generation = 4, checkpoint = 3 } = {}) {
  const ledgerRows = [];
  const auditRows = [];
  for (let g = Math.max(1, checkpoint); g <= generation; g += 1) {
    const id = `audit-${g}`;
    const entryHash = hex(String(g % 10));
    const keysSha256 = hex(String.fromCharCode(97 + g));
    ledgerRows.push({ generation: g, auditLogId: id, auditEntryHash: entryHash, keysSha256 });
    auditRows.push({
      id,
      entryHash,
      action: "ops_observer.state_advanced",
      targetType: "OpsObserverState",
      targetId: GENESIS,
      actorKind: "system",
      metadata: { systemActor: "ops-observer", generation: g, keysSha256 },
      hashVerified: true,
    });
  }
  const anchor = ledgerRows.find((r) => r.generation === checkpoint);
  const state = {
    genesisId: GENESIS,
    generation,
    stampKeysSha256: generation > 0 ? ledgerRows.at(-1).keysSha256 : hex("0"),
    verifiedThroughGeneration: checkpoint,
    verifiedThroughAuditId: anchor?.auditLogId ?? null,
    verifiedThroughAuditHash: anchor?.auditEntryHash ?? null,
  };
  return { state, ledgerRows, auditRows };
}

const edited = (mutate, shape) => {
  const facts = chain(shape);
  mutate(facts);
  return transitionVerdict(facts);
};

test("a complete chain since the checkpoint passes, including a fresh genesis and checkpoint 0", () => {
  assert.equal(transitionVerdict(chain()), null);
  assert.equal(transitionVerdict(chain({ generation: 0, checkpoint: 0 })), null);
  assert.equal(transitionVerdict(chain({ generation: 2, checkpoint: 0 })), null);
  assert.equal(transitionVerdict(chain({ generation: 3, checkpoint: 3 })), null);
});

test("each broken fact names its reason", () => {
  const cases = [
    // The checkpoint and its own row.
    ["checkpoint_broken", (f) => f.ledgerRows.splice(0, 1)],
    ["checkpoint_broken", (f) => (f.state.verifiedThroughAuditId = "audit-x")],
    ["checkpoint_broken", (f) => (f.state.verifiedThroughAuditHash = hex("f"))],
    ["checkpoint_broken", (f) => (f.auditRows[0].entryHash = hex("f"))],
    ["checkpoint_broken", (f) => (f.state.verifiedThroughGeneration = 5)],
    // A named audit row that was not found.
    ["checkpoint_broken", (f) => f.auditRows.splice(1, 1)],
    // Coverage.
    ["unaudited_transition", (f) => f.ledgerRows.splice(1, 1)],
    ["unaudited_transition", (f) => f.ledgerRows.push({ ...f.ledgerRows[1] })],
    ["unaudited_transition", (f) => f.ledgerRows.push({ ...f.ledgerRows[1], generation: 5 })],
    ["unaudited_transition", (f) => (f.state.generation = 5)],
    // The audit entry of each row.
    ["audit_unverified", (f) => (f.auditRows[1].hashVerified = false)],
    ["audit_unverified", (f) => (f.auditRows[1].entryHash = null)],
    ["unaudited_transition", (f) => (f.auditRows[1].action = "ops_observer.genesis_created")],
    ["unaudited_transition", (f) => (f.auditRows[1].targetType = "OpsObserverGenesis")],
    ["unaudited_transition", (f) => (f.auditRows[1].targetId = "22222222-2222-4222-8222-222222222222")],
    ["unaudited_transition", (f) => (f.auditRows[1].actorKind = "human")],
    ["unaudited_transition", (f) => (f.auditRows[1].actorKind = "unknown")],
    ["unaudited_transition", (f) => (f.auditRows[1].metadata.systemActor = "marketing-publisher")],
    ["unaudited_transition", (f) => (f.auditRows[1].metadata.generation = 3)],
    ["unaudited_transition", (f) => (f.auditRows[1].metadata.keysSha256 = hex("f"))],
    ["unaudited_transition", (f) => (f.auditRows[1].metadata = null)],
    ["unaudited_transition", (f) => (f.ledgerRows[1].auditEntryHash = hex("e"))],
    // The newest row against the state's stamp.
    ["unaudited_transition", (f) => (f.state.stampKeysSha256 = hex("f"))],
  ];
  for (const [reason, mutate] of cases) {
    assert.equal(edited(mutate), reason, String(mutate));
  }
});

test("the checkpoint row gets the same audit checks as every other row", () => {
  assert.equal(edited((f) => (f.auditRows[0].hashVerified = false)), "audit_unverified");
  assert.equal(edited((f) => (f.auditRows[0].actorKind = "human")), "unaudited_transition");
});

test("absent stamps and hashes never match each other", () => {
  // generation 1, checkpoint 0: every key stamp omitted on all three sides.
  const facts = chain({ generation: 1, checkpoint: 0 });
  delete facts.ledgerRows[0].keysSha256;
  delete facts.auditRows[0].metadata.keysSha256;
  delete facts.state.stampKeysSha256;
  assert.equal(transitionVerdict(facts), "unaudited_transition");
  for (const mutate of [
    (f) => {
      delete f.ledgerRows[1].auditEntryHash;
      delete f.auditRows[1].entryHash;
    },
    (f) => {
      delete f.ledgerRows[1].keysSha256;
      delete f.auditRows[1].metadata.keysSha256;
    },
    (f) => {
      delete f.ledgerRows[1].auditLogId;
      delete f.auditRows[1].id;
    },
    (f) => {
      delete f.state.genesisId;
      delete f.auditRows[1].targetId;
    },
    (f) => (f.auditRows[1].metadata.generation = "4"),
    (f) => (f.ledgerRows[1].keysSha256 = "A".repeat(64)),
  ]) {
    assert.notEqual(edited(mutate), null, String(mutate));
  }
});

test("missing or malformed facts fail", () => {
  for (const facts of [
    {},
    { state: null, ledgerRows: [], auditRows: [] },
    { state: chain().state, ledgerRows: null, auditRows: [] },
    { ...chain(), auditRows: undefined },
  ]) {
    assert.notEqual(transitionVerdict(facts), null);
  }
  assert.notEqual(edited((f) => f.ledgerRows.push(null)), null);
  assert.notEqual(edited((f) => (f.state.generation = -1)), null);
  assert.notEqual(edited((f) => (f.state.verifiedThroughGeneration = 1.5)), null);
});
