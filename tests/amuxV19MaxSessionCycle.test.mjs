import assert from "node:assert/strict";
import test from "node:test";

import { AMUX_V19_EXCLUDED_PATH_DIGEST_KEY_ID,
  AMUX_V19_MAX_SESSION_CYCLE_ENV, runAmuxV19MaxSessionCycleOnce } from
  "../lib/amux/ideaLocalMaxSessionCycle.mjs";
import { amuxV19MaxSessionCycleStatus } from
  "../scripts/amux-v19-max-session-cycle.mjs";
import { buildAmuxIdeaAnalysisPrompt } from
  "../lib/amux/ideaAnalysisPromptCore.ts";

const origin = "https://amux.example.test/";
const secret = "syntheticMaxLauncherSecret_0123456789abcdefgh";
const identity = Object.freeze({ claimId: "9942fb52-4b78-4af6-931a-9eec8f66d394",
  requestId: "44c72436-c011-4cfc-b52f-e3345c22fc80",
  reservationId: "bf72ad14-585c-41bd-b25e-aab4c17a6d3c",
  ideaId: "53d6918e-b05d-4531-a1ab-704dd756cc40",
  invocationOrdinal: 0, priceVersionId: "price-1", provider: "anthropic",
  modelId: "claude-opus-5-5", reasoningEffort: "high" });
const claim = { kind: "claimed", recovered: false, retryWrite: false,
  claimId: identity.claimId, requestId: identity.requestId,
  reservationId: identity.reservationId };
const pagePrompt = (previewId) => buildAmuxIdeaAnalysisPrompt({ previewId,
  chunkIndex: 0, revisionChunkIndex: 0, continuation: null,
  sourceTexts: [{ refId: "operator_idea", kind: "operator_idea",
    text: "Add a session plan writer." }], permittedTargetRefs: [] }).prompt;
const references = [{ referenceOrdinal: 0, commitSha: "a".repeat(40) },
  { referenceOrdinal: 1, commitSha: "b".repeat(40) }];

async function withSwitches(fn) {
  const names = [AMUX_V19_MAX_SESSION_CYCLE_ENV,
    "TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET"];
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env[AMUX_V19_MAX_SESSION_CYCLE_ENV] = "enabled";
  process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET = secret;
  try { return await fn(); }
  finally {
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
  }
}

function steps(overrides = {}) {
  const calls = [];
  let released = 0;
  const base = {
    claim: async () => { calls.push("claim");
      return { kind: "claimed", identity, claim, retryWrite: false }; },
    readIdea: async ({ selection }) => { calls.push("readIdea");
      assert.equal(selection.identity, identity);
      return { kind: "ready", prompt: pagePrompt(identity.claimId) }; },
    analyse: async (input) => { calls.push("analyse");
      const prompt = input.prompt(references.length);
      assert.ok(Buffer.isBuffer(prompt));
      const text = prompt.toString("utf8");
      assert.ok(text.includes(identity.claimId), "the claim is the preview id");
      assert.ok(text.includes("reference-0, reference-1"));
      assert.ok(text.includes("BEGIN_SHARED_CONTRACT_PATHS_JSON"));
      assert.ok(text.includes("Use the Read, Grep and Glob tools"));
      assert.equal(input.provider, identity.provider);
      assert.equal(input.modelId, identity.modelId);
      assert.match(input.digestSecret, /^[a-f0-9]{64}$/);
      return { kind: "verified_success", cliStarted: true,
        references: references.map((reference) => ({ ...reference })),
        preparedReferences: references, rawModelOutput: "{}",
        inputTokens: 10, outputTokens: 2, readFiles: [] }; },
    finalize: async (input, observed) => { calls.push("finalize");
      assert.deepEqual(input.references, references);
      assert.equal(input.excludedPathDigestKeyId,
        AMUX_V19_EXCLUDED_PATH_DIGEST_KEY_ID);
      assert.equal(observed.kind, "verified_success");
      assert.equal(input.provider, identity.provider);
      assert.deepEqual(Object.keys(input.identity).sort(), ["claimId",
        "ideaId", "invocationOrdinal", "requestId", "reservationId"]);
      return { kind: "recorded", recovered: false, retryWrite: false,
        planState: "plan_ready", registrationState: "write_disabled" }; },
    haltFile: () => ({ release: async () => { released += 1; } }),
  };
  return { steps: { ...base, ...overrides }, calls,
    released: () => released };
}

