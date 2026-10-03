import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runAmuxV4SyntheticAnalysisAgentOnce } from
  "../lib/amux/ideaLocalAnalysisAgentOnce.mjs";
import { runAmuxV4LocalAnalysisAdmissionForTest } from
  "../lib/amux/ideaLocalAnalysisAgentOnce.mjs";
import { runAmuxV4LocalAnalysisAgentOnce } from
  "../lib/amux/ideaLocalAnalysisAgentOnce.mjs";
import { AMUX_V4_ANALYSIS_APP_ORIGIN_ENV } from
  "../lib/amux/ideaLocalQueuePoll.mjs";

const origin = "https://staging.tomverse.example";
const secret = "v4_analysis_synthetic_012345678901234567890123456";
const previewId = "preview_1";
const ideaId = "idea_1";
const candidate = { previewId, ideaId, chunkIndex: 0, attempt: 1,
  modelId: "frontier-model", expiresAt: "2026-10-05T00:00:00.000Z" };
const claim = { previewId, ideaId, holdId: "hold_1", leaseGeneration: 1,
  provider: "openai", modelId: "frontier-model", reasoningEffort: "high",
  prompt: `{"previewId":"${previewId}","source":"synthetic"}`,
  auditId: "audit_1" };
const response = (body, status = 200) => Response.json(body, { status });

test("local one-shot entry point is closed before reading configuration", () => {
  const script = fileURLToPath(new URL(
    "../scripts/amux-v4-analysis-agent-once.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /AMUX_V4_LOCAL_ANALYSIS_REFUSED/);
});

test("live connector refuses before queue, claim or CLI while code latch is off", async () => {
  let called = 0;
  const result = await runAmuxV4LocalAnalysisAgentOnce({ origin: `${origin}/`,
    agentSecret: secret, fetchImpl: async () => { called += 1;
      throw new Error("live connector must remain closed"); } });
  assert.deepEqual(result, { kind: "refused" });
  assert.equal(called, 0);
});

test("unapproved local CLI catalog stops before claim and model execution", async () => {
  const previousEnv = process.env.NODE_ENV;
  const previousOrigin = process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV];
  process.env.NODE_ENV = "test";
  process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV] = `${origin}/`;
  const visited = [];
  try {
    const result = await runAmuxV4LocalAnalysisAdmissionForTest({
      origin: `${origin}/`, agentSecret: secret,
      fetchImpl: async (url) => {
        visited.push(url);
        if (url.endsWith("/analysis-queue")) return response({
          candidates: [candidate], hasMore: false, nextCursor: null });
        throw new Error("unapproved catalog consumed a claim");
      },
      fakeExecute: async () => { throw new Error("unapproved model invoked"); },
    });
    assert.deepEqual(result, { kind: "catalog_unapproved" });
    assert.equal(visited.length, 1);
  } finally {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
    if (previousOrigin === undefined) delete process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV];
    else process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV] = previousOrigin;
  }
});

test("synthetic one-shot polls, claims, passes only typed prompt, submits and stops", async () => {
  const previousEnv = process.env.NODE_ENV;
  const previousOrigin = process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV];
  process.env.NODE_ENV = "test";
  process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV] = `${origin}/`;
  const visited = [];
  try {
    const result = await runAmuxV4SyntheticAnalysisAgentOnce({
      origin: `${origin}/`, agentSecret: secret,
      fetchImpl: async (url, options) => {
        visited.push({ url, options });
        if (url.endsWith("/analysis-queue")) return response({
          candidates: [candidate], hasMore: false, nextCursor: null });
        if (url.endsWith("/analysis-claim")) return response(claim);
        if (url.endsWith("/analysis-result")) return response({
          previewId, ideaId, state: "draft_ready", duplicate: false,
          auditId: "audit_result_1" });
        throw new Error("unexpected path");
      },
      fakeExecute: async (execution) => {
        const { prompt, provider, modelId, reasoningEffort } = execution;
        assert.equal(prompt.toString("utf8"), claim.prompt);
        assert.deepEqual([provider, modelId, reasoningEffort],
          ["openai", "frontier-model", "high"]);
        assert.deepEqual(Object.keys(execution).sort(),
          ["modelId", "prompt", "provider", "reasoningEffort"]);
        return { rawModelOutput: JSON.stringify({ schemaVersion: 2,
          previewId, chunkIndex: 0, outcome: "needs_owner_input" }),
          inputTokens: 10, outputTokens: 2 };
      },
    });
    assert.deepEqual(result, { kind: "draft_ready" });
    assert.equal(visited.length, 3);
    const claimRequest = JSON.parse(visited[1].options.body);
    assert.equal(claimRequest.previewId, previewId);
    assert.match(claimRequest.requestId, /^[a-f0-9-]{36}$/);
    const submitted = JSON.parse(visited[2].options.body);
    assert.equal(submitted.holdId, "hold_1");
    assert.equal(submitted.leaseGeneration, 1);
    assert.match(submitted.requestId, /^[a-f0-9-]{36}$/);
    assert.equal(submitted.outcome, "verified_success");
    assert.equal(visited.every(({ options }) =>
      options.headers.authorization === `Bearer ${secret}`), true);
  } finally {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
    if (previousOrigin === undefined) delete process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV];
    else process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV] = previousOrigin;
  }
});

