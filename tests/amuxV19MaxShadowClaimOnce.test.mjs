import assert from "node:assert/strict";
import test from "node:test";

import { claimAmuxV19MaxShadowBudgetOnce } from
  "../lib/amux/ideaLocalMaxShadowClaimOnce.mjs";
import { verifyAmuxV19MaxClaimAttestation } from
  "../lib/amux/ideaSessionMaxLauncherAttestation.mjs";
import { installAmuxV19FakeAppTiming } from "./support/amuxV19FakeAppTiming.mjs";

installAmuxV19FakeAppTiming();

const origin = "https://synthetic-amux.example.test/";
const secret = "syntheticMaxLauncherSecret_0123456789abcdefgh";
const identity = {
  claimId: "9942fb52-4b78-4af6-931a-9eec8f66d394",
  requestId: "44c72436-c011-4cfc-b52f-e3345c22fc80",
  reservationId: "bf72ad14-585c-41bd-b25e-aab4c17a6d3c",
  ideaId: "53d6918e-b05d-4531-a1ab-704dd756cc40",
  invocationOrdinal: 0, priceVersionId: "approved-price",
  modelId: "claude-opus-5-5", reasoningEffort: "high",
};

async function withLauncherEnv(check) {
  const names = ["TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN",
    "TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET",
    "TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI"];
  const previous = Object.fromEntries(names.map((name) =>
    [name, process.env[name]]));
  try {
    process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN = origin;
    process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET = secret;
    process.env.TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI = "enabled";
    await check();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test("unconfigured origin cannot cause a claim write", async () => {
  let calls = 0;
  const old = process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN;
  try {
    delete process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN;
    assert.deepEqual(await claimAmuxV19MaxShadowBudgetOnce({ origin, identity,
      fetchImpl: async () => { calls++; throw new Error("unexpected fetch"); },
    }), { kind: "refused" });
    assert.equal(calls, 0);
  } finally {
    if (old === undefined)
      delete process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN;
    else process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN = old;
  }
});

test("Ubuntu launcher verifies OAuth metadata and signs one exact claim", {
  skip: process.env.AMUX_V19_RUNNER_AUTH_METADATA_TEST !== "1",
}, async () => withLauncherEnv(async () => {
  let postCount = 0;
  const result = await claimAmuxV19MaxShadowBudgetOnce({ origin, identity,
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, "POST");
      assert.equal(options.headers["x-amux-agent-id"], "amux-intake-max");
      const body = JSON.parse(options.body);
      assert.match(verifyAmuxV19MaxClaimAttestation(secret, body,
        body.authVerifiedAt, body.authProof), /^[a-f0-9]{64}$/);
      postCount++;
      return Response.json({ claimId: identity.claimId,
        requestId: identity.requestId, reservationId: identity.reservationId,
        invocationOrdinal: 0, reservedMicroUsd: "1000000",
        auditId: "synthetic-audit" });
    },
  });
  assert.equal(postCount, 1);
  assert.deepEqual(result, { kind: "claimed", claimId: identity.claimId,
    reservationId: identity.reservationId, requestId: identity.requestId,
    reservedMicroUsd: "1000000", recovered: false, retryWrite: false });
}));

test("lost POST response reads exact receipt once and never replays write", {
  skip: process.env.AMUX_V19_RUNNER_AUTH_METADATA_TEST !== "1",
}, async () => withLauncherEnv(async () => {
  let writes = 0;
  let reads = 0;
  const result = await claimAmuxV19MaxShadowBudgetOnce({ origin, identity,
    fetchImpl: async (_url, options) => {
      if (options.method === "POST") {
        writes++;
        throw new Error("synthetic lost response");
      }
      reads++;
      assert.equal(options.method, "GET");
      assert.equal(options.headers["x-amux-agent-id"], "amux-intake-max");
      return Response.json({ status: "committed", claimId: identity.claimId,
        claimStatus: "in_flight" });
    },
  });
  assert.equal(writes, 1);
  assert.equal(reads, 1);
  assert.deepEqual(result, { kind: "claimed", claimId: identity.claimId,
    reservationId: identity.reservationId, requestId: identity.requestId,
    reservedMicroUsd: null, recovered: true, retryWrite: false });
}));

