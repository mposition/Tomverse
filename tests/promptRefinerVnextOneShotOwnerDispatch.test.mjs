import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createPromptRefinerVnextOneShotOwnerSeal } from
  "../lib/promptRefinerVnextOneShotOwnerSeal.ts";
import { recordPromptRefinerVnextOneShotTerminalReceipt,
  runPromptRefinerVnextOneShotOwnerSlot } from
  "../scripts/prompt-refiner-vnext-one-shot-owner-runner.mjs";
import { syntheticManifest } from
  "./support/promptRefinerVnextOneShotSyntheticManifest.mjs";

const keyHex = "42".repeat(32);
const runnerDigest = "ab".repeat(32);
const at = new Date("2026-10-04T00:00:00.000Z");
const confirmation = "I_AM_MPOSITION_AND_VERIFIED_EVERY_LABEL_AND_PRIVACY_EXCLUSION";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = fileURLToPath(new URL(
  "../scripts/prompt-refiner-vnext-one-shot-owner-runner.mjs", import.meta.url));

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), "prvnext-owner-dispatch-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const paths = {
    manifestPath: join(folder, "manifest.json"),
    bindingPath: join(folder, "binding.json"),
    sealPath: join(folder, "seal.json"),
  };
  const synthetic = syntheticManifest();
  const binding = JSON.parse(synthetic.bindingText);
  const seal = createPromptRefinerVnextOneShotOwnerSeal({
    manifestText: synthetic.manifestText,
    expectedRootDigest: binding.expectedRootDigest,
    expectedPreregistrationDigest: binding.expectedPreregistrationDigest,
    ownerHmacKey: Buffer.from(keyHex, "hex"),
    now: new Date("2026-10-03T00:00:00.000Z"), confirmation,
  });
  writeFileSync(paths.manifestPath, synthetic.manifestText);
  writeFileSync(paths.bindingPath, synthetic.bindingText);
  writeFileSync(paths.sealPath, seal);
  return { ...paths, ownerKeyHex: keyHex, slotIndex: 0, now: at,
    runApprovalAuditLogId: "synthetic-run-audit", env: {
      PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED: "1",
      PROMPT_REFINER_VNEXT_ONE_SHOT_APP_ORIGIN: "https://app.example.test",
      PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN: "synthetic-runner-token-with-at-least-32-characters",
      PROMPT_REFINER_VNEXT_ONE_SHOT_PROVIDER_API_KEY: "synthetic-dedicated-provider-key-32-chars",
      PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST: runnerDigest,
    }, synthetic, binding };
}

const boundedResponse = () => ({
  text: JSON.stringify({ outcome: "abstained", refinedPrompt: null,
    abstentionReason: "unsafe_to_rewrite" }),
  finishReason: "stop", warnings: [], toolCalls: [], toolResults: [],
  steps: [{ toolCalls: [], toolResults: [] }],
  usage: { inputTokens: 1, outputTokens: 1,
    inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokenDetails: { reasoningTokens: 0 } },
});

function grantFor(body) {
  return Response.json({ requestId: body.requestId, slotIndex: body.slotIndex,
    slotConsumptionAuditLogId: "synthetic-slot-audit",
    reservationConsumed: true, dispatchAuthorized: true }, { status: 201 });
}

async function invokeWithMockFetch(input, { fetch, generate }) {
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    return await runPromptRefinerVnextOneShotOwnerSlot(input, { generate });
  } finally {
    globalThis.fetch = original;
  }
}

test("terminal settlement sends only telemetry once and never retries a lost response", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  const result = { status: "bounded_response", requestId:
    "11111111-1111-4111-8111-111111111111", slotIndex: 0,
    slotConsumptionAuditLogId: "synthetic-slot-audit",
    output: { outcome: "abstained", refinedPrompt: null,
      abstentionReason: "unsafe_to_rewrite" },
    usage: { inputTokens: 1, outputTokens: 1,
      cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 },
    costUpperBoundMicroUsd: 1, intentToTerminalLatencyMs: 10 };
  const input = { origin: "https://app.example.test",
    token: "synthetic-runner-token-with-at-least-32-characters",
    runApprovalAuditLogId: "synthetic-run-audit" };
  try {
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(String(url), "https://app.example.test/api/internal/prompt-refiner/vnext-one-shot-terminal");
      const payload = JSON.parse(options.body);
      assert.equal(payload.resultKind, "abstained");
      assert.equal(JSON.stringify(payload).includes("unsafe_to_rewrite"), false);
      assert.equal(JSON.stringify(payload).includes("refinedPrompt"), false);
      return Response.json({ terminalAuditLogId: "synthetic-terminal-audit",
        requestId: result.requestId, slotIndex: 0,
        observedCostMicroUsd: 1, dispatchAuthorized: false }, { status: 201 });
    };
    assert.equal(await recordPromptRefinerVnextOneShotTerminalReceipt(result, input), true);
    assert.equal(calls, 1);
    globalThis.fetch = async () => { calls++; throw new Error("lost response"); };
    assert.equal(await recordPromptRefinerVnextOneShotTerminalReceipt(result, input), false);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = previous; }
});

