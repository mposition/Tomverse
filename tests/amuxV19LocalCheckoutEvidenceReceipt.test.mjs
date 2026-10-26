import assert from "node:assert/strict";
import { after, test } from "node:test";

import { recordAmuxV19LocalCheckoutEvidence,
  recordAmuxV19MaxLocalCheckoutEvidence,
  recordAmuxV19VerifiedCheckoutReceipts } from
  "../lib/amux/ideaLocalCheckoutEvidenceReceipt.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "../lib/amux/ideaLocalSessionAnalysisQueuePoll.mjs";

// v4 receipts use the v4 app origin; Max (v19 session) receipts use the v19
// session origin. Both point at the same synthetic app here.
const originEnvs = ["TOMVERSE_AMUX_V4_ANALYSIS_APP_ORIGIN",
  AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV];
const previousOrigins = originEnvs.map((name) => process.env[name]);
for (const name of originEnvs) process.env[name] = "https://tomverse.test/";
after(() => {
  originEnvs.forEach((name, index) => {
    if (previousOrigins[index] === undefined) delete process.env[name];
    else process.env[name] = previousOrigins[index];
  });
});

const ideaId = "ea86a25b-919f-4714-a3d8-45ef5a18b175";
const evidenceId = "fbd49038-b8e0-4796-8530-a2adcb7d0dbd";
const maxClaim = { claimId: "8a58e063-374d-4c6c-b1bd-57e8daa55c48",
  requestId: "a12ae2bc-5e33-44a2-9836-6a3648061820",
  reservationId: "ceb12ab5-d7fb-482f-bc5b-feb279cc043d",
  invocationOrdinal: 0 };
const secret = "v19_evidence_agent_secret_01234567890123456789";
const evidence = {
  ideaId, referenceOrdinal: 0, pinnedCommitSha: "a".repeat(40),
  excludedCount: 2, excludedPathDigest: "b".repeat(64),
  excludedPathDigestKeyId: "checkout-digest-v1",
  excludedReasons: { secret_path: 1, secret_content: 1,
    non_regular: 0, unscannable_content: 0 },
};
const observed = { kind: "verified_success", commitSha: evidence.pinnedCommitSha,
  excludedCount: evidence.excludedCount,
  excludedPathDigest: evidence.excludedPathDigest,
  excludedReasons: evidence.excludedReasons,
  rawModelOutput: "never send model text", readFiles: ["docs/guide.md"] };
const input = (fetchImpl) => ({ origin: "https://tomverse.test/",
  agentSecret: secret, ideaId, referenceOrdinal: 0,
  excludedPathDigestKeyId: evidence.excludedPathDigestKeyId,
  observed, fetchImpl });
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

test("invalid or unverified checkout proof never crosses the network", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("unexpected network"); };
  for (const candidate of [
    { ...input(fetchImpl), origin: "https://other.test/" },
    { ...input(fetchImpl), observed: { ...observed, kind: "outcome_unknown" } },
    { ...input(fetchImpl), observed: { ...observed, excludedCount: 1 } },
    { ...input(fetchImpl), observed: { ...observed, commitSha: "A".repeat(40) } },
  ]) assert.deepEqual(await recordAmuxV19LocalCheckoutEvidence(candidate),
    { kind: "refused" });
  assert.equal(calls, 0);
});

test("one POST sends only content-free proof and accepts the exact receipt", async () => {
  const methods = [];
  const fetchImpl = async (url, options) => {
    methods.push(options.method);
    assert.equal(url, "https://tomverse.test/api/internal/amux/v19/checkout-evidence");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "manual");
    assert.equal(options.cache, "no-store");
    assert.deepEqual(JSON.parse(options.body), evidence);
    assert.doesNotMatch(options.body, /docs\/guide|never send model text/);
    return json({ evidenceId, ideaId, referenceOrdinal: 0 });
  };
  assert.deepEqual(await recordAmuxV19LocalCheckoutEvidence(input(fetchImpl)),
    { kind: "recorded", evidenceId, via: "post" });
  assert.deepEqual(methods, ["POST"]);
});

test("lost POST response uses exact readback and never replays proof", async () => {
  const methods = [];
  const fetchImpl = async (url, options) => {
    methods.push(options.method);
    if (options.method === "POST") throw new Error("lost after commit");
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    assert.match(url, /ideaId=ea86a25b-919f-4714-a3d8-45ef5a18b175/);
    assert.doesNotMatch(url, /docs\/guide|never send model text/);
    return json({ status: "recorded", evidenceId, ...evidence });
  };
  assert.deepEqual(await recordAmuxV19LocalCheckoutEvidence(input(fetchImpl)),
    { kind: "recorded", evidenceId, via: "readback" });
  assert.deepEqual(methods, ["POST", "GET"]);
});

