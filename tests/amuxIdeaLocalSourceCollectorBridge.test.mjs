import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { AMUX_V4_COLLECTION_APP_ORIGIN_ENV } from
  "../lib/amux/ideaLocalCollectionQueuePoll.mjs";
import { runAmuxV4SourceCollectorOnce } from
  "../lib/amux/ideaLocalSourceCollectorBridge.ts";

const ORIGIN = "https://collector-app.example.test";
const COLLECTOR_SECRET = "c".repeat(40);
const GITHUB_TOKEN = "github-secret-token-not-for-app";
const REQUEST_ID = "d218de81-0c91-4f5b-8dcb-11f335d68111";
const IDEA_ID = "d218de81-0c91-4f5b-8dcb-11f335d68112";
const PREVIEW_ID = "d218de81-0c91-4f5b-8dcb-11f335d68113";
const LEASE_ID = "d218de81-0c91-4f5b-8dcb-11f335d68114";
const COMMIT = "a".repeat(40);
const REF = "b".repeat(40);
const source = { kind: "repository_file", repository: "mposition/Tomverse",
  commitSha: COMMIT, path: "README.md" };
const claim = { collectionRequestId: REQUEST_ID, requestId: IDEA_ID,
  previewId: PREVIEW_ID, requestDigest: "c".repeat(64), leaseGeneration: 1,
  leaseId: LEASE_ID, leaseExpiresAt: "2099-10-04T08:00:00.000Z",
  sourceByteLimit: 8192, idea: "Review this source", source,
  collectionVerified: false, transferAuthorized: false };

function fileCandidate(text = "public synthetic source\n", path = source.path) {
  const bytes = Buffer.from(text, "utf8");
  const blobSha = createHash("sha1")
    .update(`blob ${bytes.length}\0`, "utf8").update(bytes).digest("hex");
  return { status: "unscanned_candidate", inspectedRefs: 1,
    witness: { repositoryId: 25, name: "refs/heads/main", protected: null,
      refObjectSha: REF, refCommitSha: REF },
    file: { status: "verified_file", repositoryId: 25, commitSha: COMMIT,
      path, blobSha, size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), text } };
}

function harness({ candidate = fileCandidate(), resultReply = "success",
  claimReply = claim } = {}) {
  const calls = [];
  const appFetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, init });
    assert.equal(new URL(url).origin, ORIGIN);
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.authorization, `Bearer ${COLLECTOR_SECRET}`);
    assert.equal(init.headers["x-amux-agent-id"], "amux-v4-source-collector");
    assert.equal(JSON.stringify(init).includes(GITHUB_TOKEN), false);
    if (path.endsWith("/collection-queue")) return Response.json({
      candidates: [{ collectionRequestId: REQUEST_ID,
        expiresAt: "2099-10-04T08:00:00.000Z" }], hasMore: false, nextCursor: null,
    });
    if (path.endsWith("/collection-claim")) return Response.json(claimReply);
    if (path.endsWith("/collection-result")) {
      if (resultReply === "unknown") return Response.json({ error: "outcome_unknown" },
        { status: 503 });
      const body = JSON.parse(init.body);
      return Response.json({ collectionRequestId: body.collectionRequestId,
        requestId: body.requestId, previewId: body.previewId,
        state: body.outcome === "hold" ? "hold" : "preview_ready",
        resultDigest: body.outcome === "hold" ? null : "d".repeat(64),
        collectionVerified: false, transferAuthorized: false });
    }
    throw new Error("unexpected synthetic path");
  };
  const collectCandidate = async (config, commitSha, path, limits) => {
    assert.equal(config.token, GITHUB_TOKEN);
    assert.equal(config.expectedRepositoryId, 25);
    assert.equal(commitSha, COMMIT);
    assert.equal(path, source.path);
    assert.equal(limits.maxPages, 3);
    assert(config.signal instanceof AbortSignal);
    return candidate;
  };
  return { calls, appFetchImpl, collectCandidate };
}

