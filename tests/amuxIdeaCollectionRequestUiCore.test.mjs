import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { canReplaceTerminalCollectionRequest, COLLECTION_REQUEST_EXPIRY_GRACE_MS,
  collectionPreviewDisplayDeadline, formatCollectionTimestamp, oneRepositoryFile,
  readCollectionExactPreview, readCollectionRequestReceipt, readCollectionRequestReply,
  replaceTerminalCollectionRequestReceipt, reserveCollectionRequestReceipt,
} from "../lib/amux/ideaCollectionRequestUiCore.ts";

const receipt = {
  requestId: "d218de81-0c91-4f5b-8dcb-11f335d68111",
  previewId: "d218de81-0c91-4f5b-8dcb-11f335d68112",
  ideaId: "d218de81-0c91-4f5b-8dcb-11f335d68113",
  scopeApprovalId: "d218de81-0c91-4f5b-8dcb-11f335d68114",
  scopeDigest: "b".repeat(64),
  frontierApprovalId: "d218de81-0c91-4f5b-8dcb-11f335d68115",
  frontierVersion: 1,
  provider: "openai",
  modelId: "gpt-frontier",
  reasoningEffort: "high",
};
const reply = {
  id: "d218de81-0c91-4f5b-8dcb-11f335d68116",
  requestId: receipt.requestId,
  previewId: receipt.previewId,
  state: "pending",
  expiresAt: "2026-10-04T08:00:00.000Z",
  requestDigest: "a".repeat(64), requestDigestKeyId: "synthetic-key",
  collectionVerified: false, transferAuthorized: false,
};

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

test("a collection request is fenced by idea and cannot be reposted after reload or model change", () => {
  const store = storage();
  assert.deepEqual(readCollectionRequestReceipt(store, "owner", receipt.ideaId), { kind: "absent" });
  assert.equal(reserveCollectionRequestReceipt(store, "owner", receipt), true);
  assert.deepEqual(readCollectionRequestReceipt(store, "owner", receipt.ideaId),
    { kind: "present", receipt });
  assert.equal(reserveCollectionRequestReceipt(store, "owner", {
    ...receipt, requestId: "d218de81-0c91-4f5b-8dcb-11f335d68117",
    reasoningEffort: "xhigh",
  }), false);
});

test("corrupt or inaccessible session storage fails closed", () => {
  assert.deepEqual(readCollectionRequestReceipt(null, "owner", receipt.ideaId),
    { kind: "unavailable" });
  const store = storage();
  store.setItem(`amux-v4-collection-request:owner:${receipt.ideaId}`, "{}");
  assert.deepEqual(readCollectionRequestReceipt(store, "owner", receipt.ideaId),
    { kind: "unavailable" });
  assert.equal(reserveCollectionRequestReceipt(store, "owner", receipt), false);
});

test("a verified hold can be replaced only with a distinct owner-approved scope", () => {
  const store = storage();
  const next = { ...receipt,
    requestId: "d218de81-0c91-4f5b-8dcb-11f335d68117",
    previewId: "d218de81-0c91-4f5b-8dcb-11f335d68118",
    scopeApprovalId: "d218de81-0c91-4f5b-8dcb-11f335d68119" };
  const verified = { kind: "committed", id: reply.id, state: "hold",
    expiresAt: reply.expiresAt };
  assert.equal(reserveCollectionRequestReceipt(store, "owner", receipt), true);
  assert.equal(canReplaceTerminalCollectionRequest(receipt, verified,
    receipt.scopeApprovalId, Date.now()), false);
  assert.equal(replaceTerminalCollectionRequestReceipt(store, "owner", receipt,
    verified, { ...next, scopeApprovalId: receipt.scopeApprovalId }, Date.now()), false);
  assert.equal(replaceTerminalCollectionRequestReceipt(store, "owner", receipt,
    { ...verified, kind: "unresolved" }, next, Date.now()), false);
  assert.equal(replaceTerminalCollectionRequestReceipt(store, "owner", receipt,
    { ...verified, state: "outcome_unknown" }, next, Date.now()), false);
  assert.equal(replaceTerminalCollectionRequestReceipt(store, "owner", receipt,
    verified, next, Date.now()), true);
  assert.deepEqual(readCollectionRequestReceipt(store, "owner", receipt.ideaId),
    { kind: "present", receipt: next });
  assert.equal(replaceTerminalCollectionRequestReceipt(store, "owner", receipt,
    verified, { ...next, requestId: "d218de81-0c91-4f5b-8dcb-11f335d6811a" }, Date.now()), false);
});

