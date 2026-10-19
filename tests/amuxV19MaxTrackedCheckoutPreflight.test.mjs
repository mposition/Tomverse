import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareAmuxV19MaxTrackedCheckout,
  prepareAmuxV19MaxTrackedCheckouts } from
  "../lib/amux/ideaLocalMaxTrackedCheckoutPreflight.mjs";
import { runAmuxV19MaxClaimedTrackedCheckoutOnce } from
  "../lib/amux/ideaLocalMaxClaimedTrackedCheckoutOnce.mjs";

const origin = "https://amux.example.test/";
const secret = "syntheticMaxLauncherSecret_0123456789abcdefgh";
const identity = { claimId: "9942fb52-4b78-4af6-931a-9eec8f66d394",
  requestId: "44c72436-c011-4cfc-b52f-e3345c22fc80",
  reservationId: "bf72ad14-585c-41bd-b25e-aab4c17a6d3c",
  ideaId: "53d6918e-b05d-4531-a1ab-704dd756cc40",
  invocationOrdinal: 0 };
const claim = { kind: "claimed", recovered: false,
  claimId: identity.claimId, requestId: identity.requestId,
  reservationId: identity.reservationId };
const pin = "a".repeat(40);

async function withEnvironment(fn) {
  const root = await mkdtemp(join(tmpdir(), "amux-max-preflight-"));
  const names = ["TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN",
    "TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET",
    "TOMVERSE_AMUX_V19_TRACKED_REPOSITORY_ROOT"];
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const checkout = join(root, "mposition", "tomverse");
  await mkdir(checkout, { recursive: true });
  execFileSync("git", ["init", "--quiet", checkout]);
  execFileSync("git", ["-C", checkout, "remote", "add", "origin",
    "https://github.com/mposition/Tomverse.git"]);
  if (process.platform === "linux") {
    for (const path of [root, join(root, "mposition"), checkout,
      join(checkout, ".git")]) await chmod(path, 0o755);
    await chmod(join(checkout, ".git", "config"), 0o644);
  }
  try {
    process.env[names[0]] = origin;
    process.env[names[1]] = secret;
    process.env[names[2]] = root;
    await fn(checkout);
  } finally {
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
    await rm(root, { recursive: true, force: true });
  }
}

function fetchFor({ stop = false, badPin = false, calls }) {
  return async (url, options) => {
    const path = new URL(url).pathname;
    calls.push(`${options.method} ${path}`);
    assert.equal(options.headers["x-amux-agent-id"], "amux-intake-max");
    assert.equal(options.headers.authorization, `Bearer ${secret}`);
    if (path.endsWith("/analysis-budget/claim")) {
      return Response.json({ status: "committed",
        claimId: identity.claimId, claimStatus: "in_flight" });
    }
    if (path.endsWith("/session-analysis-stop")) {
      return Response.json({ claimId: identity.claimId,
        reservationId: identity.reservationId, stop });
    }
    assert.equal(path, "/api/internal/amux/v19/checkout-reference");
    assert.deepEqual(JSON.parse(options.body), {
      claimId: identity.claimId, reservationId: identity.reservationId,
      ideaId: identity.ideaId, referenceOrdinal: 0 });
    return Response.json({ referenceCount: 1, kind: "repository",
      repository: "mposition/Tomverse", pullRequestNumber: null,
      pinnedCommitSha: badPin ? "invalid" : pin });
  };
}

test("exact Max claim, stop and repository pin prepare one local checkout", async () =>
  withEnvironment(async (expectedPath) => {
    const calls = [];
    const result = await prepareAmuxV19MaxTrackedCheckout({ origin,
      identity, claim, referenceOrdinal: 0,
      fetchImpl: fetchFor({ calls }) });
    assert.equal(result.kind, "ready");
    assert.equal(result.repositoryPath, expectedPath);
    assert.equal(result.commitSha, pin);
    assert.equal(result.referenceCount, 1);
    assert.equal(await result.stopCheck(), false);
    assert.deepEqual(calls.map((entry) => entry.split(" ")[1]), [
      "/api/internal/amux/v19/analysis-budget/claim",
      "/api/internal/amux/v19/session-analysis-stop",
      "/api/internal/amux/v19/checkout-reference",
      "/api/internal/amux/v19/session-analysis-stop",
      "/api/internal/amux/v19/session-analysis-stop",
    ]);
  }));

test("recovered claim and mismatched identity refuse without a network call", async () =>
  withEnvironment(async () => {
    let calls = 0;
    for (const rejected of [{ ...claim, recovered: true },
      { ...claim, claimId: identity.ideaId }]) {
      assert.deepEqual(await prepareAmuxV19MaxTrackedCheckout({ origin,
        identity, claim: rejected, referenceOrdinal: 0,
        fetchImpl: async () => { calls++; throw new Error("unexpected"); } }),
      { kind: "refused" });
    }
    assert.equal(calls, 0);
  }));

test("stop request and invalid pin fail closed before local checkout", async () =>
  withEnvironment(async () => {
    for (const options of [{ stop: true }, { badPin: true }]) {
      const calls = [];
      assert.deepEqual(await prepareAmuxV19MaxTrackedCheckout({ origin,
        identity, claim, referenceOrdinal: 0,
        fetchImpl: fetchFor({ ...options, calls }) }),
      { kind: "unavailable" });
      if (options.stop) assert.equal(calls.length, 2);
      else assert.equal(calls.length, 3);
    }
  }));

