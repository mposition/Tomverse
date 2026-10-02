import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  classifySourceScopeApprovalReply,
  clearSourceScopeApprovalAttempt,
  readSourceScopeApprovalAttempt,
  reserveSourceScopeApprovalAttempt,
} from "../lib/amux/ideaSourceScopeApprovalUiCore.ts";
import { hasValidMutationOrigin, requiresMutationOriginCheck } from "../lib/requestOrigin.ts";

const binding = {
  approvalId: "d218de81-0c91-4f5b-8dcb-11f335d68111",
  ideaId: "d218de81-0c91-4f5b-8dcb-11f335d68110",
  ideaDigest: "a".repeat(64),
  previewScopeDigest: "b".repeat(64),
  previewScopeDigestKeyId: "synthetic-key",
};

const approved = { state: "approved", ...binding,
  scopeDigest: "c".repeat(64), scopeDigestKeyId: "synthetic-key",
  expiresAt: "2026-10-02T12:15:00.000Z",
  collectionVerified: false, transferAuthorized: false };

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

test("only an exact scope and idea binding can be displayed as approved", () => {
  assert.deepEqual(classifySourceScopeApprovalReply({ status: 201, body: approved },
    binding, "write"), { kind: "approved", expiresAt: approved.expiresAt });
  for (const body of [
    { ...approved, ideaDigest: "0".repeat(64) },
    { ...approved, previewScopeDigest: "0".repeat(64) },
    { ...approved, previewScopeDigestKeyId: "other-key" },
    { ...approved, collectionVerified: true },
    { ...approved, transferAuthorized: true },
    { ...approved, scopeDigest: "invalid" },
  ]) assert.deepEqual(classifySourceScopeApprovalReply({ status: 201, body },
    binding, "write"), { kind: "outcome_unknown" });
});

test("an absent read-back never releases an ambiguous write", () => {
  assert.deepEqual(classifySourceScopeApprovalReply({ status: 404,
    body: { error: "not_found" } }, binding, "read"), { kind: "outcome_unknown" });
  assert.deepEqual(classifySourceScopeApprovalReply({ status: 409,
    body: { error: "preview_changed" } }, binding, "write"),
  { kind: "refused", code: "preview_changed" });
  assert.deepEqual(classifySourceScopeApprovalReply({ status: 409,
    body: { error: "approval_exists" } }, binding, "write"),
  { kind: "outcome_unknown" });
  assert.deepEqual(classifySourceScopeApprovalReply({ status: 429,
    body: { error: "rate_limited" } }, binding, "write"),
  { kind: "refused", code: "rate_limited" });
  assert.deepEqual(classifySourceScopeApprovalReply({ status: 503,
    body: { error: "integrity_unavailable", collectionVerified: false,
      transferAuthorized: false } }, binding, "write"),
  { kind: "refused", code: "integrity_unavailable" });
  assert.deepEqual(classifySourceScopeApprovalReply({ status: 503,
    body: { error: "approval_unavailable", collectionVerified: false,
      transferAuthorized: false } }, binding, "write"),
  { kind: "outcome_unknown" });
  assert.deepEqual(classifySourceScopeApprovalReply({ status: 503,
    body: { error: "outcome_unknown" } }, binding, "write"),
  { kind: "outcome_unknown" });
  assert.deepEqual(classifySourceScopeApprovalReply({ status: 200,
    body: { state: "expired", ...binding, collectionVerified: false,
      transferAuthorized: false } }, binding, "read"), { kind: "expired" });
});

test("same-tab attempt fence prevents duplicate writes and survives reload", () => {
  const store = storage();
  const expected = { ...binding };
  delete expected.approvalId;
  assert.deepEqual(readSourceScopeApprovalAttempt(store, "owner", expected),
    { kind: "absent" });
  assert.equal(reserveSourceScopeApprovalAttempt(store, "owner", binding), true);
  assert.equal(reserveSourceScopeApprovalAttempt(store, "owner", binding), false);
  assert.deepEqual(readSourceScopeApprovalAttempt(store, "owner", expected),
    { kind: "present", binding });
  assert.deepEqual(readSourceScopeApprovalAttempt(store, "owner",
    { ...expected, ideaDigest: "0".repeat(64) }), { kind: "unavailable" });
  assert.equal(clearSourceScopeApprovalAttempt(store, "owner",
    { ...binding, approvalId: "d218de81-0c91-4f5b-8dcb-11f335d68112" }), false);
  assert.equal(clearSourceScopeApprovalAttempt(store, "owner", binding), true);
  assert.deepEqual(readSourceScopeApprovalAttempt(store, "owner", expected),
    { kind: "absent" });
});

test("Admin action is separately dark and reads back the same approval ID", () => {
  const page = readFileSync(new URL("../app/(site)/(application)/admin/amux-backlog/page.tsx", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../components/admin/AmuxSourceScopeApprovalPanel.tsx", import.meta.url), "utf8");
  const proxy = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(page, /sourceScopeApprovalWritePermitted\(process\.env\[AMUX_V4_SOURCE_SCOPE_APPROVAL_WRITE_ENV\]\)/);
  assert.match(page, /sourceScopeApprovalReadPermitted\(process\.env\[AMUX_V4_SOURCE_SCOPE_APPROVAL_READ_ENV\]\)/);
  assert.match(panel, /reserveSourceScopeApprovalAttempt\(receiptStore\(\), operatorId, binding\)/);
  assert.match(panel, /new URLSearchParams\(\{ approvalId: binding\.approvalId \}\)/);
  assert.match(panel, /classifySourceScopeApprovalReply/);
  assert.match(proxy, /requiresMutationOriginCheck\(request\.method, request\.nextUrl\.pathname\)\s*&&\s*!hasValidMutationOrigin\(request\)/);
  const path = "/api/admin/amux/ideas/source-scope-approval";
  assert.equal(requiresMutationOriginCheck("POST", path), true);
  assert.equal(hasValidMutationOrigin(new Request(`https://tomverse.app${path}`, {
    method: "POST", headers: { origin: "https://attacker.example", host: "tomverse.app" },
  })), false);
  assert.equal(hasValidMutationOrigin(new Request(`https://tomverse.app${path}`, {
    method: "POST", headers: { origin: "https://tomverse.app", host: "tomverse.app" },
  })), true);
});