test("deadline fallback requires a later verified read plus grace, never a blind retry", () => {
  const store = storage();
  const next = { ...receipt,
    requestId: "d218de81-0c91-4f5b-8dcb-11f335d68117",
    previewId: "d218de81-0c91-4f5b-8dcb-11f335d68118",
    scopeApprovalId: "d218de81-0c91-4f5b-8dcb-11f335d68119" };
  const deadline = Date.parse(reply.expiresAt);
  const pending = { kind: "committed", id: reply.id, state: "pending",
    expiresAt: reply.expiresAt };
  assert.equal(reserveCollectionRequestReceipt(store, "owner", receipt), true);
  assert.equal(canReplaceTerminalCollectionRequest(receipt, pending,
    next.scopeApprovalId, deadline + COLLECTION_REQUEST_EXPIRY_GRACE_MS - 1), false);
  assert.equal(replaceTerminalCollectionRequestReceipt(store, "owner", receipt,
    pending, next, deadline + COLLECTION_REQUEST_EXPIRY_GRACE_MS - 1), false);
  assert.equal(replaceTerminalCollectionRequestReceipt(store, "owner", receipt,
    pending, next, deadline + COLLECTION_REQUEST_EXPIRY_GRACE_MS), true);
});

test("a displayed prompt has the earlier expiry and purge deadline", () => {
  const preview = { expiresAt: "2026-10-04T08:00:00.000Z",
    resultPurgeAfter: "2026-10-04T07:00:00.000Z" };
  assert.equal(collectionPreviewDisplayDeadline(preview),
    Date.parse(preview.resultPurgeAfter));
  assert.equal(collectionPreviewDisplayDeadline({ ...preview,
    resultPurgeAfter: "bad" }), null);
  assert.match(formatCollectionTimestamp(preview.expiresAt, "ko", "UTC"), /2026/);
  assert.match(formatCollectionTimestamp(preview.expiresAt, "en", "UTC"), /2026/);
});

test("only a matching, non-authorizing write/read reply is displayed as recorded", () => {
  assert.deepEqual(readCollectionRequestReply(201, reply, receipt, "write"),
    { kind: "committed", id: reply.id, state: "pending", expiresAt: reply.expiresAt });
  assert.deepEqual(readCollectionRequestReply(200, { ...reply, status: "committed" },
    receipt, "read"), { kind: "committed", id: reply.id,
      state: "pending", expiresAt: reply.expiresAt });
  for (const body of [{ ...reply, collectionVerified: true },
    { ...reply, transferAuthorized: true },
    { ...reply, requestId: "d218de81-0c91-4f5b-8dcb-11f335d68119" },
    { ...reply, previewId: "d218de81-0c91-4f5b-8dcb-11f335d68119" },
    { ...reply, requestDigest: "bad" },
    { ...reply, state: "sent_to_model" }]) {
    assert.deepEqual(readCollectionRequestReply(201, body, receipt, "write"),
      { kind: "unresolved" });
  }
  assert.deepEqual(readCollectionRequestReply(200, { ...reply, status: "absent" },
    receipt, "read"), { kind: "unresolved" });
});

