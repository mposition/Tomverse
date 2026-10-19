import assert from "node:assert/strict";
import { after, test } from "node:test";

import { recordAmuxV19LocalReadManifest,
  recordAmuxV19MaxLocalReadManifest } from
  "../lib/amux/ideaLocalReadManifestReceipt.mjs";

const originEnv = "TOMVERSE_AMUX_V4_ANALYSIS_APP_ORIGIN";
const maxOriginEnv = "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN";
const previousOrigin = process.env[originEnv];
const previousMaxOrigin = process.env[maxOriginEnv];
process.env[originEnv] = "https://tomverse.test/";
process.env[maxOriginEnv] = "https://tomverse.test/";
after(() => {
  if (previousOrigin === undefined) delete process.env[originEnv];
  else process.env[originEnv] = previousOrigin;
  if (previousMaxOrigin === undefined) delete process.env[maxOriginEnv];
  else process.env[maxOriginEnv] = previousMaxOrigin;
});

const ideaId = "ea86a25b-919f-4714-a3d8-45ef5a18b175";
const secret = "v19_manifest_agent_secret_01234567890123456789";
const maxClaim = { claimId: "8a58e063-374d-4c6c-b1bd-57e8daa55c48",
  requestId: "a12ae2bc-5e33-44a2-9836-6a3648061820",
  reservationId: "ceb12ab5-d7fb-482f-bc5b-feb279cc043d",
  invocationOrdinal: 0 };
const input = (fetchImpl, observed = { kind: "verified_success",
  readFiles: ["docs/guide.md"], rawModelOutput: "never send model text" }) => ({
  origin: "https://tomverse.test/", agentSecret: secret, ideaId,
  referenceOrdinal: 0, pinnedCommitSha: "a".repeat(40), observed, fetchImpl,
});
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});

test("only a verified host observation crosses the pinned origin", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("unexpected network"); };
  for (const candidate of [
    { ...input(fetchImpl), origin: "https://other.test/" },
    { ...input(fetchImpl), observed: { kind: "outcome_unknown", readFiles: [] } },
    input(fetchImpl, { kind: "verified_success", readFiles: ["../private"] }),
  ]) assert.deepEqual(await recordAmuxV19LocalReadManifest(candidate),
    { kind: "refused" });
  assert.equal(calls, 0);
});

test("one POST contains only canonical verified read paths and accepts exact receipt", async () => {
  const calls = [];
  const readFiles = Array.from({ length: 2_001 }, (_, i) =>
    `docs/${String(i).padStart(4, "0")}.md`);
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "manual");
    assert.equal(options.cache, "no-store");
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body).sort(), ["ideaId", "manifestId",
      "observed", "pinnedCommitSha", "referenceOrdinal"]);
    assert.deepEqual(body.observed, { kind: "verified_success", readFiles });
    assert.match(body.manifestId, /^[a-f0-9-]{36}$/);
    return json({ manifestId: body.manifestId, ideaId,
      referenceOrdinal: 0, fileCount: readFiles.length });
  };
  const result = await recordAmuxV19LocalReadManifest(input(fetchImpl,
    { kind: "verified_success", readFiles: [...readFiles].reverse(),
      rawModelOutput: "never send model text" }));
  assert.equal(result.kind, "recorded");
  assert.equal(result.via, "post");
  assert.equal(result.fileCount, readFiles.length);
  assert.equal(calls.length, 1);
});

test("lost POST response permits exact-ID readback but never a second POST", async () => {
  const methods = [];
  let manifestId;
  const fetchImpl = async (url, options) => {
    methods.push(options.method);
    if (options.method === "POST") {
      manifestId = JSON.parse(options.body).manifestId;
      throw new Error("synthetic lost response after commit");
    }
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    assert.doesNotMatch(url, /docs|guide|readFiles/);
    return json({ status: "recorded", manifestId, ideaId,
      referenceOrdinal: 0, pinnedCommitSha: "a".repeat(40),
      fileCount: 1, digest: "d".repeat(64), digestKeyId: "digest-key",
      bodyPurged: false });
  };
  assert.deepEqual(await recordAmuxV19LocalReadManifest(input(fetchImpl)),
    { kind: "recorded", manifestId, fileCount: 1, via: "readback" });
  assert.deepEqual(methods, ["POST", "GET"]);
});

test("a mismatched 200 POST receipt needs an exact-ID readback", async () => {
  const methods = [];
  let manifestId;
  const fetchImpl = async (_url, options) => {
    methods.push(options.method);
    if (options.method === "POST") {
      manifestId = JSON.parse(options.body).manifestId;
      return json({ manifestId: "dc86a25b-919f-4714-a3d8-45ef5a18b175",
        ideaId, referenceOrdinal: 0, fileCount: 1 });
    }
    return json({ status: "recorded", manifestId, ideaId,
      referenceOrdinal: 0, pinnedCommitSha: "a".repeat(40),
      fileCount: 1, digest: "d".repeat(64), digestKeyId: "digest-key",
      bodyPurged: false });
  };
  assert.deepEqual(await recordAmuxV19LocalReadManifest(input(fetchImpl)),
    { kind: "recorded", manifestId, fileCount: 1, via: "readback" });
  assert.deepEqual(methods, ["POST", "GET"]);
});

