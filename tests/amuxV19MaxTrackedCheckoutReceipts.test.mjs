import assert from "node:assert/strict";
import { after, test } from "node:test";

import { finalizeAmuxV19MaxSessionResultWithReceipts,
  finishAmuxV19MaxTrackedCheckoutWithReceipts } from
  "../lib/amux/ideaLocalMaxTrackedCheckoutReceipts.mjs";

const names = ["TOMVERSE_AMUX_V4_ANALYSIS_APP_ORIGIN",
  "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN",
  "TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET"];
const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
delete process.env[names[0]];
process.env[names[1]] = "https://amux.example.test/";
process.env[names[2]] = "syntheticMaxLauncherSecret_0123456789abcdefgh";
after(() => {
  for (const name of names) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});

const identity = { claimId: "9942fb52-4b78-4af6-931a-9eec8f66d394",
  requestId: "44c72436-c011-4cfc-b52f-e3345c22fc80",
  reservationId: "bf72ad14-585c-41bd-b25e-aab4c17a6d3c",
  ideaId: "53d6918e-b05d-4531-a1ab-704dd756cc40",
  invocationOrdinal: 0 };
const observed = { kind: "verified_success", cliStarted: true,
  commitSha: "a".repeat(40), excludedCount: 1,
  excludedPathDigest: "b".repeat(64),
  excludedReasons: { secret_path: 1, secret_content: 0,
    non_regular: 0, unscannable_content: 0 },
  readFiles: ["docs/guide.md"], rawModelOutput: "private answer",
  inputTokens: 20, outputTokens: 10 };
const evidenceId = "fbd49038-b8e0-4796-8530-a2adcb7d0dbd";
const input = (fetchImpl) => ({ origin: "https://amux.example.test/",
  identity, referenceOrdinal: 0, commitSha: observed.commitSha,
  excludedPathDigestKeyId: "checkout-digest-v1", fetchImpl });

test("a verified Max observation releases output after both claim-bound receipts", async () => {
  const calls = [];
  let manifestId;
  const result = await finishAmuxV19MaxTrackedCheckoutWithReceipts(
    input(async (url, options) => {
      const path = new URL(url).pathname;
      calls.push(`${options.method} ${path}`);
      assert.equal(options.headers["x-amux-agent-id"], "amux-intake-max");
      assert.equal(options.headers.authorization,
        `Bearer ${process.env[names[2]]}`);
      if (path.endsWith("/session-analysis-stop")) return Response.json({
        claimId: identity.claimId, reservationId: identity.reservationId,
        stop: false });
      const body = JSON.parse(options.body);
      for (const key of ["claimId", "requestId", "reservationId",
        "invocationOrdinal"]) assert.equal(body[key], identity[key]);
      assert.doesNotMatch(options.body, /private answer/);
      if (path.endsWith("/max-checkout-evidence")) {
        assert.equal(body.ideaId, identity.ideaId);
        return Response.json({ evidenceId, ideaId: identity.ideaId,
          referenceOrdinal: 0 });
      }
      manifestId = body.manifestId;
      assert.deepEqual(body.observed, { kind: "verified_success",
        readFiles: ["docs/guide.md"] });
      return Response.json({ manifestId, ideaId: identity.ideaId,
        referenceOrdinal: 0, fileCount: 1 });
    }), observed);
  assert.deepEqual(result, { ...observed, evidenceId,
    readManifestId: manifestId });
  assert.deepEqual(calls, [
    "GET /api/internal/amux/v19/session-analysis-stop",
    "POST /api/internal/amux/v19/max-checkout-evidence",
    "GET /api/internal/amux/v19/session-analysis-stop",
    "POST /api/internal/amux/v19/max-read-manifest",
    "GET /api/internal/amux/v19/session-analysis-stop",
  ]);
});

