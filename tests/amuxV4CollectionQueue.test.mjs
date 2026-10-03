import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AMUX_V4_COLLECTION_AGENT_ID,
  AMUX_V4_COLLECTION_AGENT_SECRET_ENV,
  AMUX_V4_COLLECTION_QUEUE_CODE_LATCH,
  AMUX_V4_COLLECTION_QUEUE_READ_ENV,
  buildCollectionCandidateWhere,
  collectionQueueReadEnabled,
  encodeCollectionQueueCursor,
  isCollectionAgentAuthorized,
  parseCollectionQueueCursor,
} from "../lib/amux/ideaCollectionQueueCore.ts";
import { AMUX_V4_COLLECTION_APP_ORIGIN_ENV, pollAmuxV4CollectionCandidateIds } from
  "../lib/amux/ideaLocalCollectionQueuePoll.mjs";

const secret = "source_collector_012345678901234567890123456789";
const id = "123e4567-e89b-42d3-a456-426614174000";
const url = "https://tomverse.example/api/internal/amux/v4/collection-queue";
const request = (token, agentId = AMUX_V4_COLLECTION_AGENT_ID) =>
  new Request(url, { method: "POST", headers: {
    authorization: `Bearer ${token}`, "x-amux-agent-id": agentId,
    "content-type": "application/json",
  }, body: "{}" });

test("AMUX collection queue has a separate identity and stays dark", () => {
  assert.equal(AMUX_V4_COLLECTION_QUEUE_CODE_LATCH, false);
  assert.equal(collectionQueueReadEnabled("enabled"), false);
  assert.equal(isCollectionAgentAuthorized(request(secret), secret), true);
  assert.equal(isCollectionAgentAuthorized(request(secret), secret, secret), false);
  assert.equal(isCollectionAgentAuthorized(request(secret), secret, undefined, secret), false);
  assert.equal(isCollectionAgentAuthorized(request(secret, "amux-intake"), secret), false);
  assert.equal(isCollectionAgentAuthorized(request("wrong_".repeat(7)), secret), false);
  assert.equal(isCollectionAgentAuthorized(request(secret), undefined), false);
  assert.equal(isCollectionAgentAuthorized(request(secret), "short"), false);
});