test("the cycle does nothing while its switch is off", async () => {
  const fake = steps();
  const old = process.env[AMUX_V19_MAX_SESSION_CYCLE_ENV];
  delete process.env[AMUX_V19_MAX_SESSION_CYCLE_ENV];
  try {
    assert.deepEqual(await runAmuxV19MaxSessionCycleOnce({ origin },
      fake.steps), { kind: "disabled" });
  } finally {
    if (old !== undefined) process.env[AMUX_V19_MAX_SESSION_CYCLE_ENV] = old;
  }
  assert.deepEqual(fake.calls, []);
});

test("one recorded cycle runs every step once and releases the halt", () =>
  withSwitches(async () => {
    const fake = steps();
    const result = await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, fake.steps);
    assert.deepEqual(result, { kind: "recorded", claimId: identity.claimId,
      haltReleased: true, planState: "plan_ready",
      registrationState: "write_disabled" });
    assert.deepEqual(fake.calls, ["claim", "readIdea", "analyse", "finalize"]);
    assert.equal(fake.released(), 1);
  }));

test("a Cursor claim's prompt names that CLI's read tools", () =>
  withSwitches(async () => {
    const cursorIdentity = { ...identity, provider: "cursor", modelId: "auto" };
    let text;
    const fake = steps({
      claim: async () => ({ kind: "claimed", identity: cursorIdentity, claim,
        retryWrite: false }),
      readIdea: async () => ({ kind: "ready", prompt: pagePrompt(identity.claimId) }),
      analyse: async (input) => {
        assert.equal(input.provider, "cursor");
        text = input.prompt(1).toString("utf8");
        return { kind: "outcome_unknown", cliStarted: true };
      },
    });
    assert.deepEqual(await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, fake.steps), { kind: "outcome_unknown",
      stage: "analysis", claimId: identity.claimId });
    assert.ok(text.includes("Use your read-only file tools (read, glob, grep, list)"));
    assert.ok(!text.includes("Use the Read, Grep and Glob tools"));
  }));

test("nothing after a claim is retried and only a recorded result releases the halt",
  () => withSwitches(async () => {
    const cases = [
      ["idea_read", { readIdea: async () => ({ kind: "unavailable" }) }],
      ["analysis", { analyse: async () => ({ kind: "outcome_unknown",
        cliStarted: true }) }],
      ["analysis", { analyse: async () => { throw new Error("lost"); } }],
      ["result", { finalize: async () => ({ kind: "outcome_unknown",
        retryWrite: false }) }],
    ];
    for (const [stage, override] of cases) {
      const fake = steps(override);
      const result = await runAmuxV19MaxSessionCycleOnce({ origin,
        stateDirectory: "/state" }, fake.steps);
      assert.deepEqual(result, { kind: "outcome_unknown", stage,
        claimId: identity.claimId });
      assert.equal(fake.released(), 0, stage);
      assert.equal(fake.calls.filter((call) => call === "claim").length, 1);
    }
  }));

test("a page prompt for another claim stops before the CLI", () =>
  withSwitches(async () => {
    const fake = steps({
      readIdea: async () => ({ kind: "ready",
        prompt: pagePrompt("aaaaaaaa-4b78-4af6-931a-9eec8f66d394") }),
      analyse: async (input) => {
        const prompt = input.prompt(1);
        return prompt === null ? { kind: "outcome_unknown", cliStarted: false }
          : { kind: "verified_success" };
      },
    });
    const result = await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, fake.steps);
    assert.deepEqual(result, { kind: "outcome_unknown", stage: "prompt",
      claimId: identity.claimId });
    assert.equal(fake.released(), 0);
  }));

test("a queue answer without a claim is reported as is", () =>
  withSwitches(async () => {
    for (const kind of ["idle", "halted", "outcome_unknown"]) {
      const fake = steps({ claim: async () => ({ kind }) });
      assert.deepEqual(await runAmuxV19MaxSessionCycleOnce({ origin },
        fake.steps), { kind, stage: "claim" });
      assert.deepEqual(fake.calls, []);
    }
  }));

test("the status line carries fixed words only", () => {
  assert.deepEqual(amuxV19MaxSessionCycleStatus({ kind: "recorded",
    claimId: identity.claimId, haltReleased: true, planState: "plan_ready",
    registrationState: "committed" }), { line:
    "AMUX_V19_MAX_SESSION_CYCLE_recorded planState=plan_ready registrationState=committed\n",
  exitCode: 0 });
  const unknown = amuxV19MaxSessionCycleStatus({ kind: "outcome_unknown",
    stage: "result", claimId: identity.claimId });
  assert.equal(unknown.exitCode, 1);
  assert.ok(!unknown.line.includes(identity.claimId));
  assert.equal(amuxV19MaxSessionCycleStatus({ kind: "halted" }).exitCode, 1);
  assert.equal(amuxV19MaxSessionCycleStatus({ kind: "made-up" }).line,
    "AMUX_V19_MAX_SESSION_CYCLE_unavailable\n");
});