test("Max output is posted only after both exact source receipts", async () => {
  const calls = [];
  const digest = "c".repeat(64);
  const result = await finalizeAmuxV19MaxSessionResultWithReceipts(
    input(async (url, options) => {
      const path = new URL(url).pathname;
      calls.push(`${options.method} ${path}`);
      if (path.endsWith("/session-analysis-stop")) return Response.json({
        claimId: identity.claimId, reservationId: identity.reservationId,
        stop: false });
      const body = JSON.parse(options.body);
      if (path.endsWith("/max-checkout-evidence")) {
        assert.doesNotMatch(options.body, /private answer/);
        return Response.json({ evidenceId, ideaId: identity.ideaId,
          referenceOrdinal: 0 });
      }
      if (path.endsWith("/max-read-manifest")) {
        assert.doesNotMatch(options.body, /private answer/);
        return Response.json({ manifestId: body.manifestId,
          ideaId: identity.ideaId, referenceOrdinal: 0, fileCount: 1 });
      }
      assert.ok(path.endsWith("/session-analysis-result"));
      assert.equal(body.rawModelOutput, "private answer");
      assert.equal(body.evidenceId, evidenceId);
      assert.match(body.manifestId, /^[a-f0-9-]{36}$/);
      return Response.json({ claimId: identity.claimId,
        resultAuditId: "clsyntheticresult123",
        settlementAuditId: "clsyntheticsettlement123",
        digest, digestKeyId: "synthetic-digest" });
    }), observed);
  assert.deepEqual(result, { kind: "recorded", recovered: false,
    retryWrite: false, digest, digestKeyId: "synthetic-digest" });
  assert.deepEqual(calls, [
    "GET /api/internal/amux/v19/session-analysis-stop",
    "POST /api/internal/amux/v19/max-checkout-evidence",
    "GET /api/internal/amux/v19/session-analysis-stop",
    "POST /api/internal/amux/v19/max-read-manifest",
    "GET /api/internal/amux/v19/session-analysis-stop",
    "GET /api/internal/amux/v19/session-analysis-stop",
    "POST /api/internal/amux/v19/session-analysis-result",
  ]);
});

test("stop and mismatched identity suppress output before evidence writes", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++;
    return Response.json({ claimId: identity.claimId,
      reservationId: identity.reservationId, stop: true }); };
  assert.deepEqual(await finishAmuxV19MaxTrackedCheckoutWithReceipts(
    input(fetchImpl), observed), { kind: "outcome_unknown", cliStarted: true });
  assert.equal(calls, 1);
  assert.deepEqual(await finishAmuxV19MaxTrackedCheckoutWithReceipts(
    { ...input(fetchImpl), identity: { ...identity, claimId: "other" } },
    observed), { kind: "refused" });
  assert.deepEqual(await finishAmuxV19MaxTrackedCheckoutWithReceipts(
    input(fetchImpl), { ...observed, commitSha: "c".repeat(40) }),
  { kind: "outcome_unknown", cliStarted: true });
  assert.equal(calls, 1);
});

test("an uncertain manifest write reads once but never replays or releases output", async () => {
  const calls = [];
  const result = await finishAmuxV19MaxTrackedCheckoutWithReceipts(
    input(async (url, options) => {
      const path = new URL(url).pathname;
      calls.push(`${options.method} ${path}`);
      if (path.endsWith("/session-analysis-stop")) return Response.json({
        claimId: identity.claimId, reservationId: identity.reservationId,
        stop: false });
      if (path.endsWith("/max-checkout-evidence")) return Response.json({
        evidenceId, ideaId: identity.ideaId, referenceOrdinal: 0 });
      if (options.method === "POST") throw new Error("lost response");
      return Response.json({ status: "absent" }, { status: 404 });
    }), observed);
  assert.equal(result.kind, "outcome_unknown");
  assert.equal(result.receiptStage, "read_manifest");
  assert.equal(Object.hasOwn(result, "rawModelOutput"), false);
  assert.equal(calls.filter((call) => call.startsWith("POST")).length, 2);
  assert.equal(calls.filter((call) => call.startsWith("GET") &&
    call.endsWith("/max-read-manifest")).length, 1);
});
