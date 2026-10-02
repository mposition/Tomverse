import assert from "node:assert/strict";
import { test } from "node:test";

import { AMUX_V4_SOURCE_SCOPE_APPROVAL_CODE_ENABLED,
  inspectAmuxSourceScopeApprovalRequest,
  sourceScopeApprovalWritePermitted } from "../lib/amux/ideaSourceScopeApprovalCore.ts";

const valid = {
  schemaVersion: 1,
  approvalId: "d218de81-0c91-4f5b-8dcb-11f335d68111",
  ideaId: "d218de81-0c91-4f5b-8dcb-11f335d68110",
  ideaDigest: "a".repeat(64),
  canonicalScopeJson: '{"version":1,"sources":[]}',
  scopeDigest: "b".repeat(64),
  scopeDigestKeyId: "amux-v4-preview-key",
};

test("v4 source-scope approval write remains code-disabled", () => {
  assert.equal(AMUX_V4_SOURCE_SCOPE_APPROVAL_CODE_ENABLED, false);
  assert.equal(sourceScopeApprovalWritePermitted("enabled"), false);
});

test("one exact scope decision request is accepted for later server revalidation", () => {
  assert.deepEqual(inspectAmuxSourceScopeApprovalRequest(JSON.stringify(valid)),
    { ok: true, request: valid });
  for (const changed of [
    { ...valid, ideaDigest: "" },
    { ...valid, scopeDigest: "C".repeat(64) },
    { ...valid, scopeDigestKeyId: "wrong/key" },
    { ...valid, approvalId: "not-a-uuid" },
    { ...valid, canonicalScopeJson: "x".repeat(16 * 1024 + 1) },
    { ...valid, extra: "field" },
  ]) {
    assert.equal(inspectAmuxSourceScopeApprovalRequest(JSON.stringify(changed)).ok, false);
  }
});