test("confirmed parser failure settles once as a content-free failed terminal", async (t) => {
  const input = fixture(t);
  let generated = 0;
  const response = boundedResponse();
  response.text = "not JSON";
  const failed = await invokeWithMockFetch(input, {
    fetch: async (url, options) => {
      assert.ok(url.endsWith("-slot"));
      return grantFor(JSON.parse(options.body));
    },
    generate: async () => { generated++; return response; },
  });
  assert.equal(generated, 1);
  assert.equal(failed.status, "confirmed_failure");
  assert.equal(failed.failureCode, "vnext_strict_parse_failure");
  assert.equal(failed.output, undefined);
  const prior = globalThis.fetch;
  let terminalCalls = 0;
  try {
    globalThis.fetch = async (url, options) => {
      terminalCalls++;
      assert.ok(url.endsWith("-terminal"));
      const body = JSON.parse(options.body);
      assert.equal(body.resultKind, "failed");
      assert.equal(body.failureCode, "vnext_strict_parse_failure");
      assert.equal(JSON.stringify(body).includes("not JSON"), false);
      assert.equal(body.observedCostMicroUsd, failed.costUpperBoundMicroUsd);
      return Response.json({ terminalAuditLogId: "synthetic-terminal-audit",
        requestId: failed.requestId, slotIndex: failed.slotIndex,
        observedCostMicroUsd: failed.costUpperBoundMicroUsd,
        dispatchAuthorized: false }, { status: 201 });
    };
    assert.equal(await recordPromptRefinerVnextOneShotTerminalReceipt(failed, {
      origin: input.env.PROMPT_REFINER_VNEXT_ONE_SHOT_APP_ORIGIN,
      token: input.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN,
      runApprovalAuditLogId: input.runApprovalAuditLogId,
    }), true);
    assert.equal(terminalCalls, 1);
  } finally { globalThis.fetch = prior; }
});

test("default-off runner never asks the app or reaches a provider transport", async (t) => {
  const input = fixture(t);
  delete input.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED;
  let calls = 0;
  await assert.rejects(invokeWithMockFetch(input, {
    fetch: async () => { calls++; return Response.json({}); },
    generate: async () => { calls++; return boundedResponse(); },
  }), { message: "owner_runner_preflight_unavailable" });
  assert.equal(calls, 0);
});

