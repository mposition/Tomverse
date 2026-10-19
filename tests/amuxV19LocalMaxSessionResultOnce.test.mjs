import assert from "node:assert/strict";
import { after, test } from "node:test";

import { recordAmuxV19MaxSessionResultOnce } from
  "../lib/amux/ideaLocalMaxSessionResultOnce.mjs";

const origin = "https://staging.tomverse.test/";
const names = ["TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN",
  "TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET"];
const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
after(() => {
  for (const name of names) {
    if (prior[name] === undefined) delete process.env[name];
    else process.env[name] = prior[name];
  }
});
const secret = "syntheticMaxResultSecret_0123456789abcdefgh";
const input = { claimId: "d57eac94-9808-4688-a9f8-940aa3c22188",
  requestId: "fd31e8e8-3e71-4af6-b0a2-c834170b9a92",
  reservationId: "0b82536e-8cf9-4afa-a5b5-f022c73c9ec0",
  ideaId: "aeb93a68-a941-40ed-9782-9abbb3f2139f",
  invocationOrdinal: 0, referenceOrdinal: 0,
  evidenceId: "59818d23-7798-4cfd-9d49-9a3f69653673",
  manifestId: "13638989-a338-461d-9777-7b3fd3c595ab",
  rawModelOutput: "{\"units\":[]}",
  inputTokens: 100, outputTokens: 10 };
const digest = "a".repeat(64);
const write = { claimId: input.claimId,
  resultAuditId: "clsyntheticresult123",
  settlementAuditId: "clsyntheticsettlement123",
  digest, digestKeyId: "synthetic-digest",
  plan: { state: "plan_refused", reason: "invalid_result" },
  registration: { state: "not_planned" } };
const enable = () => {
  process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN = origin;
  process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET = secret;
};

test("one Max result write returns the exact content-free receipt", async () => {
  enable();
  const calls = [];
  const result = await recordAmuxV19MaxSessionResultOnce({ origin, input,
    fetchImpl: async (url, options) => {
      calls.push(options.method);
      assert.equal(url,
        `${origin}api/internal/amux/v19/session-analysis-result`);
      assert.equal(options.headers.authorization, `Bearer ${secret}`);
      assert.deepEqual(JSON.parse(options.body), input);
      return Response.json(write);
    } });
  assert.deepEqual(result, { kind: "recorded", recovered: false,
    retryWrite: false, digest, digestKeyId: "synthetic-digest",
    planState: "plan_refused", registrationState: "not_planned" });
  assert.deepEqual(calls, ["POST"]);
});

test("lost Max result response reads once and never resends the body", async () => {
  enable();
  const calls = [];
  const result = await recordAmuxV19MaxSessionResultOnce({ origin, input,
    fetchImpl: async (url, options) => {
      calls.push(options.method);
      if (options.method === "POST") throw new Error("synthetic lost reply");
      assert.equal(new URL(url).searchParams.get("claimId"), input.claimId);
      assert.equal(options.body, undefined);
      return Response.json({ status: "committed", claimId: input.claimId,
        digest, digestKeyId: "synthetic-digest" });
    } });
  assert.deepEqual(result, { kind: "recorded", recovered: true,
    retryWrite: false, digest, digestKeyId: "synthetic-digest" });
  assert.deepEqual(calls, ["POST", "GET"]);
});

test("absent readback halts without a second result write", async () => {
  enable();
  const calls = [];
  const result = await recordAmuxV19MaxSessionResultOnce({ origin, input,
    fetchImpl: async (_url, options) => {
      calls.push(options.method);
      return options.method === "POST" ? Response.json({ error: "unknown" },
        { status: 503 }) : Response.json({ status: "absent",
        claimId: input.claimId });
    } });
  assert.deepEqual(result, { kind: "outcome_unknown", retryWrite: false });
  assert.deepEqual(calls, ["POST", "GET"]);
});

test("invalid binding is refused before network access", async () => {
  enable();
  assert.deepEqual(await recordAmuxV19MaxSessionResultOnce({ origin,
    input: { ...input, evidenceId: "not-an-id" },
    fetchImpl: () => { throw new Error("network reached"); } }),
  { kind: "refused", retryWrite: false });
});
