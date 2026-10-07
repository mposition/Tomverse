// Orchestration policy version 20 ("orchestrator 정지(halt)와 재시작"): the
// pure rules the store, the routes and the Admin screen share.
//
// docs/policy/development-agent-orchestration.md, version 20, sections 2, 4,
// 5 and 7. The database side of the same rules (admission, receipts under the
// row lock, the resolver, the clear) runs in the routing lane:
// tests/integration/amux-orchestration-halt.db.test.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  AMUX_ORCHESTRATOR_AUDIT_METADATA_KEYS,
  AMUX_ORCHESTRATOR_CALL_KINDS,
  AMUX_ORCHESTRATOR_DEADLINE_GRACE_MS,
  AMUX_ORCHESTRATOR_HALT_REASON_CODES,
  AMUX_ORCHESTRATOR_NOTHING_COMMITTED_REASONS,
  AMUX_ORCHESTRATOR_RECEIPT_TARGET_HREFS,
  AMUX_ORCHESTRATOR_RECEIPT_TARGET_KINDS,
  AMUX_ORCHESTRATOR_REQUEST_HALT_REASONS,
  AMUX_ORCHESTRATOR_RESOLUTIONS,
  amuxOrchestratorAuditMetadata,
  amuxOrchestratorHaltKeyPrefixMatches,
  decideAmuxOrchestratorAck,
  judgeAmuxOrchestratorWrite,
  parseAmuxOrchestratorHaltRecord,
  readAmuxOrchestratorWriteIdentity,
} from "../lib/amux/orchestratorHaltCore.ts";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

const REQUEST = "0b8e9a52-6d8c-4f0e-9b1a-2c3d4e5f6a7b";
const INSTANCE = "1c9f0b63-7e9d-4a1f-8c2b-3d4e5f6a7b8c";

test("the closed lists are the ones section 2 and section 4 name", () => {
  assert.deepEqual(AMUX_ORCHESTRATOR_HALT_REASON_CODES, [
    "claim_outcome_unknown",
    "recovery_outcome_unknown",
    "promotion_outcome_unknown",
    "unacked_write_receipt",
    "contract_violation",
    "selection_read_failures",
  ]);
  // The first four carry a request id (they have an admission if the call
  // reached the server); the last two carry none.
  assert.deepEqual(AMUX_ORCHESTRATOR_REQUEST_HALT_REASONS, AMUX_ORCHESTRATOR_HALT_REASON_CODES.slice(0, 4));
  assert.deepEqual(AMUX_ORCHESTRATOR_CALL_KINDS, ["claim", "recover", "auto_promotion_tick"]);
  assert.deepEqual(AMUX_ORCHESTRATOR_RECEIPT_TARGET_KINDS, [
    "work_item",
    "claim_decision",
    "execution_attempt",
    "auto_promotion_grant",
    "auto_promotion_consumption",
    "v22_promotion_receipt",
    "v22_promotion_unknown",
    "v22_promotion_halt",
    "v22_worker_assignment",
    "quota_observation_batch",
  ]);
  assert.deepEqual(AMUX_ORCHESTRATOR_RESOLUTIONS, ["no_commit", "human_confirmed"]);
  assert.deepEqual(AMUX_ORCHESTRATOR_NOTHING_COMMITTED_REASONS, [
    "amux_database_busy",
    "amux_database_deadline_exceeded",
    "amux_database_call_ceiling_exceeded",
  ]);
  assert.equal(AMUX_ORCHESTRATOR_DEADLINE_GRACE_MS, 5_000);
});

test("the orchestrator's Rust halt reasons and 503 reasons are the same closed lists", () => {
  const rust = read("apps/tomverse-orchestrator/src/orchestrator_halt.rs");
  for (const reason of AMUX_ORCHESTRATOR_HALT_REASON_CODES) {
    assert.match(rust, new RegExp(`=> "${reason}"`), reason);
  }
  assert.equal((rust.match(/^\s+Self::\w+ => "[a-z_]+",$/gm) ?? []).length >= 6, true);
  for (const reason of AMUX_ORCHESTRATOR_NOTHING_COMMITTED_REASONS) {
    assert.ok(rust.includes(`"${reason}"`), reason);
  }
  const api = read("apps/tomverse-orchestrator/src/tomverse_api.rs");
  assert.match(api, /"x-amux-request-id"/);
  assert.match(api, /"x-amux-instance-id"/);
});