test("UI supports one repository file only and labels collection as pending", () => {
  assert.deepEqual(oneRepositoryFile(JSON.stringify({ version: 1, sources: [{
    kind: "repository_file", repository: "mposition/Tomverse",
    commitSha: "a".repeat(40), path: "README.md",
  }] })), { repository: "mposition/Tomverse", commitSha: "a".repeat(40), path: "README.md" });
  assert.equal(oneRepositoryFile(JSON.stringify({ version: 1, sources: [
    { kind: "repository_file", repository: "mposition/Tomverse", commitSha: "a".repeat(40), path: "README.md" },
    { kind: "repository_file", repository: "mposition/Tomverse", commitSha: "a".repeat(40), path: "AGENTS.md" },
  ] })), null);
  assert.equal(oneRepositoryFile(JSON.stringify({ version: 1, sources: [{
    kind: "pull_request_file", repository: "mposition/Tomverse", path: "README.md",
  }] })), null);
  const panel = readFileSync(new URL("../components/admin/AmuxCollectionRequestPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /reserveCollectionRequestReceipt\(receiptStore\(\), operatorId, receipt\)/);
  assert.match(panel, /collection-requests\?\$\{query\}/);
  assert.match(panel, /collection-preview\?\$\{query\}/);
  assert.doesNotMatch(panel, /fetch\(["']https:\/\//);
  const input = readFileSync(new URL("../components/admin/AmuxIdeaInputPanel.tsx", import.meta.url), "utf8");
  const model = readFileSync(new URL("../components/admin/AmuxFrontierModelsPanel.tsx", import.meta.url), "utf8");
  const scope = readFileSync(new URL("../components/admin/AmuxSourceScopeApprovalPanel.tsx", import.meta.url), "utf8");
  assert.match(input, /onCheckedCollectionModel=\{setCheckedCollectionModel\}/);
  assert.match(input, /onApproved=\{setApprovedCollectionScope\}/);
  assert.match(input, /approvedCollectionScope\.scopeDigest === sourceScopeResult\.scopeDigest/);
  assert.match(model, /onCheckedCollectionModel\?\.\(\{ \.\.\.selected, reasoningEffort: selectedEffort \}\)/);
  assert.match(model, /declaredExternalSources \|\|/);
  assert.match(scope, /onApproved\?\.\(\{ ideaId, scopeDigest: checked\.scopeDigest,/);
});

test("exact preview must bind request, model, file and a non-authorizing state", () => {
  const expectedSource = { repository: "mposition/Tomverse",
    commitSha: "a".repeat(40), path: "README.md" };
  const preview = {
    collectionRequestId: reply.id, requestId: receipt.requestId,
    previewId: receipt.previewId, state: "preview_ready",
    promptVersion: "v1", prompt: "Synthetic idea and source excerpt",
    model: { provider: receipt.provider, modelId: receipt.modelId,
      reasoningEffort: receipt.reasoningEffort },
    source: { sourceIndex: 0, repositoryId: 1,
      repository: expectedSource.repository,
      refName: "refs/heads/main", refObjectSha: "a".repeat(40),
      refCommitSha: "a".repeat(40), commitSha: expectedSource.commitSha,
      path: expectedSource.path, blobSha: "b".repeat(40),
      fileSha256: "c".repeat(64), startByte: 0, endByte: 4 },
    selectedSourceIndices: [0], unselectedSourceCount: 0,
    provenance: "collector_attested", resultDigest: "d".repeat(64),
    resultDigestKeyId: "synthetic-key", expiresAt: reply.expiresAt,
    resultPurgeAfter: "2026-10-05T08:00:00.000Z",
    collectionVerified: false, transferAuthorized: false,
  };
  assert.equal(readCollectionExactPreview(200, preview, receipt, reply.id,
    expectedSource)?.prompt, preview.prompt);
  for (const body of [{ ...preview, transferAuthorized: true },
    { ...preview, collectionVerified: true },
    { ...preview, requestId: "d218de81-0c91-4f5b-8dcb-11f335d68119" },
    { ...preview, source: { ...preview.source, path: "OTHER.md" } },
    { ...preview, model: { ...preview.model, reasoningEffort: "xhigh" } },
    { ...preview, selectedSourceIndices: [0, 1] },
    { ...preview, unselectedSourceCount: 1 },
  ]) assert.equal(readCollectionExactPreview(200, body, receipt, reply.id,
    expectedSource), null);
});