test("synthetic one-shot reads back lost result once and does not resubmit", async () => {
  const previousEnv = process.env.NODE_ENV;
  const previousOrigin = process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV];
  process.env.NODE_ENV = "test";
  process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV] = `${origin}/`;
  const visited = [];
  try {
    const result = await runAmuxV4SyntheticAnalysisAgentOnce({
      origin: `${origin}/`, agentSecret: secret,
      fetchImpl: async (url, options) => {
        visited.push({ url, method: options.method });
        if (url.endsWith("/analysis-queue")) return response({
          candidates: [candidate], hasMore: false, nextCursor: null });
        if (url.endsWith("/analysis-claim")) return response(claim);
        if (url.endsWith("/analysis-result")) throw new Error("lost response");
        if (url.includes("/analysis-result?")) return response({
          status: "committed", previewId, ideaId, state: "draft_ready",
          duplicate: true, auditId: "audit_result_2" });
        throw new Error("unexpected path");
      },
      fakeExecute: async () => ({ rawModelOutput: JSON.stringify({
        schemaVersion: 2, previewId, chunkIndex: 0,
        outcome: "needs_owner_input" }), inputTokens: 10, outputTokens: 2 }),
    });
    assert.deepEqual(result, { kind: "draft_ready" });
    assert.deepEqual(visited.map(({ method }) => method),
      ["POST", "POST", "POST", "GET"]);
  } finally {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
    if (previousOrigin === undefined) delete process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV];
    else process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV] = previousOrigin;
  }
});

test("synthetic supervisor reports known overlong output as failed and unknown usage as a halt", async () => {
  const previousEnv = process.env.NODE_ENV;
  const previousOrigin = process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV];
  process.env.NODE_ENV = "test";
  process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV] = `${origin}/`;
  try {
    for (const sample of [
      { outcome: "invocation_failed", state: "provider_failed",
        fakeExecute: async () => ({ rawModelOutput: "가".repeat(30_000),
          inputTokens: 100, outputTokens: 50 }) },
      { outcome: "outcome_unknown", state: "outcome_unknown",
        fakeExecute: async () => { throw new Error("usage unavailable"); } },
    ]) {
      let posted;
      const result = await runAmuxV4SyntheticAnalysisAgentOnce({
        origin: `${origin}/`, agentSecret: secret,
        fetchImpl: async (url, options) => {
          if (url.endsWith("/analysis-queue")) return response({
            candidates: [candidate], hasMore: false, nextCursor: null });
          if (url.endsWith("/analysis-claim")) return response(claim);
          if (url.endsWith("/analysis-result")) {
            posted = JSON.parse(options.body);
            return response({ previewId, ideaId, state: sample.state,
              duplicate: false, auditId: "audit_failure_1" });
          }
          throw new Error("unexpected path");
        }, fakeExecute: sample.fakeExecute,
      });
      assert.deepEqual(result, { kind: sample.state });
      assert.equal(posted.outcome, sample.outcome);
      assert.equal(posted.rawModelOutput, null);
      assert.equal(posted.inputTokens, sample.outcome === "outcome_unknown" ? null : 100);
    }
  } finally {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
    if (previousOrigin === undefined) delete process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV];
    else process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV] = previousOrigin;
  }
});