test("settled claim cannot resolve a checkout even with a matching ID", async () =>
  withEnvironment(async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push(new URL(url).pathname);
      assert.equal(options.method, "GET");
      return Response.json({ status: "committed",
        claimId: identity.claimId, claimStatus: "succeeded" });
    };
    assert.deepEqual(await prepareAmuxV19MaxTrackedCheckout({ origin,
      identity, claim, referenceOrdinal: 0, fetchImpl }),
    { kind: "unavailable" });
    assert.deepEqual(calls,
      ["/api/internal/amux/v19/analysis-budget/claim"]);
  }));

test("one fresh Max claim resolves every pinned reference before dispatch", async () =>
  withEnvironment(async (expectedPath) => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      const path = new URL(url).pathname;
      calls.push(path);
      assert.equal(options.headers["x-amux-agent-id"], "amux-intake-max");
      if (path.endsWith("/analysis-budget/claim")) return Response.json({
        status: "committed", claimId: identity.claimId,
        claimStatus: "in_flight" });
      if (path.endsWith("/session-analysis-stop")) return Response.json({
        claimId: identity.claimId, reservationId: identity.reservationId,
        stop: false });
      const ordinal = JSON.parse(options.body).referenceOrdinal;
      assert.ok(ordinal === 0 || ordinal === 1);
      return Response.json({ referenceCount: 2, kind: "repository",
        repository: "mposition/Tomverse", pullRequestNumber: null,
        pinnedCommitSha: ordinal === 0 ? pin : "b".repeat(40) });
    };
    const result = await prepareAmuxV19MaxTrackedCheckouts({ origin,
      identity, claim, fetchImpl });
    assert.equal(result.kind, "ready");
    assert.deepEqual(result.references, [
      { referenceOrdinal: 0, repositoryPath: expectedPath, commitSha: pin },
      { referenceOrdinal: 1, repositoryPath: expectedPath,
        commitSha: "b".repeat(40) },
    ]);
    assert.equal(typeof result.stopCheck, "function");
    assert.equal(calls.filter((path) => path.endsWith("/checkout-reference"))
      .length, 2);
  }));

test("changed reference count and stop mid-list refuse the whole set", async () =>
  withEnvironment(async () => {
    for (const failure of ["count", "stop"]) {
      let stopReads = 0;
      let references = 0;
      const result = await prepareAmuxV19MaxTrackedCheckouts({ origin,
        identity, claim,
        fetchImpl: async (url) => {
          const path = new URL(url).pathname;
          if (path.endsWith("/analysis-budget/claim")) return Response.json({
            status: "committed", claimId: identity.claimId,
            claimStatus: "in_flight" });
          if (path.endsWith("/session-analysis-stop")) return Response.json({
            claimId: identity.claimId, reservationId: identity.reservationId,
            stop: failure === "stop" && ++stopReads >= 3 });
          references += 1;
          return Response.json({ referenceCount: failure === "count" &&
            references === 2 ? 3 : 2, kind: "repository",
          repository: "mposition/Tomverse", pullRequestNumber: null,
          pinnedCommitSha: pin });
        },
      });
      assert.deepEqual(result, { kind: "unavailable" });
      assert.equal(references, failure === "stop" ? 1 : 2);
    }
  }));

test("v19 Max preflight does not inherit the v4 24-reference ceiling", async () =>
  withEnvironment(async () => {
    let references = 0;
    const result = await prepareAmuxV19MaxTrackedCheckouts({ origin,
      identity, claim, fetchImpl: async (url) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/analysis-budget/claim")) return Response.json({
          status: "committed", claimId: identity.claimId,
          claimStatus: "in_flight" });
        if (path.endsWith("/session-analysis-stop")) return Response.json({
          claimId: identity.claimId, reservationId: identity.reservationId,
          stop: false });
        references += 1;
        return Response.json({ referenceCount: 25, kind: "repository",
          repository: "mposition/Tomverse", pullRequestNumber: null,
          pinnedCommitSha: pin });
      } });
    assert.equal(result.kind, "ready");
    assert.equal(result.references.length, 25);
    assert.equal(references, 25);
  }));

test("claimed dispatch resolves every reference before the default-closed host", async () =>
  withEnvironment(async () => {
    const calls = [];
    const input = { origin, identity, claim, modelId: "claude-opus-5-5",
      reasoningEffort: "high", prompt: Buffer.from("synthetic"),
      digestSecret: "d".repeat(32),
      fetchImpl: async (url) => {
        const path = new URL(url).pathname;
        calls.push(path);
        if (path.endsWith("/analysis-budget/claim")) return Response.json({
          status: "committed", claimId: identity.claimId,
          claimStatus: "in_flight" });
        if (path.endsWith("/session-analysis-stop")) return Response.json({
          claimId: identity.claimId, reservationId: identity.reservationId,
          stop: false });
        const referenceOrdinal = calls.filter((item) =>
          item.endsWith("/checkout-reference")).length - 1;
        return Response.json({ referenceCount: 2, kind: "repository",
          repository: "mposition/Tomverse", pullRequestNumber: null,
          pinnedCommitSha: referenceOrdinal === 0 ? pin : "b".repeat(40) });
      },
    };
    const switchName = "TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI";
    const old = process.env[switchName];
    try {
      delete process.env[switchName];
      assert.deepEqual(await runAmuxV19MaxClaimedTrackedCheckoutOnce(input),
        { kind: "refused", cliStarted: false });
      assert.equal(calls.filter((path) =>
        path.endsWith("/checkout-reference")).length, 2);
      calls.length = 0;
      assert.deepEqual(await runAmuxV19MaxClaimedTrackedCheckoutOnce({
        ...input, claim: { ...claim, recovered: true },
      }), { kind: "refused", cliStarted: false });
      assert.equal(calls.length, 0);
    } finally {
      if (old === undefined) delete process.env[switchName];
      else process.env[switchName] = old;
    }
  }));