async function run(options = {}) {
  const prior = process.env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV];
  process.env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV] = ORIGIN;
  const harnessValue = harness(options);
  try {
    const result = await runAmuxV4SourceCollectorOnce({ origin: ORIGIN,
      collectorSecret: COLLECTOR_SECRET,
      resolveCredential: async (repository) => {
        assert.equal(repository, source.repository);
        return { owner: "mposition", repo: "Tomverse",
          expectedRepositoryId: 25, token: GITHUB_TOKEN };
      }, appFetchImpl: harnessValue.appFetchImpl,
      collectCandidate: harnessValue.collectCandidate });
    return { ...harnessValue, result };
  } finally {
    if (prior === undefined) delete process.env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV];
    else process.env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV] = prior;
  }
}

test("one-shot collector sends scanned full file only to the app and never returns secrets or text", async () => {
  const { result, calls } = await run();
  assert.deepEqual(result, { kind: "preview_ready" });
  assert.deepEqual(calls.map((call) => call.path), [
    "/api/internal/amux/v4/collection-queue",
    "/api/internal/amux/v4/collection-claim",
    "/api/internal/amux/v4/collection-result",
  ]);
  const body = JSON.parse(calls[2].init.body);
  assert.equal(body.outcome, "preview_candidate");
  assert.equal(body.source.excerptText, "public synthetic source\n");
  assert.equal(body.source.endByte, Buffer.byteLength(body.source.excerptText));
  assert.equal(JSON.stringify(result).includes(body.source.excerptText), false);
  assert.equal(JSON.stringify(result).includes(GITHUB_TOKEN), false);
  assert.equal(JSON.stringify(body).includes(GITHUB_TOKEN), false);
});

test("scope mismatch and oversized whole file hold without sending an excerpt", async () => {
  for (const [candidate, reason] of [
    [fileCandidate("public synthetic source\n", "OTHER.md"), "source_selection_invalid"],
    [fileCandidate("a".repeat(8193)), "source_too_large"],
  ]) {
    const { result, calls } = await run({ candidate });
    assert.deepEqual(result, { kind: "hold" });
    const body = JSON.parse(calls[2].init.body);
    assert.equal(body.outcome, "hold");
    assert.equal(body.reason, reason);
    assert.equal(Object.hasOwn(body, "source"), false);
  }
});

test("unknown result POST is never retried", async () => {
  const { result, calls } = await run({ resultReply: "unknown" });
  assert.deepEqual(result, { kind: "result_unknown" });
  assert.equal(calls.filter((call) => call.path.endsWith("/collection-result")).length, 1);
});

test("ambiguous or malformed claim stops before GitHub credential access", async () => {
  const prior = process.env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV];
  process.env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV] = ORIGIN;
  let resolved = 0;
  let resultCalls = 0;
  try {
    const result = await runAmuxV4SourceCollectorOnce({ origin: ORIGIN,
      collectorSecret: COLLECTOR_SECRET,
      resolveCredential: async () => { resolved += 1; return null; },
      appFetchImpl: async (url) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/collection-queue")) return Response.json({
          candidates: [{ collectionRequestId: REQUEST_ID,
            expiresAt: "2099-10-04T08:00:00.000Z" }], hasMore: false, nextCursor: null,
        });
        if (path.endsWith("/collection-claim")) return Response.json({ error: "outcome_unknown" },
          { status: 503 });
        resultCalls += 1;
        return Response.json({});
      },
    });
    assert.deepEqual(result, { kind: "claim_unknown" });
    assert.equal(resolved, 0);
    assert.equal(resultCalls, 0);
  } finally {
    if (prior === undefined) delete process.env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV];
    else process.env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV] = prior;
  }
});

test("app origin is pinned and no live runner or child CLI is installed", async () => {
  const result = await runAmuxV4SourceCollectorOnce({ origin: "https://wrong.example.test",
    collectorSecret: COLLECTOR_SECRET,
    resolveCredential: async () => { throw new Error("must not run"); },
    appFetchImpl: async () => { throw new Error("must not fetch"); } });
  assert.deepEqual(result, { kind: "refused" });
  const sourceCode = readFileSync(new URL("../lib/amux/ideaLocalSourceCollectorBridge.ts", import.meta.url), "utf8");
  assert.doesNotMatch(sourceCode, /child_process|spawn\(|exec\(|console\.|process\.argv/);
});
