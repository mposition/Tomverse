import assert from "node:assert/strict";
import { after, test } from "node:test";

import { bindAmuxV19ClaimStopCheck,
  finishAmuxV19TrackedCheckoutWithReceipts,
  runAmuxV19TrackedCheckoutAnalysisWithReceipts } from
  "../lib/amux/ideaLocalTrackedCheckoutAnalysisWithReceipts.mjs";

const originEnv = "TOMVERSE_AMUX_V4_ANALYSIS_APP_ORIGIN";
const previousOrigin = process.env[originEnv];
const sessionOriginEnv = "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN";
const previousSessionOrigin = process.env[sessionOriginEnv];
process.env[originEnv] = "https://tomverse.test/";
process.env[sessionOriginEnv] = "https://tomverse.test/";
after(() => {
  if (previousOrigin === undefined) delete process.env[originEnv];
  else process.env[originEnv] = previousOrigin;
  if (previousSessionOrigin === undefined) delete process.env[sessionOriginEnv];
  else process.env[sessionOriginEnv] = previousSessionOrigin;
});

const ideaId = "ea86a25b-919f-4714-a3d8-45ef5a18b175";
const claimId = "ea86a25b-919f-4714-a3d8-45ef5a18b176";
const reservationId = "ea86a25b-919f-4714-a3d8-45ef5a18b177";
const evidenceId = "fbd49038-b8e0-4796-8530-a2adcb7d0dbd";
const observed = {
  kind: "verified_success", cliStarted: true,
  commitSha: "a".repeat(40), excludedCount: 1,
  excludedPathDigest: "b".repeat(64),
  excludedReasons: { secret_path: 1, secret_content: 0,
    non_regular: 0, unscannable_content: 0 },
  readFiles: ["docs/guide.md"], rawModelOutput: "private answer",
  inputTokens: 20, outputTokens: 10,
};
const input = (fetchImpl) => ({ origin: "https://tomverse.test/",
  agentSecret: "v19_analysis_agent_secret_01234567890123456789",
  ideaId, claimId, reservationId, referenceOrdinal: 0,
  commitSha: observed.commitSha,
  excludedPathDigestKeyId: "checkout-digest-v1", fetchImpl });
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

test("invalid receipt binding refuses before the CLI can run", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("network"); };
  for (const invalid of [
    { ...input(fetchImpl), origin: "https://other.test/" },
    { ...input(fetchImpl), excludedPathDigestKeyId: undefined },
    { ...input(fetchImpl), excludedPathDigestKeyId: null },
    { ...input(fetchImpl), ideaId: undefined },
    { ...input(fetchImpl), claimId: undefined },
    { ...input(fetchImpl), reservationId: undefined },
  ]) {
    assert.deepEqual(await runAmuxV19TrackedCheckoutAnalysisWithReceipts(invalid),
      { kind: "refused" });
    assert.deepEqual(await finishAmuxV19TrackedCheckoutWithReceipts(invalid, observed),
      { kind: "refused" });
  }
  assert.equal(calls, 0);
});

test("checkout supervisor binds its stop check to the exact claim", async () => {
  const urls = [];
  const base = input(async (url) => {
    urls.push(url);
    return json({ claimId, reservationId, stop: false });
  });
  const stopCheck = bindAmuxV19ClaimStopCheck({
    ...base, stopCheck: async () => false,
  });
  assert.equal(typeof stopCheck, "function");
  assert.equal(await stopCheck(), false);
  assert.deepEqual(urls, [
    `https://tomverse.test/api/internal/amux/v19/session-analysis-stop?claimId=${claimId}&reservationId=${reservationId}&ideaId=${ideaId}`,
  ]);
  const mutable = { ...base };
  const pinned = bindAmuxV19ClaimStopCheck(mutable);
  mutable.claimId = ideaId;
  assert.equal(await pinned(), false);
  assert.equal(urls[1], urls[0]);
  assert.equal(bindAmuxV19ClaimStopCheck({ ...base,
    reservationId: undefined }), null);
  assert.equal(bindAmuxV19ClaimStopCheck({ ...base,
    ideaId: undefined }), null);
  assert.equal(bindAmuxV19ClaimStopCheck({ ...base,
    origin: "https://other.test/" }), null);
  assert.equal(await bindAmuxV19ClaimStopCheck({ ...base,
    fetchImpl: async () => json({ claimId, reservationId, stop: true }) })(), true);
  assert.equal(await bindAmuxV19ClaimStopCheck({ ...base,
    fetchImpl: async () => { throw new Error("offline"); } })(), true);
});