test("a write without the identity headers is served as before; a partial or malformed identity is refused", () => {
  const headers = (entries) => new Headers(entries);
  assert.deepEqual(readAmuxOrchestratorWriteIdentity(headers({})), { kind: "legacy" });
  assert.deepEqual(
    readAmuxOrchestratorWriteIdentity(
      headers({ "x-amux-request-id": REQUEST, "x-amux-instance-id": INSTANCE }),
    ),
    { kind: "admitted", requestId: REQUEST, instanceId: INSTANCE },
  );
  for (const entries of [
    { "x-amux-request-id": REQUEST },
    { "x-amux-instance-id": INSTANCE },
    { "x-amux-request-id": REQUEST.toUpperCase(), "x-amux-instance-id": INSTANCE },
    { "x-amux-request-id": "not-a-uuid", "x-amux-instance-id": INSTANCE },
    { "x-amux-request-id": "", "x-amux-instance-id": INSTANCE },
  ]) {
    assert.deepEqual(readAmuxOrchestratorWriteIdentity(headers(entries)), { kind: "invalid" }, JSON.stringify(entries));
  }
});

test("the resolver waits out the deadline plus five seconds, then confirms a rollback only with no receipt", () => {
  const deadlineAtMs = 1_000_000;
  // Undecided before the deadline plus the grace, whatever the receipts.
  for (const receiptCount of [0, 1, 7]) {
    assert.equal(judgeAmuxOrchestratorWrite({ dbNowMs: deadlineAtMs, deadlineAtMs, receiptCount }), "pending");
    assert.equal(
      judgeAmuxOrchestratorWrite({ dbNowMs: deadlineAtMs + 4_999, deadlineAtMs, receiptCount }),
      "pending",
    );
  }
  // At the boundary and after it: no receipt is a confirmed rollback, any
  // receipt needs a person.
  assert.equal(judgeAmuxOrchestratorWrite({ dbNowMs: deadlineAtMs + 5_000, deadlineAtMs, receiptCount: 0 }), "no_commit");
  assert.equal(judgeAmuxOrchestratorWrite({ dbNowMs: deadlineAtMs + 5_000, deadlineAtMs, receiptCount: 1 }), "human_required");
  assert.equal(judgeAmuxOrchestratorWrite({ dbNowMs: deadlineAtMs + 60_000, deadlineAtMs, receiptCount: 3 }), "human_required");
});

test("a receipt refuses a no_commit acknowledgement and does not refuse a definite one", () => {
  // Section 4: `definite` answers a 2xx or a 409 refusal and succeeds even with
  // a receipt; `no_commit` answers the three 503 reasons and is refused with one.
  assert.deepEqual(decideAmuxOrchestratorAck({ kind: "definite", admission: { receiptCount: 2 } }), {
    acked: true,
    write: "set_acked",
  });
  assert.deepEqual(decideAmuxOrchestratorAck({ kind: "definite", admission: { receiptCount: 0 } }), {
    acked: true,
    write: "set_acked",
  });
  assert.deepEqual(decideAmuxOrchestratorAck({ kind: "no_commit", admission: { receiptCount: 0 } }), {
    acked: true,
    write: "set_acked",
  });
  for (const receiptCount of [1, 2, 100]) {
    assert.deepEqual(decideAmuxOrchestratorAck({ kind: "no_commit", admission: { receiptCount } }), {
      acked: false,
      reason: "receipts_present",
    });
  }
  // A request the server never admitted committed nothing; a definite answer
  // for it cannot come from this server.
  assert.deepEqual(decideAmuxOrchestratorAck({ kind: "no_commit", admission: null }), {
    acked: true,
    write: "none",
  });
  assert.deepEqual(decideAmuxOrchestratorAck({ kind: "definite", admission: null }), {
    acked: false,
    reason: "not_admitted",
  });
});