test("another attempt's receipt and pending key intent never certify this POST", async () => {
  for (const responseBody of [
    { status: "recorded", manifestId: "dc86a25b-919f-4714-a3d8-45ef5a18b175",
      ideaId, referenceOrdinal: 0, pinnedCommitSha: "a".repeat(40),
      fileCount: 1, digest: "d".repeat(64), digestKeyId: "digest-key",
      bodyPurged: false },
    { status: "key_intent", manifestId: "dc86a25b-919f-4714-a3d8-45ef5a18b175",
      ideaId, referenceOrdinal: 0, pinnedCommitSha: "a".repeat(40),
      retryWrite: false },
  ]) {
    const methods = [];
    const fetchImpl = async (_url, options) => {
      methods.push(options.method);
      return options.method === "POST"
        ? json({ error: "outcome_unknown", retryWrite: false }, 503)
        : json(responseBody);
    };
    const result = await recordAmuxV19LocalReadManifest(input(fetchImpl));
    assert.equal(result.kind, "outcome_unknown");
    assert.deepEqual(methods, ["POST", "GET"]);
  }
});

test("a purged manifest readback cannot release an analysis result", async () => {
  const methods = [];
  let manifestId;
  const fetchImpl = async (_url, options) => {
    methods.push(options.method);
    if (options.method === "POST") {
      manifestId = JSON.parse(options.body).manifestId;
      throw new Error("synthetic lost response after retention purge");
    }
    return json({ status: "recorded", manifestId, ideaId,
      referenceOrdinal: 0, pinnedCommitSha: "a".repeat(40),
      fileCount: 1, digest: "d".repeat(64), digestKeyId: "digest-key",
      bodyPurged: true });
  };
  assert.deepEqual(await recordAmuxV19LocalReadManifest(input(fetchImpl)),
    { kind: "outcome_unknown", manifestId });
  assert.deepEqual(methods, ["POST", "GET"]);
});

test("Max manifest refuses missing or malformed claim before network access", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("unexpected network"); };
  for (const claim of [null, { ...maxClaim, requestId: "bad" },
    { ...maxClaim, invocationOrdinal: 2_147_483_648 },
    { ...maxClaim, extra: "private" }]) {
    assert.deepEqual(await recordAmuxV19MaxLocalReadManifest({
      ...input(fetchImpl), maxClaim: claim }), { kind: "refused" });
  }
  assert.equal(calls, 0);
});

test("Max manifest sends verified paths with its exact identity", async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url,
      "https://tomverse.test/api/internal/amux/v19/max-read-manifest");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["x-amux-agent-id"], "amux-intake-max");
    const body = JSON.parse(options.body);
    for (const [key, value] of Object.entries(maxClaim)) {
      assert.equal(body[key], value);
    }
    assert.deepEqual(body.observed, { kind: "verified_success",
      readFiles: ["docs/guide.md"] });
    assert.doesNotMatch(options.body, /never send model text/);
    return json({ manifestId: body.manifestId, ideaId,
      referenceOrdinal: 0, fileCount: 1 });
  };
  const result = await recordAmuxV19MaxLocalReadManifest({
    ...input(fetchImpl), maxClaim });
  assert.equal(result.kind, "recorded");
  assert.equal(result.via, "post");
});

test("uncertain Max manifest reads its claim and never retries key creation", async () => {
  const methods = [];
  let manifestId;
  const fetchImpl = async (url, options) => {
    methods.push(options.method);
    if (options.method === "POST") {
      manifestId = JSON.parse(options.body).manifestId;
      throw new Error("lost reply");
    }
    const query = new URL(url).searchParams;
    for (const [key, value] of Object.entries(maxClaim)) {
      assert.equal(query.get(key), String(value));
    }
    assert.equal(query.get("ideaId"), ideaId);
    assert.equal(query.get("referenceOrdinal"), "0");
    return json({ status: "recorded", manifestId, ideaId,
      referenceOrdinal: 0, pinnedCommitSha: "a".repeat(40),
      fileCount: 1, digest: "d".repeat(64), digestKeyId: "digest-key",
      bodyPurged: false });
  };
  assert.deepEqual(await recordAmuxV19MaxLocalReadManifest({
    ...input(fetchImpl), maxClaim }),
  { kind: "recorded", manifestId, fileCount: 1, via: "readback" });
  assert.deepEqual(methods, ["POST", "GET"]);
});