test("AMUX collection route refuses unauthenticated and dark-latch requests before DB", async () => {
  const imported = await import("../app/api/internal/amux/v4/collection-queue/route.ts");
  const POST = imported.POST ?? imported.default.POST;
  const previous = Object.fromEntries([
    AMUX_V4_COLLECTION_AGENT_SECRET_ENV, AMUX_V4_COLLECTION_QUEUE_READ_ENV,
    "TOMVERSE_AMUX_SYNC_SECRET", "TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET",
  ].map((key) => [key, process.env[key]]));
  try {
    process.env[AMUX_V4_COLLECTION_AGENT_SECRET_ENV] = secret;
    process.env[AMUX_V4_COLLECTION_QUEUE_READ_ENV] = "enabled";
    delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET;
    const denied = await POST(new Request(url, { method: "POST" }));
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("cache-control") ?? "", /no-store/);
    assert.equal((await POST(request(secret, "amux-intake"))).status, 401);
    process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
    assert.equal((await POST(request(secret))).status, 401);
    delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET = secret;
    assert.equal((await POST(request(secret))).status, 401);
    delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET;
    const dark = await POST(request(secret));
    assert.equal(dark.status, 409);
    assert.deepEqual(await dark.json(), {
      available: false, reason: "collection_queue_disabled",
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("AMUX collection queue lists only pending, current, unexpired candidates", () => {
  const now = new Date("2026-10-03T00:00:00.000Z");
  const cursor = { createdAt: new Date("2026-10-02T00:00:00.000Z"),
    collectionRequestId: id };
  const where = buildCollectionCandidateWhere(now, cursor);
  assert.equal(where.state, "pending");
  assert.equal(where.leaseId, null);
  assert.deepEqual(where.expiresAt, { gt: now });
  assert.deepEqual(where.idea.analysisDeadlineAt, { gt: now });
  assert.deepEqual(where.sourceScopeApproval.is.expiresAt, { gt: now });
  assert.equal(where.sourceScopeApproval.is.status, "approved");
  assert.equal(where.sourceScopeApproval.is.revokedAt, null);
  assert.equal(where.frontierApproval.is.status, "approved");
  assert.equal(where.frontierApproval.is.revokedAt, null);
  assert.deepEqual(where.OR, [
    { createdAt: { gt: cursor.createdAt } },
    { createdAt: cursor.createdAt, id: { gt: id } },
  ]);
  assert.equal(buildCollectionCandidateWhere(now, null).OR, undefined);
});

test("AMUX collection queue cursor is strict and canonical", () => {
  const position = { createdAt: new Date("2026-10-03T00:00:00.123Z"),
    collectionRequestId: id };
  assert.deepEqual(parseCollectionQueueCursor(encodeCollectionQueueCursor(position)), position);
  for (const invalid of ["", "!", "abc", "e30", "a".repeat(513),
    Buffer.from(JSON.stringify(["2026-10-03T00:00:00.123Z", "bad/id"]))
      .toString("base64url")]) {
    assert.equal(parseCollectionQueueCursor(invalid), null);
  }
});

test("AMUX collection queue does not select source body or perform writes", async () => {
  const service = await readFile(new URL("../lib/amux/ideaCollectionQueueService.ts",
    import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/internal/amux/v4/collection-queue/route.ts",
    import.meta.url), "utf8");
  assert.match(service, /take: PAGE_SIZE \+ 1/);
  assert.match(service, /select: \{ id: true, createdAt: true, expiresAt: true \}/);
  assert.doesNotMatch(service, /scopeCiphertext: true|rawCiphertext: true|resultCiphertext: true/);
  assert.doesNotMatch(service, /\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/);
  assert.doesNotMatch(route, /codex|claude|spawn\(|fetch\(/);
});

test("local collection poll accepts only bounded ID/expiry metadata", async () => {
  const previousPin = process.env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV];
  const calls = [];
  const valid = { candidates: [{ collectionRequestId: id,
    expiresAt: "2026-10-03T01:00:00.000Z" }],
  hasMore: false, nextCursor: null };
  const fetchImpl = async (endpoint, options) => {
    calls.push({ endpoint, options });
    return Response.json(valid);
  };
  try {
    delete process.env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV];
    assert.deepEqual(await pollAmuxV4CollectionCandidateIds({
      origin: "https://tomverse.example/", collectorSecret: secret, fetchImpl,
    }), { kind: "refused" });
    process.env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV] = "https://trusted.example/";
    assert.deepEqual(await pollAmuxV4CollectionCandidateIds({
      origin: "https://tomverse.example/", collectorSecret: secret, fetchImpl,
    }), { kind: "refused" });
    assert.equal(calls.length, 0, "a missing or mismatched pin must not send the bearer token");
    process.env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV] = "https://tomverse.example/";
    const result = await pollAmuxV4CollectionCandidateIds({
      origin: "https://tomverse.example/", collectorSecret: secret, fetchImpl,
    });
    assert.deepEqual(result, { kind: "candidates", ...valid });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpoint, url);
    assert.equal(calls[0].options.redirect, "manual");
    assert.equal(calls[0].options.headers["x-amux-agent-id"], AMUX_V4_COLLECTION_AGENT_ID);
    const badFetch = async () => Response.json({ ...valid,
      candidates: [{ ...valid.candidates[0], path: "private/file.md" }] });
    assert.deepEqual(await pollAmuxV4CollectionCandidateIds({
      origin: "https://tomverse.example/", collectorSecret: secret,
      fetchImpl: badFetch }), { kind: "unavailable" });
    assert.deepEqual(await pollAmuxV4CollectionCandidateIds({
      origin: "http://tomverse.example/", collectorSecret: secret, fetchImpl }),
    { kind: "refused" });
    assert.deepEqual(await pollAmuxV4CollectionCandidateIds({
      origin: "https://tomverse.example/", collectorSecret: secret,
      fetchImpl: async () => Response.json({ ...valid,
        candidates: Array.from({ length: 33 }, () => valid.candidates[0]) }),
    }), { kind: "unavailable" });
    assert.deepEqual(await pollAmuxV4CollectionCandidateIds({
      origin: "https://tomverse.example/", collectorSecret: secret,
      fetchImpl: async () => new Response("x".repeat(16 * 1024 + 1), {
        headers: { "content-type": "application/json" },
      }),
    }), { kind: "unavailable" });
    assert.deepEqual(await pollAmuxV4CollectionCandidateIds({
      origin: "https://tomverse.example/", collectorSecret: secret,
      fetchImpl: async () => new Response(null, { status: 409 }),
    }), { kind: "disabled" });
  } finally {
    if (previousPin === undefined) delete process.env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV];
    else process.env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV] = previousPin;
  }
});