test("a halt record carries its request id exactly when its reason is about one write", () => {
  for (const reason of AMUX_ORCHESTRATOR_REQUEST_HALT_REASONS) {
    assert.deepEqual(
      parseAmuxOrchestratorHaltRecord({ halt_key: REQUEST, reason_code: reason, request_id: REQUEST }),
      { haltKey: REQUEST, reasonCode: reason, requestId: REQUEST },
    );
    // The halt key is the request id.
    assert.equal(
      parseAmuxOrchestratorHaltRecord({ halt_key: INSTANCE, reason_code: reason, request_id: REQUEST }),
      null,
    );
    assert.equal(parseAmuxOrchestratorHaltRecord({ halt_key: REQUEST, reason_code: reason }), null);
  }
  for (const reason of ["contract_violation", "selection_read_failures"]) {
    assert.deepEqual(parseAmuxOrchestratorHaltRecord({ halt_key: INSTANCE, reason_code: reason }), {
      haltKey: INSTANCE,
      reasonCode: reason,
      requestId: null,
    });
    assert.deepEqual(
      parseAmuxOrchestratorHaltRecord({ halt_key: INSTANCE, reason_code: reason, request_id: null }),
      { haltKey: INSTANCE, reasonCode: reason, requestId: null },
    );
    assert.equal(
      parseAmuxOrchestratorHaltRecord({ halt_key: INSTANCE, reason_code: reason, request_id: REQUEST }),
      null,
    );
  }
  // Nothing outside the closed list, and nothing that could clear a halt.
  for (const body of [
    { halt_key: INSTANCE, reason_code: "operator_note" },
    { halt_key: "x", reason_code: "contract_violation" },
    { halt_key: INSTANCE, reason_code: "contract_violation", cleared_at: "2026-09-30T00:00:00Z" },
    { halt_key: INSTANCE, reason_code: "contract_violation", clear: true },
    { halt_key: INSTANCE, reason_code: "contract_violation", note: "free text" },
    null,
    [],
    "contract_violation",
  ]) {
    assert.equal(parseAmuxOrchestratorHaltRecord(body), null, JSON.stringify(body));
  }
});

test("clearing takes the first eight characters of the halt key, and nothing else", () => {
  const halt = "a1b2c3d4-0000-4000-8000-000000000000";
  assert.equal(amuxOrchestratorHaltKeyPrefixMatches(halt, "a1b2c3d4"), true);
  assert.equal(amuxOrchestratorHaltKeyPrefixMatches(halt, " A1B2C3D4 "), true);
  for (const typed of ["a1b2c3d", "a1b2c3d4-", "a1b2c3d5", "", halt, null, 12345678]) {
    assert.equal(amuxOrchestratorHaltKeyPrefixMatches(halt, typed), false, String(typed));
  }
});

test("audit metadata holds only the allowlisted identifiers and codes", () => {
  assert.deepEqual(AMUX_ORCHESTRATOR_AUDIT_METADATA_KEYS, [
    "systemActor",
    "halt_id",
    "halt_key",
    "request_id",
    "reason_code",
    "call_kind",
    "resolution",
  ]);
  assert.deepEqual(
    amuxOrchestratorAuditMetadata({ halt_id: INSTANCE, request_id: REQUEST, call_kind: null }),
    { halt_id: INSTANCE, request_id: REQUEST },
  );
  // The system writer sets systemActor; a caller may not.
  assert.throws(() => amuxOrchestratorAuditMetadata({ systemActor: "x" }));
  for (const key of ["title", "brief", "source_key", "error", "note"]) {
    assert.throws(() => amuxOrchestratorAuditMetadata({ [key]: "value" }), key);
  }
  // No free text in an allowed key either.
  assert.throws(() => amuxOrchestratorAuditMetadata({ halt_key: "x".repeat(65) }));
});

test("every receipt kind names where its row can be read, except the quota batch", () => {
  for (const kind of AMUX_ORCHESTRATOR_RECEIPT_TARGET_KINDS) {
    const href = AMUX_ORCHESTRATOR_RECEIPT_TARGET_HREFS[kind];
    if (kind === "quota_observation_batch") assert.equal(href, null);
    else assert.match(href, /^\/admin\/amux-(execution|promotion)\?tab=/);
  }
});