test("absent readback after lost POST remains outcome unknown", {
  skip: process.env.AMUX_V19_RUNNER_AUTH_METADATA_TEST !== "1",
}, async () => withLauncherEnv(async () => {
  let writes = 0;
  let reads = 0;
  const result = await claimAmuxV19MaxShadowBudgetOnce({ origin, identity,
    fetchImpl: async (_url, options) => {
      if (options.method === "POST") {
        writes++;
        throw new Error("synthetic lost response");
      }
      reads++;
      return Response.json({ status: "absent" });
    },
  });
  assert.deepEqual(result, { kind: "outcome_unknown",
    receiptStatus: "absent", retryWrite: false });
  assert.equal(writes, 1);
  assert.equal(reads, 1);
}));

// The 409 path runs on any platform: the Ubuntu sign-in preflight is replaced
// by a fixed ready answer, and only the POST and its one readback are faked.
const prepareReady = async (input) => ({ kind: "ready",
  identity: { ...input, provider: "anthropic" },
  authVerifiedAt: "2026-10-20T00:00:00.000Z", authProof: "a".repeat(64),
  authProfile: "claude-max-oauth" });

async function claimWith({ post, receipt }) {
  const calls = { writes: 0, reads: 0 };
  const result = await claimAmuxV19MaxShadowBudgetOnce({ origin, identity,
    fetchImpl: async (_url, options) => {
      if (options.method === "POST") {
        calls.writes++;
        return post();
      }
      calls.reads++;
      assert.equal(options.method, "GET");
      return receipt();
    },
  }, prepareReady);
  return { result, ...calls };
}

const refusal = (body) => () => Response.json(body, { status: 409 });
const absent = () => Response.json({ status: "absent" });

test("a 409 pre-write refusal confirmed absent is that refusal, not an unknown outcome",
  () => withLauncherEnv(async () => {
    for (const [body, expected] of [
      [{ error: "budget_hold", reason: "monthly_shadow_reached" },
        { kind: "budget_hold", reason: "monthly_shadow_reached" }],
      [{ error: "not_ready" }, { kind: "not_ready" }],
      [{ error: "budget_unavailable" }, { kind: "budget_unavailable" }],
      [{ error: "integrity_unavailable" }, { kind: "integrity_unavailable" }],
      [{ available: false, reason: "session_budget_claim_disabled" },
        { kind: "claim_disabled" }],
    ]) {
      const { result, writes, reads } = await claimWith({
        post: refusal(body), receipt: absent });
      assert.deepEqual(result, { ...expected, retryWrite: false },
        JSON.stringify(body));
      assert.equal(writes, 1);
      assert.equal(reads, 1, "the refusal is still checked by exact readback");
    }
  }));

test("a 409 refusal whose readback finds the claim in flight is the recovered claim",
  () => withLauncherEnv(async () => {
    const { result, writes, reads } = await claimWith({
      post: refusal({ error: "budget_hold", reason: "monthly_shadow_reached" }),
      receipt: () => Response.json({ status: "committed",
        claimId: identity.claimId, claimStatus: "in_flight" }) });
    assert.deepEqual(result, { kind: "claimed", claimId: identity.claimId,
      reservationId: identity.reservationId, requestId: identity.requestId,
      reservedMicroUsd: null, recovered: true, retryWrite: false });
    assert.equal(writes, 1);
    assert.equal(reads, 1);
  }));

