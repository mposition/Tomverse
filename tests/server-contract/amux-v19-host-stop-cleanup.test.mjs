import assert from "node:assert/strict";
import { createServer } from "node:net";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

import { AmuxTrackedCheckoutManifestError } from
  "../../lib/amux/ideaTrackedCheckoutManifestCore.ts";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
let mode = "stop";
let spawnCount = 0;
let checkoutSignal;

mock.module("node:child_process", { namedExports: {
  spawn() {
    spawnCount += 1;
    // Impossible OS PID and an already-exited child keep host kill paths inert.
    return { pid: Number.MAX_SAFE_INTEGER, exitCode: 0, signalCode: null,
      once() { return this; } };
  },
} });
mock.module(mod("lib/amux/ideaLocalApprovedCliCatalog.mjs"), {
  namedExports: { amuxV4ApprovedAnalysisCliForModel: () => ({
    provider: "anthropic", modelId: "claude-opus-5-5",
    reasoningEffort: "high", egressHosts: ["api.anthropic.com"],
  }) },
});
mock.module(mod("lib/amux/ideaLocalEgressProxy.ts"), {
  namedExports: { createAmuxV19EgressProxy: () => createServer() },
});
mock.module(mod("lib/amux/ideaLocalIsolatedCliRunner.mjs"), {
  namedExports: { stageAmuxV19ClaudeCli: async () => ({
    authPath: "/tmp/synthetic-auth",
  }) },
});
mock.module(mod("lib/amux/ideaTrackedCheckoutMaterialize.ts"), {
  namedExports: { withAmuxTrackedCheckout: async (input, run) => {
    checkoutSignal = input.signal;
    if (mode === "stop") {
      if (!checkoutSignal.aborted) await new Promise((resolveAbort) =>
        checkoutSignal.addEventListener("abort", resolveAbort, { once: true }));
      throw new AmuxTrackedCheckoutManifestError();
    }
    const result = await run({ directory: "/tmp/amux-v19-checkout-abcdef",
      files: [], excludedCount: 0, excludedPathDigest: "a".repeat(64),
      excludedReasons: { secret_path: 0, secret_content: 0,
        non_regular: 0, unscannable_content: 0 } });
    if (mode === "cleanup") throw new Error("synthetic checkout cleanup failure");
    return result;
  } },
});
mock.module(mod("lib/amux/ideaTrackedCheckoutProcessResult.mjs"), {
  namedExports: { awaitAmuxTrackedCheckoutChild: async () => ({
    kind: "verified_success", rawModelOutput: "{}", readFiles: [],
    inputTokens: 1, outputTokens: 1,
  }) },
});
mock.module(mod("lib/amux/ideaTrackedCheckoutSandbox.mjs"), {
  namedExports: { verifiedAmuxTrackedCheckoutSandbox: async () => [] },
});

const { AMUX_V19_TRACKED_CHECKOUT_CLI_ENV, AmuxTrackedCheckoutHostError,
  runAmuxV19TrackedCheckoutAnalysis } = await import(
  mod("lib/amux/ideaTrackedCheckoutHostRunner.mjs"));
const input = (stopCheck) => ({
  modelId: "claude-opus-5-5", reasoningEffort: "high",
  prompt: Buffer.from("synthetic prompt"), repositoryPath: "/tmp/synthetic-repo",
  commitSha: "a".repeat(40), digestSecret: "s".repeat(32), stopCheck,
});
const withSwitch = async (run) => {
  const before = process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV];
  try {
    process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV] = "enabled";
    return await run();
  } finally {
    if (before === undefined) delete process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV];
    else process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV] = before;
  }
};

test("operator stop aborts checkout materialization before any CLI spawn", {
  skip: process.platform !== "linux", timeout: 5_000,
}, async () => withSwitch(async () => {
  mode = "stop";
  spawnCount = 0;
  let checks = 0;
  assert.deepEqual(await runAmuxV19TrackedCheckoutAnalysis(input(
    async () => ++checks >= 2)),
  { kind: "outcome_unknown", cliStarted: false });
  assert.ok(checks >= 2);
  assert.equal(checkoutSignal.aborted, true);
  assert.equal(spawnCount, 0);
}));

test("cleanup failure after child spawn preserves the provider-use signal", {
  skip: process.platform !== "linux", timeout: 5_000,
}, async () => withSwitch(async () => {
  mode = "cleanup";
  spawnCount = 0;
  await assert.rejects(runAmuxV19TrackedCheckoutAnalysis(input(
    async () => false)), (error) => {
    assert.ok(error instanceof AmuxTrackedCheckoutHostError);
    assert.equal(error.cliStarted, true);
    assert.match(error.cause.message, /synthetic checkout cleanup failure/);
    return true;
  });
  assert.equal(spawnCount, 1);
}));