test("the closed host switch returns a refusal without writing receipts", async () => {
  const switchName = "TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI";
  const previous = process.env[switchName];
  process.env[switchName] = "disabled";
  let calls = 0;
  try {
    const result = await runAmuxV19TrackedCheckoutAnalysisWithReceipts(
      input(async () => { calls += 1; throw new Error("network"); }));
    assert.deepEqual(result, { kind: "refused", cliStarted: false });
    assert.equal(calls, 0);
  } finally {
    if (previous === undefined) delete process.env[switchName];
    else process.env[switchName] = previous;
  }
});

test("an enabled host refuses a different intake pin before checkout", async () => {
  const switchName = "TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI";
  const previousSwitch = process.env[switchName];
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  process.env[switchName] = "enabled";
  const paths = [];
  try {
    const result = await runAmuxV19TrackedCheckoutAnalysisWithReceipts(
      input(async (url) => {
        paths.push(new URL(url).pathname);
        return json({ referenceCount: 1, pinnedCommitSha: "b".repeat(40) });
      }));
    assert.deepEqual(result, { kind: "outcome_unknown", cliStarted: false });
    assert.deepEqual(paths, ["/api/internal/amux/v19/reference-pin"]);
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (previousSwitch === undefined) delete process.env[switchName];
    else process.env[switchName] = previousSwitch;
  }
});

test("verified model output is returned only after both receipts", async () => {
  const calls = [];
  let manifestId;
  const fetchImpl = async (url, options) => {
    calls.push(`${options.method} ${new URL(url).pathname}`);
    if (url.endsWith("/checkout-evidence")) {
      assert.doesNotMatch(options.body, /docs\/guide|private answer/);
      return json({ evidenceId, ideaId, referenceOrdinal: 0 });
    }
    const body = JSON.parse(options.body);
    manifestId = body.manifestId;
    assert.deepEqual(body.observed, { kind: "verified_success",
      readFiles: ["docs/guide.md"] });
    return json({ manifestId, ideaId, referenceOrdinal: 0, fileCount: 1 });
  };
  assert.deepEqual(await finishAmuxV19TrackedCheckoutWithReceipts(
    input(fetchImpl), observed), {
    ...observed, evidenceId, readManifestId: manifestId,
  });
  assert.deepEqual(calls, [
    "POST /api/internal/amux/v19/checkout-evidence",
    "POST /api/internal/amux/v19/read-manifest",
  ]);
});

test("unknown evidence or manifest receipt suppresses model output", async () => {
  for (const failedPath of ["checkout-evidence", "read-manifest"]) {
    const calls = [];
    const fetchImpl = async (url, options) => {
      const path = new URL(url).pathname;
      calls.push(`${options.method} ${path}`);
      if (path.endsWith(failedPath)) {
        return options.method === "POST"
          ? json({ error: "outcome_unknown", retryWrite: false }, 503)
          : json({ status: "absent", ideaId, referenceOrdinal: 0,
            retryWrite: false }, 404);
      }
      return json({ evidenceId, ideaId, referenceOrdinal: 0 });
    };
    const result = await finishAmuxV19TrackedCheckoutWithReceipts(
      input(fetchImpl), observed);
    assert.equal(result.kind, "outcome_unknown");
    assert.equal(result.cliStarted, true);
    assert.equal(result.receiptStage, failedPath === "checkout-evidence"
      ? "checkout_evidence" : "read_manifest");
    assert.equal(result.receiptOutcome, "outcome_unknown");
    assert.equal(Object.hasOwn(result, "rawModelOutput"), false);
    assert.equal(Object.hasOwn(result, "readFiles"), false);
    if (failedPath === "read-manifest") {
      assert.equal(result.evidenceId, evidenceId);
      assert.match(result.readManifestId, /^[a-f0-9-]{36}$/);
    }
    assert.equal(calls.filter((call) => call.startsWith("POST")).length,
      failedPath === "checkout-evidence" ? 1 : 2);
  }
});

test("SHA mismatch or unfinished host observation never persists receipts", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("network"); };
  assert.deepEqual(await finishAmuxV19TrackedCheckoutWithReceipts(
    input(fetchImpl), { ...observed, commitSha: "c".repeat(40) }),
  { kind: "outcome_unknown", cliStarted: true });
  assert.deepEqual(await finishAmuxV19TrackedCheckoutWithReceipts(
    input(fetchImpl), { kind: "outcome_unknown", cliStarted: true }),
  { kind: "outcome_unknown", cliStarted: true });
  assert.equal(calls, 0);
});