test("synthetic one-shot does not execute after disabled or uncertain claim", async () => {
  const previousEnv = process.env.NODE_ENV;
  const previousOrigin = process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV];
  process.env.NODE_ENV = "test";
  process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV] = `${origin}/`;
  let executed = 0;
  try {
    for (const claimReply of [response({ available: false,
      reason: "analysis_claim_disabled" }, 409),
      response({ ...claim, unexpected: "payload" })]) {
      let calls = 0;
      const result = await runAmuxV4SyntheticAnalysisAgentOnce({
        origin: `${origin}/`, agentSecret: secret,
        fetchImpl: async (url) => {
          calls += 1;
          if (url.endsWith("/analysis-queue")) return response({
            candidates: [candidate], hasMore: false, nextCursor: null });
          if (url.endsWith("/analysis-claim")) return claimReply;
          if (url.includes("/analysis-claim?")) return response({ status: "not_found" });
          throw new Error("unexpected path");
        },
        fakeExecute: async () => { executed += 1; throw new Error("must not execute"); },
      });
      assert.deepEqual(result, { kind: claimReply.status === 409
        ? "disabled" : "claim_unknown" });
      assert.equal(calls, claimReply.status === 409 ? 2 : 3);
    }
    assert.equal(executed, 0);
  } finally {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
    if (previousOrigin === undefined) delete process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV];
    else process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV] = previousOrigin;
  }
});

test("lost claim reply reads a content-free receipt once, never invokes CLI or reclaims", async () => {
  const previousEnv = process.env.NODE_ENV;
  const previousOrigin = process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV];
  process.env.NODE_ENV = "test";
  process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV] = `${origin}/`;
  const visited = [];
  let claimRequestId;
  let executed = 0;
  try {
    const result = await runAmuxV4SyntheticAnalysisAgentOnce({
      origin: `${origin}/`, agentSecret: secret,
      fetchImpl: async (url, options) => {
        visited.push({ url, method: options.method });
        if (url.endsWith("/analysis-queue")) return response({
          candidates: [candidate], hasMore: false, nextCursor: null });
        if (url.endsWith("/analysis-claim")) {
          claimRequestId = JSON.parse(options.body).requestId;
          throw new Error("claim response lost after commit");
        }
        if (url.includes("/analysis-claim?")) {
          assert.equal(new URL(url).searchParams.get("requestId"), claimRequestId);
          return response({ status: "committed", requestId: claimRequestId,
            previewId, ideaId });
        }
        throw new Error("unexpected path");
      },
      fakeExecute: async () => { executed += 1; throw new Error("must not execute"); },
    });
    assert.deepEqual(result, { kind: "claim_committed_unexecuted" });
    assert.deepEqual(visited.map(({ method }) => method), ["POST", "POST", "GET"]);
    assert.equal(executed, 0);
  } finally {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
    if (previousOrigin === undefined) delete process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV];
    else process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV] = previousOrigin;
  }
});

test("absent, partial or mismatched claim read-back never permits a second claim", async () => {
  const previousEnv = process.env.NODE_ENV;
  const previousOrigin = process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV];
  process.env.NODE_ENV = "test";
  process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV] = `${origin}/`;
  try {
    for (const receipt of [
      { status: "absent" }, { status: "partial" },
      { status: "committed", ideaId: "wrong_idea" },
    ]) {
      let calls = 0;
      let claimRequestId;
      const result = await runAmuxV4SyntheticAnalysisAgentOnce({
        origin: `${origin}/`, agentSecret: secret,
        fetchImpl: async (url, options) => {
          calls += 1;
          if (url.endsWith("/analysis-queue")) return response({
            candidates: [candidate], hasMore: false, nextCursor: null });
          if (url.endsWith("/analysis-claim")) {
            claimRequestId = JSON.parse(options.body).requestId;
            throw new Error("response lost");
          }
          if (url.includes("/analysis-claim?")) return response({
            requestId: claimRequestId, previewId,
            ...(receipt.status === "committed" ? { ideaId } : {}),
            ...receipt,
          });
          throw new Error("unexpected path");
        }, fakeExecute: async () => { throw new Error("must not execute"); },
      });
      assert.deepEqual(result, { kind: "claim_unknown" });
      assert.equal(calls, 3);
    }
  } finally {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
    if (previousOrigin === undefined) delete process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV];
    else process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV] = previousOrigin;
  }
});
