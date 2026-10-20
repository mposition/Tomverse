import assert from "node:assert/strict";
import { chmod, mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { claimAmuxV19MaxShadowBudgetWithHaltOnce } from
  "../lib/amux/ideaLocalMaxClaimWithHalt.mjs";
import { localAmuxHaltFile } from
  "../lib/amux/ideaLocalRetentionHaltFile.mjs";

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

/** An in-memory marker with the real file's claim/release contract. */
function fakeHalt({ releaseFails = false } = {}) {
  const state = { held: false, claims: 0, releases: 0 };
  return { state, haltFile: (stateDirectory, kind) => {
    assert.equal(stateDirectory, "/state");
    assert.equal(kind, "analysis");
    return {
      async claim() { state.claims++; if (state.held) return false; state.held = true; return true; },
      async release() {
        state.releases++;
        if (releaseFails) throw new Error("local_state_unavailable");
        state.held = false;
      },
    };
  } };
}

test("an app refusal confirmed absent clears the marker; claims and unknowns keep it", async () => {
  for (const [answer, kept] of [
    [{ kind: "budget_hold", reason: "monthly_shadow_reached", retryWrite: false }, false],
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
    const halt = fakeHalt();
    const result = await claimAmuxV19MaxShadowBudgetWithHaltOnce(
      { stateDirectory: "/state" }, async () => answer, halt.haltFile);
    assert.deepEqual(result, answer);
    assert.equal(halt.state.held, kept, answer.kind);
  }
});

test("a held marker stops the claim before any write, and a failed release is reported", async () => {
  const halted = fakeHalt();
  halted.state.held = true;
  let claims = 0;
  assert.deepEqual(await claimAmuxV19MaxShadowBudgetWithHaltOnce(
    { stateDirectory: "/state" }, async () => { claims++; return { kind: "not_ready" }; },
    halted.haltFile), { kind: "halted" });
  assert.equal(claims, 0);
  const stuck = fakeHalt({ releaseFails: true });
  assert.deepEqual(await claimAmuxV19MaxShadowBudgetWithHaltOnce(
    { stateDirectory: "/state" }, async () => ({ kind: "budget_hold",
      reason: "monthly_shadow_reached", retryWrite: false }), stuck.haltFile),
  { kind: "halt_unavailable" });
  assert.equal(stuck.state.held, true);
  const thrown = fakeHalt();
  assert.deepEqual(await claimAmuxV19MaxShadowBudgetWithHaltOnce(
    { stateDirectory: "/state" }, async () => { throw new Error("lost"); },
    thrown.haltFile), { kind: "outcome_unknown", retryWrite: false });
  assert.equal(thrown.state.held, true);
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
    const halt = localAmuxHaltFile(stateDirectory, "analysis");
    assert.equal(await halt.claim(), true);
    await halt.release();
  }));

test("committed claim holds a durable marker and refuses a second write",
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
          reservedMicroUsd: "1000000", auditId: "synthetic-audit" });
      } };
    try {
      const first = await claimAmuxV19MaxShadowBudgetWithHaltOnce(input);
      assert.equal(first.kind, "claimed");
      assert.equal(first.recovered, false);
      assert.deepEqual(await claimAmuxV19MaxShadowBudgetWithHaltOnce(input),
        { kind: "halted" });
      assert.equal(writes, 1);
    } finally {
      await localAmuxHaltFile(stateDirectory, "analysis").release();
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
      assert.equal(await localAmuxHaltFile(stateDirectory,
        "analysis").claim(), false);
    } finally {
      await localAmuxHaltFile(stateDirectory, "analysis").release();
    }
  }));