test("SDK load failure and model mismatch refuse before consuming a slot", async (t) => {
  const input = fixture(t);
  const original = globalThis.fetch;
  let appCalls = 0;
  globalThis.fetch = async () => { appCalls++; return Response.json({}); };
  try {
    for (const loadSdk of [
      async () => { throw new Error("synthetic import failure"); },
      async () => [
        { generateText: async () => boundedResponse() },
        { createOpenAI: () => ({ responses: () => ({
          provider: "openai.responses", modelId: "wrong-model",
        }) }) },
      ],
    ]) {
      await assert.rejects(runPromptRefinerVnextOneShotOwnerSlot(input,
        { loadSdk }), { message: "owner_runner_preflight_unavailable" });
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(appCalls, 0);
});

test("default-off dispatch CLI leaves no result file or content in output", (t) => {
  const input = fixture(t);
  const resultPath = join(dirname(input.manifestPath), "result.json");
  const result = spawnSync(process.execPath, ["--conditions=react-server", "--import",
    "tsx", cli, "--dispatch-slot", "--manifest", input.manifestPath,
    "--binding", input.bindingPath, "--seal", input.sealPath,
    "--slot", "0", "--run-audit", input.runApprovalAuditLogId,
    "--result", resultPath], { cwd: repo, encoding: "utf8",
    env: { ...process.env,
      PROMPT_REFINER_VNEXT_ONE_SHOT_OWNER_SEAL_KEY_HEX: keyHex,
      PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED: "0" } });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "owner_runner_dispatch_unavailable\n");
  assert.equal(existsSync(resultPath), false);
});

test("app refusal and forged admission fields cannot reach the generator", async (t) => {
  const input = { ...fixture(t), dispatchAuthorized: true };
  for (const response of [Response.json({ dispatchAuthorized: true }, { status: 409 })]) {
    let generated = 0;
    await assert.rejects(invokeWithMockFetch(input, {
      fetch: async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.deepEqual(Object.keys(body).sort(), ["manifestRoot", "requestId",
          "runApprovalAuditLogId", "runnerDigest", "slotIndex"].sort());
        assert.equal(body.manifestRoot, input.binding.expectedRootDigest);
        assert.equal(body.runnerDigest, runnerDigest);
        assert.ok(!options.body.includes("synthetic ko source"));
        return response;
      },
      generate: async () => { generated++; return boundedResponse(); },
    }), { message: "owner_runner_preflight_unavailable" });
    assert.equal(generated, 0);
  }
  let generated = 0;
  const malformed = await invokeWithMockFetch(input, {
    fetch: async () => Response.json({ dispatchAuthorized: true }, { status: 201 }),
    generate: async () => { generated++; return boundedResponse(); },
  });
  assert.equal(malformed.status, "admission_outcome_unknown");
  assert.equal(malformed.retryAuthorized, false);
  assert.equal(generated, 0);
});

test("lost app response is unknown and never starts a provider call", async (t) => {
  const input = fixture(t);
  let generated = 0;
  const result = await invokeWithMockFetch(input, {
    fetch: async () => { throw new Error("synthetic connection loss"); },
    generate: async () => { generated++; return boundedResponse(); },
  });
  assert.equal(result.status, "admission_outcome_unknown");
  assert.match(result.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(result.humanReviewRequired, true);
  assert.equal(result.retryAuthorized, false);
  assert.equal(generated, 0);
});

test("a matched app slot grant sends exactly one bounded mock request", async (t) => {
  const input = fixture(t);
  let appCalls = 0;
  let generated = 0;
  const result = await invokeWithMockFetch(input, {
    fetch: async (url, options) => {
      appCalls++;
      assert.equal(url, "https://app.example.test/api/internal/prompt-refiner/vnext-one-shot-slot");
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "error");
      return grantFor(JSON.parse(options.body));
    },
    generate: async (options) => {
      generated++;
      assert.equal(options.maxRetries, 0);
      assert.equal(options.maxOutputTokens, 4096);
      assert.equal(options.toolChoice, "none");
      assert.equal(options.timeout, 15_000);
      return boundedResponse();
    },
  });
  assert.equal(appCalls, 1);
  assert.equal(generated, 1);
  assert.equal(result.status, "bounded_response");
  assert.equal(result.slotConsumptionAuditLogId, "synthetic-slot-audit");
  assert.equal(result.dispatchAuthorized, false);
  assert.equal(result.output.outcome, "abstained");
});

test("unknown mock transport stops the app run once and never retries", async (t) => {
  const input = fixture(t);
  let generated = 0;
  const calls = [];
  const result = await invokeWithMockFetch(input, {
    fetch: async (url, options) => {
      calls.push(url);
      if (url.endsWith("-slot")) return grantFor(JSON.parse(options.body));
      assert.ok(url.endsWith("-stop"));
      const body = JSON.parse(options.body);
      assert.equal(body.reason, "provider_error");
      assert.equal(body.slotConsumptionAuditLogId, "synthetic-slot-audit");
      return Response.json({ stopAuditLogId: "synthetic-stop-audit",
        reservationHeld: true, humanReviewRequired: true,
        retryAuthorized: false, dispatchAuthorized: false }, { status: 201 });
    },
    generate: async () => { generated++; throw new Error("synthetic transport failure"); },
  });
  assert.equal(generated, 1);
  assert.equal(calls.length, 2);
  assert.equal(result.status, "outcome_unknown");
  assert.equal(result.reason, "provider_error");
  assert.equal(result.stopRecorded, true);
  assert.equal(result.retryAuthorized, false);
  assert.equal(result.humanReviewRequired, true);
});