test("already-recorded POST recovers only matching checkout proof", async () => {
  const methods = [];
  const fetchImpl = async (_url, options) => {
    methods.push(options.method);
    return options.method === "POST"
      ? json({ error: "already_recorded", retryWrite: false }, 409)
      : json({ status: "recorded", evidenceId, ...evidence });
  };
  assert.deepEqual(await recordAmuxV19LocalCheckoutEvidence(input(fetchImpl)),
    { kind: "recorded", evidenceId, via: "readback" });
  assert.deepEqual(methods, ["POST", "GET"]);
});

test("mismatched receipt or evidence from another checkout remains unknown", async () => {
  for (const readback of [
    { status: "recorded", evidenceId, ...evidence,
      pinnedCommitSha: "c".repeat(40) },
    { status: "recorded", evidenceId, ...evidence,
      excludedReasons: { ...evidence.excludedReasons, secret_path: 2 } },
    { status: "absent", ideaId, referenceOrdinal: 0, retryWrite: false },
  ]) {
    const methods = [];
    const fetchImpl = async (_url, options) => {
      methods.push(options.method);
      return options.method === "POST"
        ? json({ evidenceId, ideaId: "different", referenceOrdinal: 0 })
        : json(readback, readback.status === "absent" ? 404 : 200);
    };
    assert.deepEqual(await recordAmuxV19LocalCheckoutEvidence(input(fetchImpl)),
      { kind: "outcome_unknown", reason: "write_unconfirmed" });
    assert.deepEqual(methods, ["POST", "GET"]);
  }
});

test("verified checkout proof precedes its path manifest", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(`${options.method} ${new URL(url).pathname}`);
    if (url.endsWith("/checkout-evidence")) {
      return json({ evidenceId, ideaId, referenceOrdinal: 0 });
    }
    assert.equal(url, "https://tomverse.test/api/internal/amux/v19/read-manifest");
    const body = JSON.parse(options.body);
    assert.deepEqual(body.observed, { kind: "verified_success",
      readFiles: ["docs/guide.md"] });
    return json({ manifestId: body.manifestId, ideaId,
      referenceOrdinal: 0, fileCount: 1 });
  };
  const result = await recordAmuxV19VerifiedCheckoutReceipts(input(fetchImpl));
  assert.equal(result.kind, "recorded");
  assert.equal(result.evidenceId, evidenceId);
  assert.equal(result.fileCount, 1);
  assert.deepEqual(calls, [
    "POST /api/internal/amux/v19/checkout-evidence",
    "POST /api/internal/amux/v19/read-manifest",
  ]);
});

test("unknown checkout proof never submits read paths", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(`${options.method} ${new URL(url).pathname}`);
    return options.method === "POST"
      ? json({ error: "outcome_unknown", retryWrite: false }, 503)
      : json({ status: "absent", ideaId, referenceOrdinal: 0,
        retryWrite: false }, 404);
  };
  assert.deepEqual(await recordAmuxV19VerifiedCheckoutReceipts(input(fetchImpl)),
    { kind: "outcome_unknown", stage: "checkout_evidence" });
  assert.deepEqual(calls, [
    "POST /api/internal/amux/v19/checkout-evidence",
    "GET /api/internal/amux/v19/checkout-evidence",
  ]);
});

test("Max checkout proof requires a complete exact claim before network access", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("unexpected network"); };
  for (const maxClaimCandidate of [null,
    { ...maxClaim, claimId: "bad" },
    { ...maxClaim, invocationOrdinal: 2_147_483_648 },
    { ...maxClaim, extra: "private" }]) {
    assert.deepEqual(await recordAmuxV19MaxLocalCheckoutEvidence({
      ...input(fetchImpl), maxClaim: maxClaimCandidate }), { kind: "refused" });
  }
  assert.equal(calls, 0);
});

test("Max checkout proof sends aggregate data under Max identity", async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url,
      "https://tomverse.test/api/internal/amux/v19/max-checkout-evidence");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["x-amux-agent-id"], "amux-intake-max");
    assert.deepEqual(JSON.parse(options.body), { ...maxClaim, ...evidence });
    assert.doesNotMatch(options.body, /docs\/guide|never send model text/);
    return json({ evidenceId, ideaId, referenceOrdinal: 0 });
  };
  assert.deepEqual(await recordAmuxV19MaxLocalCheckoutEvidence({
    ...input(fetchImpl), maxClaim }),
  { kind: "recorded", evidenceId, via: "post" });
});

test("uncertain Max proof reads back its claim without retrying POST", async () => {
  const methods = [];
  const fetchImpl = async (url, options) => {
    methods.push(options.method);
    if (options.method === "POST") throw new Error("lost reply");
    const query = new URL(url).searchParams;
    for (const [key, value] of Object.entries(maxClaim)) {
      assert.equal(query.get(key), String(value));
    }
    assert.equal(query.get("ideaId"), ideaId);
    assert.equal(query.get("referenceOrdinal"), "0");
    return json({ status: "recorded", evidenceId, ...evidence });
  };
  assert.deepEqual(await recordAmuxV19MaxLocalCheckoutEvidence({
    ...input(fetchImpl), maxClaim }),
  { kind: "recorded", evidenceId, via: "readback" });
  assert.deepEqual(methods, ["POST", "GET"]);
});