test("a 409 refusal without a clean absent readback stays outcome unknown",
  () => withLauncherEnv(async () => {
    const hold = refusal({ error: "budget_hold", reason: "monthly_shadow_reached" });
    // A readback that never reaches the app is asked again with backoff, and
    // the write is still never repeated.
    for (const [receipt, receiptStatus, reason, retried] of [
      [() => Response.json({ status: "partial" }), "partial",
        "write_unconfirmed", false],
      [() => Response.json({ error: "outcome_unknown" }, { status: 503 }), null,
        "readback_unreachable", true],
      [() => { throw new Error("synthetic readback loss"); }, null,
        "readback_unreachable", true],
      [() => Response.json({ status: "committed", claimId: identity.claimId,
        claimStatus: "outcome_unknown" }), null, "write_unconfirmed", false],
    ]) {
      const { result, writes, reads } = await claimWith({ post: hold, receipt });
      assert.deepEqual(result, { kind: "outcome_unknown", receiptStatus,
        retryWrite: false, reason });
      assert.equal(writes, 1);
      if (retried) assert.ok(reads > 1, reason);
      else assert.equal(reads, 1);
    }
  }));

test("only the route's exact 409 bodies count as refusals; a lost or 5xx answer stays unknown",
  () => withLauncherEnv(async () => {
    const answered = "write_unconfirmed";
    for (const [post, reason] of [
      [refusal({ error: "outcome_unknown" }), answered],
      [refusal({ error: "budget_hold", reason: "Bearer x-1" }), answered],
      [refusal({ error: "budget_hold", reason: "monthly_shadow_reached",
        extra: 1 }), answered],
      [refusal({ error: "not_ready", reason: 7 }), answered],
      [refusal({ available: false,
        reason: "session_budget_claim_read_disabled" }), answered],
      [refusal(["not_ready"]), answered],
      [() => new Response("not_ready", { status: 409,
        headers: { "content-type": "text/plain" } }), answered],
      // A gateway answer to a write is not resent; only read back.
      [() => Response.json({ error: "outcome_unknown" }, { status: 503 }),
        answered],
      // An answer lost after sending is never resent.
      [() => { throw new Error("synthetic lost response"); },
        "network_sent_unconfirmed"],
    ]) {
      const { result, writes, reads } = await claimWith({ post, receipt: absent });
      assert.deepEqual(result, { kind: "outcome_unknown",
        receiptStatus: "absent", retryWrite: false, reason });
      assert.equal(writes, 1);
      assert.equal(reads, 1);
    }
  }));

test("a claim POST that never left the host is sent again with the same bytes",
  () => withLauncherEnv(async () => {
    const bodies = [];
    let reads = 0;
    const result = await claimAmuxV19MaxShadowBudgetOnce({ origin, identity,
      fetchImpl: async (_url, options) => {
        if (options.method !== "POST") { reads++; return absent(); }
        bodies.push(options.body);
        if (bodies.length < 3) {
          throw Object.assign(new TypeError("fetch failed"),
            { cause: Object.assign(new Error("getaddrinfo EAI_AGAIN"),
              { code: "EAI_AGAIN" }) });
        }
        return Response.json({ claimId: identity.claimId,
          requestId: identity.requestId, reservationId: identity.reservationId,
          invocationOrdinal: 0, reservedMicroUsd: "1000000",
          auditId: "synthetic-audit" });
      },
    }, prepareReady);
    assert.deepEqual(result, { kind: "claimed", claimId: identity.claimId,
      reservationId: identity.reservationId, requestId: identity.requestId,
      reservedMicroUsd: "1000000", recovered: false, retryWrite: false });
    assert.equal(bodies.length, 3);
    assert.equal(new Set(bodies).size, 1, "every attempt sends the same bytes");
    assert.equal(reads, 0);
  }));

test("a claim POST that never left within the budget reads back and names why",
  () => withLauncherEnv(async () => {
    let writes = 0;
    let reads = 0;
    const result = await claimAmuxV19MaxShadowBudgetOnce({ origin, identity,
      fetchImpl: async (_url, options) => {
        if (options.method !== "POST") { reads++; return absent(); }
        writes++;
        throw Object.assign(new TypeError("fetch failed"),
          { cause: Object.assign(new Error("connect ECONNREFUSED"),
            { code: "ECONNREFUSED" }) });
      },
    }, prepareReady);
    assert.deepEqual(result, { kind: "outcome_unknown",
      receiptStatus: "absent", retryWrite: false,
      reason: "network_unsent_retry_exhausted" });
    assert.ok(writes > 1);
    assert.equal(reads, 1);
  }));