test("unpriced cache-write telemetry stops after one mock call", async (t) => {
  const input = fixture(t);
  let generated = 0;
  let stops = 0;
  const result = await invokeWithMockFetch(input, {
    fetch: async (url, options) => {
      if (url.endsWith("-slot")) return grantFor(JSON.parse(options.body));
      stops++;
      assert.equal(JSON.parse(options.body).reason, "response_unverified");
      return Response.json({ stopAuditLogId: "synthetic-stop-audit",
        reservationHeld: true, humanReviewRequired: true,
        retryAuthorized: false, dispatchAuthorized: false }, { status: 201 });
    },
    generate: async () => {
      generated++;
      const response = boundedResponse();
      response.usage.inputTokenDetails.cacheWriteTokens = 1;
      return response;
    },
  });
  assert.equal(generated, 1);
  assert.equal(stops, 1);
  assert.equal(result.status, "outcome_unknown");
  assert.equal(result.reason, "response_unverified");
  assert.equal(result.stopRecorded, true);
  assert.equal(result.retryAuthorized, false);
});

test("source drift after consumption prevents a provider call", async (t) => {
  const input = fixture(t);
  let generated = 0;
  let stops = 0;
  const result = await invokeWithMockFetch(input, {
    fetch: async (url, options) => {
      if (url.endsWith("-slot")) {
        writeFileSync(input.manifestPath,
          input.synthetic.manifestText.replace("synthetic ko source", "changed ko source"));
        return grantFor(JSON.parse(options.body));
      }
      stops++;
      assert.equal(JSON.parse(options.body).reason, "response_unverified");
      return Response.json({ stopAuditLogId: "synthetic-stop-audit",
        reservationHeld: true, humanReviewRequired: true,
        retryAuthorized: false, dispatchAuthorized: false }, { status: 201 });
    },
    generate: async () => { generated++; return boundedResponse(); },
  });
  assert.equal(generated, 0);
  assert.equal(stops, 1);
  assert.equal(result.status, "outcome_unknown");
  assert.equal(result.stopRecorded, true);
  assert.equal(result.humanReviewRequired, true);
});

test("v5 owner slot binds admission and terminal telemetry to v5", async (t) => {
  const input = { ...fixture(t), stageId: "prompt-refiner-vnext-one-shot-v5" };
  let calls = 0;
  const result = await invokeWithMockFetch(input, {
    fetch: async (url, options) => {
      calls++;
      assert.ok(url.endsWith("-slot"));
      const body = JSON.parse(options.body);
      assert.equal(body.stageId, input.stageId);
      return grantFor(body);
    },
    generate: async () => boundedResponse(),
  });
  assert.equal(result.status, "bounded_response");
  assert.equal(calls, 1);
  const prior = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.ok(url.endsWith("-terminal"));
      const body = JSON.parse(options.body);
      assert.equal(body.stageId, input.stageId);
      assert.equal(JSON.stringify(body).includes("refinedPrompt"), false);
      return Response.json({ terminalAuditLogId: "synthetic-v5-terminal-audit",
        requestId: result.requestId, slotIndex: result.slotIndex,
        observedCostMicroUsd: result.costUpperBoundMicroUsd,
        dispatchAuthorized: false }, { status: 201 });
    };
    assert.equal(await recordPromptRefinerVnextOneShotTerminalReceipt(result, {
      origin: input.env.PROMPT_REFINER_VNEXT_ONE_SHOT_APP_ORIGIN,
      token: input.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN,
      runApprovalAuditLogId: input.runApprovalAuditLogId,
      stageId: input.stageId,
    }), true);
  } finally { globalThis.fetch = prior; }
  assert.equal(calls, 2);
});

test("v5 owner transport unknown sends one v5 stop", async (t) => {
  const input = { ...fixture(t), stageId: "prompt-refiner-vnext-one-shot-v5" };
  let stops = 0;
  const result = await invokeWithMockFetch(input, {
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.stageId, input.stageId);
      if (url.endsWith("-slot")) return grantFor(body);
      assert.ok(url.endsWith("-stop"));
      stops++;
      return Response.json({ stopAuditLogId: "synthetic-v5-stop-audit",
        reservationHeld: true, humanReviewRequired: true,
        retryAuthorized: false, dispatchAuthorized: false }, { status: 201 });
    },
    generate: async () => { throw new Error("synthetic transport failure"); },
  });
  assert.equal(result.status, "outcome_unknown");
  assert.equal(result.retryAuthorized, false);
  assert.equal(result.stopRecorded, true);
  assert.equal(stops, 1);
});
