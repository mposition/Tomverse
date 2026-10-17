import assert from "node:assert/strict";
import test from "node:test";

import { AMUX_V19_TRACKED_CHECKOUT_CLI_ENV,
  amuxV19StopRequested, runAmuxV19TrackedCheckoutAnalysis } from
  "../lib/amux/ideaTrackedCheckoutHostRunner.mjs";

const valid = () => ({ modelId: "claude-opus-5-5", reasoningEffort: "high",
  prompt: Buffer.from("synthetic prompt"), repositoryPath: "/missing/repository",
  commitSha: "a".repeat(40), digestSecret: "x".repeat(32),
  stopCheck: async () => true });

test("stop polling fails closed on refusal, transport failure and timeout", async () => {
  assert.equal(await amuxV19StopRequested(async () => false), false);
  assert.equal(await amuxV19StopRequested(async () => true), true);
  assert.equal(await amuxV19StopRequested(async () => { throw new Error("read failed"); }), true);
  let seenSignal;
  assert.equal(await amuxV19StopRequested((signal) => {
    seenSignal = signal;
    return new Promise(() => {});
  }, undefined, 10), true);
  assert.equal(seenSignal.aborted, true);
  const parent = new AbortController();
  let calls = 0;
  const pending = amuxV19StopRequested(() => {
    calls += 1;
    return new Promise(() => {});
  }, parent.signal, 1_000);
  parent.abort();
  assert.equal(await pending, true);
  assert.equal(calls, 0);
});

test("tracked checkout supervisor defaults closed", async () => {
  const prior = process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV];
  try {
    delete process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV];
    assert.deepEqual(await runAmuxV19TrackedCheckoutAnalysis(valid()),
      { kind: "refused" });
  } finally {
    if (prior === undefined) delete process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV];
    else process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV] = prior;
  }
});

test("tracked checkout supervisor refuses an unapproved model and effort", async () => {
  const prior = process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV];
  try {
    process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV] = "enabled";
    for (const change of [
      { modelId: "claude-unreviewed" }, { reasoningEffort: "low" },
      { prompt: Buffer.alloc(0) }, { stopCheck: null },
      { repositoryPath: "relative/repository" }, { commitSha: "latest" },
      { digestSecret: "short" },
    ]) {
      assert.deepEqual(await runAmuxV19TrackedCheckoutAnalysis({ ...valid(),
        ...change }), { kind: "refused" });
    }
  } finally {
    if (prior === undefined) delete process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV];
    else process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV] = prior;
  }
});

test("missing pinned repository has an unknown outcome before CLI start", {
  skip: process.platform !== "linux",
}, async () => {
  const prior = process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV];
  try {
    process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV] = "enabled";
    assert.deepEqual(await runAmuxV19TrackedCheckoutAnalysis({ ...valid(),
      stopCheck: async () => false }),
    { kind: "outcome_unknown", cliStarted: false });
  } finally {
    if (prior === undefined) delete process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV];
    else process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV] = prior;
  }
});

test("operator stop is checked before any checkout or CLI access", {
  skip: process.platform !== "linux",
}, async () => {
  const prior = process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV];
  try {
    process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV] = "enabled";
    let checks = 0;
    assert.deepEqual(await runAmuxV19TrackedCheckoutAnalysis({ ...valid(),
      stopCheck: async () => { checks += 1; return true; } }),
    { kind: "outcome_unknown", cliStarted: false });
    assert.equal(checks, 1);
  } finally {
    if (prior === undefined) delete process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV];
    else process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV] = prior;
  }
});
