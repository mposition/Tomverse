import assert from "node:assert/strict";
import { chmod, mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { claimAmuxV19MaxShadowBudgetWithHaltOnce } from
  "../lib/amux/ideaLocalMaxClaimWithHalt.mjs";
import { localAmuxSessionClaimMarker } from
  "../lib/amux/ideaLocalSessionClaimMarker.mjs";

const origin = "https://synthetic-amux.example.test/";
const secret = "syntheticMaxLauncherSecret_0123456789abcdefgh";
const identity = { claimId: "9942fb52-4b78-4af6-931a-9eec8f66d394",
  requestId: "44c72436-c011-4cfc-b52f-e3345c22fc80",
  reservationId: "bf72ad14-585c-41bd-b25e-aab4c17a6d3c",
  ideaId: "53d6918e-b05d-4531-a1ab-704dd756cc40",
  invocationOrdinal: 0, priceVersionId: "approved-price",
  modelId: "claude-opus-5-5", reasoningEffort: "high" };

async function withState(fn) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "amux-max-claim-"));
  await chmod(stateDirectory, 0o700);
  const names = ["TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN",
    "TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET",
    "TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI"];
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env[names[0]] = origin;
    process.env[names[1]] = secret;
    process.env[names[2]] = "enabled";
    await fn(stateDirectory);
  } finally {
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
    await rmdir(stateDirectory);
  }
}

const named = { claimId: identity.claimId, requestId: identity.requestId,
  reservationId: identity.reservationId, ideaId: identity.ideaId,
  invocationOrdinal: identity.invocationOrdinal };

/** An in-memory marker with the real file's claim/read/release contract. */
function fakeMarker({ releaseFails = false, pending = null } = {}) {
  const state = { held: pending, claims: 0, releases: 0 };
  return { state, markerFor: (stateDirectory) => {
    assert.equal(stateDirectory, "/state");
    return {
      async claim(claim) {
        state.claims++;
        if (state.held) return false;
        state.held = { identity: claim };
        return true;
      },
      async read() { return state.held; },
      async release() {
        state.releases++;
        if (releaseFails) throw new Error("local_state_unavailable");
        state.held = null;
      },
    };
  } };
}

test("an app refusal confirmed absent clears the marker; claims and unknowns keep it", async () => {
  for (const [answer, kept] of [
    [{ kind: "not_ready", retryWrite: false }, false],
    [{ kind: "budget_unavailable", retryWrite: false }, false],
    [{ kind: "integrity_unavailable", retryWrite: false }, false],
    [{ kind: "claim_disabled", retryWrite: false }, false],
    [{ kind: "refused" }, false],
    [{ kind: "auth_unavailable" }, false],
    [{ kind: "outcome_unknown", receiptStatus: "absent", retryWrite: false }, true],
    [{ kind: "claimed", recovered: true, retryWrite: false }, true],
    [{ kind: "made_up" }, true],
  ]) {
    const marker = fakeMarker();
    const result = await claimAmuxV19MaxShadowBudgetWithHaltOnce(
      { stateDirectory: "/state", identity }, async () => answer, marker.markerFor);
    assert.deepEqual(result, answer);
    assert.equal(marker.state.held !== null, kept, answer.kind);
    if (kept) assert.equal(marker.state.held.identity, identity);
  }
});

// Operator, 2026-11-16: a marker an earlier tick left is reconciled, not a stop.
test("a pending marker returns the claim it names before any write, and a failed release is reported", async () => {
  for (const pending of [{ identity: named }, { identity: null }]) {
    const marker = fakeMarker({ pending });
    let claims = 0;
    assert.deepEqual(await claimAmuxV19MaxShadowBudgetWithHaltOnce(
      { stateDirectory: "/state", identity },
      async () => { claims++; return { kind: "not_ready" }; },
      marker.markerFor), { kind: "recover", identity: pending.identity });
    assert.equal(claims, 0);
    assert.equal(marker.state.claims, 0);
  }
  const stuck = fakeMarker({ releaseFails: true });
  assert.deepEqual(await claimAmuxV19MaxShadowBudgetWithHaltOnce(
    { stateDirectory: "/state", identity }, async () => ({ kind: "not_ready",
      retryWrite: false }), stuck.markerFor),
  { kind: "halt_unavailable" });
  assert.notEqual(stuck.state.held, null);
  const thrown = fakeMarker();
  assert.deepEqual(await claimAmuxV19MaxShadowBudgetWithHaltOnce(
    { stateDirectory: "/state", identity }, async () => { throw new Error("lost"); },
    thrown.markerFor), { kind: "outcome_unknown", retryWrite: false,
    reason: "claim_threw" });
  assert.notEqual(thrown.state.held, null);
});

test("pre-write refusal clears its marker and performs no network call",
  { skip: process.platform !== "linux" }, async () => withState(async (stateDirectory) => {
    let calls = 0;
    const result = await claimAmuxV19MaxShadowBudgetWithHaltOnce({
      stateDirectory, origin: "http://wrong.example.test/", identity,
      fetchImpl: async () => { calls++; throw new Error("unexpected"); },
    });
    assert.deepEqual(result, { kind: "refused" });
    assert.equal(calls, 0);
    assert.equal(await localAmuxSessionClaimMarker(stateDirectory).read(), null);
  }));

test("committed claim holds a durable marker naming it and is reconciled before a second write",
  { skip: process.env.AMUX_V19_RUNNER_AUTH_METADATA_TEST !== "1" },
  async () => withState(async (stateDirectory) => {
    let writes = 0;
    const input = { stateDirectory, origin, identity,
      fetchImpl: async (_url, options) => {
        assert.equal(options.method, "POST");
        writes++;
        return Response.json({ claimId: identity.claimId,
          requestId: identity.requestId,
          reservationId: identity.reservationId, invocationOrdinal: 0,
          reservedMicroUsd: "0", auditId: "synthetic-audit" });
      } };
    try {
      const first = await claimAmuxV19MaxShadowBudgetWithHaltOnce(input);
      assert.equal(first.kind, "claimed");
      assert.equal(first.recovered, false);
      // The marker's time comes with it (the cycle's absent-claim window).
      const recover = await claimAmuxV19MaxShadowBudgetWithHaltOnce(input);
      assert.deepEqual({ kind: recover.kind, identity: recover.identity },
        { kind: "recover", identity: named });
      assert.ok(Number.isFinite(recover.writtenAtMs));
      assert.equal(writes, 1);
    } finally {
      await localAmuxSessionClaimMarker(stateDirectory).release();
    }
  }));

test("unknown claim response retains marker even when readback says absent",
  { skip: process.env.AMUX_V19_RUNNER_AUTH_METADATA_TEST !== "1" },
  async () => withState(async (stateDirectory) => {
    let writes = 0;
    try {
      const result = await claimAmuxV19MaxShadowBudgetWithHaltOnce({
        stateDirectory, origin, identity,
        fetchImpl: async (_url, options) => {
          if (options.method === "POST") {
            writes++;
            throw new Error("synthetic response loss");
          }
          return Response.json({ status: "absent" });
        },
      });
      assert.equal(result.kind, "outcome_unknown");
      assert.equal(writes, 1);
      const pending = await localAmuxSessionClaimMarker(stateDirectory).read();
      assert.deepEqual(pending.identity, named);
      assert.ok(Number.isFinite(pending.writtenAtMs));
    } finally {
      await localAmuxSessionClaimMarker(stateDirectory).release();
    }
  }));
