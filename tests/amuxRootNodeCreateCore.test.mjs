import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AMUX_V4_NODE_CREATE_WRITE_CODE_LATCH,
  AMUX_V4_NODE_CREATE_READ_CODE_LATCH,
  amuxV4NodeCreateWritePermitted, amuxV4NodeCreateReadPermitted,
  amuxRootNodeErrorBody, amuxRootNodeErrorStatus,
  amuxRootNodeNeedsCommitReadback, amuxRootNodeKnownRollbackCode,
  amuxRootNodeReadbackProvesExpiry,
  inspectAmuxRootNodeRequest } from "../lib/amux/ideaNodeCreateCore.ts";

const route = readFileSync(new URL(
  "../app/api/admin/amux/ideas/root-node/route.ts", import.meta.url), "utf8");
const prepare = {
  stage: "prepare", ideaId: "idea_00000001", draftUnitId: "draft_00000001",
  decisionId: "00000000-0000-4000-8000-000000000001",
  prepareRequestId: "00000000-0000-4000-8000-000000000002",
  nodeId: "00000000-0000-4000-8000-000000000003", reason: "",
};
const consume = { ...prepare, stage: "consume",
  consumeRequestId: "00000000-0000-4000-8000-000000000004",
  confirmationDigest: "a".repeat(64) };

test("root Initiative decision accepts only exact bounded prepare/consume shapes", () => {
  assert.deepEqual(inspectAmuxRootNodeRequest(JSON.stringify(prepare)), prepare);
  assert.deepEqual(inspectAmuxRootNodeRequest(JSON.stringify(consume)), consume);
  assert.deepEqual(inspectAmuxRootNodeRequest(JSON.stringify({
    stage: "confirm_no_commit", decisionId: prepare.decisionId,
    prepareRequestId: prepare.prepareRequestId,
  })), { stage: "confirm_no_commit", decisionId: prepare.decisionId,
    prepareRequestId: prepare.prepareRequestId });
  for (const changed of [
    { ...prepare, hidden: true }, { ...prepare, nodeId: prepare.decisionId },
    { ...prepare, reason: " trailing " }, { ...prepare, reason: "x".repeat(1_001) },
    { ...consume, consumeRequestId: prepare.nodeId },
    { ...consume, confirmationDigest: "not-a-digest" },
  ]) {
    assert.equal(inspectAmuxRootNodeRequest(JSON.stringify(changed)), null);
  }
});

test("root node route stays dark and uncertain writes are never retry grants", () => {
  assert.equal(AMUX_V4_NODE_CREATE_WRITE_CODE_LATCH, false);
  assert.equal(AMUX_V4_NODE_CREATE_READ_CODE_LATCH, false);
  assert.equal(amuxV4NodeCreateWritePermitted("enabled"), false);
  assert.equal(amuxV4NodeCreateReadPermitted("enabled"), false);
  assert.equal(amuxRootNodeNeedsCommitReadback(false), false);
  assert.equal(amuxRootNodeNeedsCommitReadback(true), true);
  assert.equal(amuxRootNodeKnownRollbackCode("P2034"), true);
  assert.equal(amuxRootNodeKnownRollbackCode("P2028"), false);
  assert.equal(amuxRootNodeErrorStatus("outcome_unknown"), 503);
  assert.deepEqual(amuxRootNodeErrorBody("outcome_unknown", {
    decisionId: prepare.decisionId,
    prepareRequestId: prepare.prepareRequestId,
  }), { error: "outcome_unknown", retryWrite: false,
    decisionId: prepare.decisionId,
    prepareRequestId: prepare.prepareRequestId });
  assert.equal(amuxRootNodeReadbackProvesExpiry({ state: "expired",
    decisionId: prepare.decisionId, draftUnitId: prepare.draftUnitId },
  prepare), true);
  assert.equal(amuxRootNodeReadbackProvesExpiry({ state: "partial" },
    prepare), false);
  assert.match(route, /amuxV4NodeCreateWritePermitted/);
  assert.match(route, /amuxV4NodeCreateReadPermitted/);
  assert.match(route, /readAmuxRootNodeDecision/);
  assert.match(route, /assertRecentAdminAuthentication/);
});
