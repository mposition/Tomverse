import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { collectionPreviewReadPermitted,
  parseStoredAmuxCollectionPreview } from "../lib/amux/ideaCollectionPreviewCore.ts";

const route = readFileSync(new URL("../app/api/admin/amux/ideas/collection-preview/route.ts",
  import.meta.url), "utf8");
const service = readFileSync(new URL("../lib/amux/ideaCollectionPreviewService.ts",
  import.meta.url), "utf8");

const previewId = randomUUID();
const binding = { previewId, provider: "openai", modelId: "frontier-model",
  reasoningEffort: "high", promptVersion: "synthetic-template-v1" };
const source = { sourceIndex: 0, repositoryId: 42,
  repository: "mposition/Tomverse", refName: "refs/heads/main",
  refObjectSha: "a".repeat(40), refCommitSha: "a".repeat(40),
  commitSha: "a".repeat(40), path: "lib/example.ts",
  blobSha: "b".repeat(40), fileSha256: "c".repeat(64),
  startByte: 0, endByte: 3, excerptText: "abc" };
const candidate = { schemaVersion: 1, previewId,
  templateVersion: "synthetic-template-v1", prompt: "Synthetic owner-visible prompt",
  model: { provider: "openai", modelId: "frontier-model", reasoningEffort: "high" },
  selectedSourceIndices: [0], unselectedSourceCount: 0,
  provenance: "collector_attested", source };
const parse = (value, expected = binding) =>
  parseStoredAmuxCollectionPreview(Buffer.from(JSON.stringify(value)), expected);

test("preview read remains dark and parses the exact bounded stored result", () => {
  assert.equal(collectionPreviewReadPermitted("enabled"), false);
  assert.deepEqual(parse(candidate), candidate);
  assert.equal(parse({ ...candidate, transferAuthorized: true }), null);
  assert.equal(parse({ ...candidate, source: { ...source, extra: "source" } }), null);
  assert.equal(parse({ ...candidate, selectedSourceIndices: [1] }), null);
  assert.equal(parse({ ...candidate, provenance: "verified" }), null);
  assert.equal(parse({ ...candidate, source: { ...source, endByte: 4 } }), null);
  assert.equal(parse(candidate, { ...binding, modelId: "different" }), null);
  assert.equal(parse(candidate, { ...binding, promptVersion: "different" }), null);
  assert.equal(parse(candidate, { ...binding, previewId: randomUUID() }), null);
  assert.equal(parseStoredAmuxCollectionPreview(Buffer.from([0xff]), binding), null);
});

test("owner GET enforces exact-ID step-up, rate limit and no-store", () => {
  assert.match(route, /getAdminRole\(session\) !== "owner"/);
  assert.match(route, /assertRecentAdminAuthentication\(session\)/);
  assert.match(route, /collectionPreviewReadPermitted\(process\.env\[/);
  assert.match(route, /consumeApiRateLimit\(request, session\.user!\.id!/);
  assert.match(route, /\[\.\.\.params\.keys\(\)\]\.length !== 1/);
  assert.match(route, /isAmuxIdeaRequestId\(requestId\)/);
  assert.match(route, /"Cache-Control": "private, no-store, max-age=0"/);
  assert.match(route, /readAmuxCollectionPreview\(session, requestId\)/);
});

test("owner read requires live retained result and audit binding, without write path", () => {
  assert.match(service, /row\.state !== "preview_ready" \|\| now >= row\.expiresAt/);
  assert.match(service, /row\.resultPurgedAt !== null \|\| !row\.resultPurgeAfter \|\| now >= row\.resultPurgeAfter/);
  assert.match(service, /row\.sourceScopeApproval\.revokedAt !== null/);
  assert.match(service, /row\.frontierApproval\.revokedAt !== null/);
  assert.match(service, /Object\.keys\(meta\)\.sort\(\)\.join\("\\0"\) !== AUDIT_FIELDS/);
  assert.match(service, /verifyAmuxContentDigest\(plain, "collection_result", row\.id/);
  assert.match(service, /transferAuthorized: false as const/);
  assert.doesNotMatch(service, /writeSystemAuditLog|writeAdminAuditLog|streamText|generateText/);
});
