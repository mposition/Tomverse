import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { readLimitedJson } from "../lib/apiSecurity.ts";
import { AMUX_V4_COLLECTION_RESULT_MAX_BYTES, buildAmuxCollectionResult,
  collectionResultEnabled, collectionResultRequestSchema } from
  "../lib/amux/ideaCollectionResultCore.ts";
import { POST } from "../app/api/internal/amux/v4/collection-result/route.ts";

const id = () => randomUUID();
const source = { sourceIndex: 0, repositoryId: 123,
  refName: "refs/heads/develop", refObjectSha: "a".repeat(40),
  refCommitSha: "a".repeat(40), commitSha: "a".repeat(40),
  path: "lib/example.ts", blobSha: "b".repeat(40),
  fileSha256: "c".repeat(64), startByte: 0, endByte: 18,
  excerptText: "export const x=1;\n" };
const base = { schemaVersion: 1, collectionRequestId: id(), requestId: id(),
  previewId: id(), requestDigest: "d".repeat(64), leaseId: id(), leaseGeneration: 1 };
const approved = { kind: "repository_file", repository: "mposition/Tomverse",
  commitSha: source.commitSha, path: source.path };
const model = { provider: "openai", modelId: "synthetic-frontier", reasoningEffort: "high" };

test("collection result remains dark and accepts no worker prompt or digest", () => {
  assert.equal(collectionResultEnabled("enabled"), false);
  const good = collectionResultRequestSchema.parse({ ...base,
    outcome: "preview_candidate", source });
  assert.equal(good.outcome, "preview_candidate");
  assert.equal(collectionResultRequestSchema.safeParse({ ...good,
    prompt: "worker-selected" }).success, false);
  assert.equal(collectionResultRequestSchema.safeParse({ ...good,
    sourcePreviewDigest: "0".repeat(64) }).success, false);
  assert.equal(collectionResultRequestSchema.safeParse({ ...good,
    leaseGeneration: 2 }).success, false);
  assert.equal(collectionResultRequestSchema.safeParse({ ...base,
    outcome: "hold", reason: "raw GitHub file body" }).success, false);
  assert.equal(collectionResultRequestSchema.safeParse({ ...good,
    source: { ...source, excerptText: "a".repeat(8_193) } }).success, false);
});

test("result route authenticates before parsing and stays dark with no-store", async () => {
  const secret = "collector-secret-abcdefghijklmnopqrstuvwxyz-1234567890";
  const original = process.env.TOMVERSE_AMUX_V4_COLLECTION_AGENT_SECRET;
  process.env.TOMVERSE_AMUX_V4_COLLECTION_AGENT_SECRET = secret;
  try {
    const invalid = await POST(new Request("https://tomverse.test/api/internal/amux/v4/collection-result",
      { method: "POST", body: "SENSITIVE_SOURCE_TEXT" }));
    assert.equal(invalid.status, 401);
    assert.match(invalid.headers.get("cache-control") ?? "", /no-store/);
    assert.doesNotMatch(await invalid.text(), /SENSITIVE_SOURCE_TEXT/);
    const authorized = await POST(new Request("https://tomverse.test/api/internal/amux/v4/collection-result",
      { method: "POST", headers: { authorization: `Bearer ${secret}`,
        "x-amux-agent-id": "amux-v4-source-collector" }, body: "SENSITIVE_SOURCE_TEXT" }));
    assert.equal(authorized.status, 409);
    assert.match(authorized.headers.get("cache-control") ?? "", /no-store/);
    assert.doesNotMatch(await authorized.text(), /SENSITIVE_SOURCE_TEXT/);
  } finally {
    if (original === undefined) delete process.env.TOMVERSE_AMUX_V4_COLLECTION_AGENT_SECRET;
    else process.env.TOMVERSE_AMUX_V4_COLLECTION_AGENT_SECRET = original;
  }
});

test("the route's bounded strict JSON parser refuses oversized or extra fields", async () => {
  await assert.rejects(readLimitedJson(new Request("https://tomverse.test/", {
    method: "POST", headers: { "content-length": String(AMUX_V4_COLLECTION_RESULT_MAX_BYTES + 1) },
    body: JSON.stringify({ ...base, outcome: "hold", reason: "source_unverified" }),
  }), AMUX_V4_COLLECTION_RESULT_MAX_BYTES, collectionResultRequestSchema),
  (error) => error.status === 413);
  await assert.rejects(readLimitedJson(new Request("https://tomverse.test/", {
    method: "POST", body: JSON.stringify({ ...base, outcome: "hold",
      reason: "source_unverified", rawContent: "do not store" }),
  }), AMUX_V4_COLLECTION_RESULT_MAX_BYTES, collectionResultRequestSchema),
  (error) => error.status === 400);
});

test("app reconstructs exact prompt and a collector-attested, nonauthorizing result", () => {
  const request = collectionResultRequestSchema.parse({ ...base,
    outcome: "preview_candidate", source });
  if (request.outcome !== "preview_candidate") throw new Error("unexpected variant");
  const built = buildAmuxCollectionResult({ request, idea: "SYNTHETIC_IDEA",
    source: approved, model });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const result = JSON.parse(built.result);
  assert.equal(result.previewId, base.previewId);
  assert.equal(result.model.modelId, model.modelId);
  assert.equal(result.provenance, "collector_attested");
  assert.deepEqual(result.selectedSourceIndices, [0]);
  assert.equal(result.unselectedSourceCount, 0);
  assert.match(result.prompt, /SYNTHETIC_IDEA/);
  assert.match(result.prompt, /export const x=1/);
  assert.doesNotMatch(built.result, /collectionVerified|transferAuthorized|GitHub token/);
});

test("result refuses mismatched scope, byte range, scanner violations and oversized input", () => {
  const make = (candidate) => {
    const request = collectionResultRequestSchema.parse({ ...base,
      outcome: "preview_candidate", source: candidate });
    if (request.outcome !== "preview_candidate") throw new Error("variant");
    return buildAmuxCollectionResult({ request, idea: "SYNTHETIC_IDEA",
      source: approved, model });
  };
  assert.equal(make({ ...source, commitSha: "f".repeat(40) }).ok, false);
  assert.equal(make({ ...source, endByte: 19 }).ok, false);
  assert.equal(make({ ...source, excerptText: "secret\u0000" }).ok, false);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...base, outcome: "preview_candidate",
    source: { ...source, excerptText: "a".repeat(8_000) } }), "utf8") <
    AMUX_V4_COLLECTION_RESULT_MAX_BYTES);
  const longExcerpt = "a".repeat(8_180);
  assert.equal(make({ ...source, excerptText: longExcerpt,
    endByte: longExcerpt.length }).ok, false, "combined idea plus excerpt exceeds 8KiB");
  const largestAllowed = "a".repeat(8_192 - Buffer.byteLength("SYNTHETIC_IDEA"));
  const largest = make({ ...source, excerptText: largestAllowed,
    endByte: largestAllowed.length });
  assert.equal(largest.ok, true);
  if (largest.ok) {
    // The encrypted envelope adds fewer than 100 bytes; the DB caps it at 32KiB.
    assert.ok(Buffer.byteLength(largest.result, "utf8") + 100 <= 32_768);
  }
});
