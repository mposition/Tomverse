import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import corpusJson from "../docs/ops/prompt-refiner-shadow/corpus-v1.json" with { type: "json" };
import {
  createPromptRefinerShadowRunner,
  PromptRefinerShadowRunnerError,
} from "../lib/promptRefinerShadowRunner.ts";
import {
  PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
  PROMPT_REFINER_SHADOW_CASE_IDS,
  PROMPT_REFINER_SHADOW_INVOCATION_BUDGET_MS,
  PROMPT_REFINER_SHADOW_ROUTE_MAX_DURATION_SECONDS,
  PROMPT_REFINER_SHADOW_RUN_ID,
  PROMPT_REFINER_SHADOW_TERMINAL_WRITE_MARGIN_MS,
  PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING,
  PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE,
  PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION,
} from "../lib/promptRefinerShadowRunContract.ts";
import { PROMPT_REFINER_TIMEOUT_MS } from "../lib/promptRefinerExecutionContract.ts";
import { validatePromptRefinerShadowCorpus } from "../lib/promptRefinerShadowHarness.ts";

const corpus = validatePromptRefinerShadowCorpus(corpusJson);

const fixture = (options = {}) => {
  const events = [];
  const incidents = [];
  const terminalEvidence = [];
  let enabled = true;
  let dispatchCount = 0;
  let terminalCount = 0;
  let status = "approved";
  let inFlightAttemptId = options.initialInFlight ?? null;
  const terminalReasons = options.terminalReasons ?? [];

  const state = () => ({
    observedAt: "2026-09-20T09:00:00.000Z",
    runId: PROMPT_REFINER_SHADOW_RUN_ID,
    status,
    dispatchCount,
    terminalCount,
    nextCaseIndex:
      status === "completed" || status === "stopped_unknown" || inFlightAttemptId
        ? null
        : dispatchCount,
    nextCaseId:
      status === "completed" || status === "stopped_unknown" || inFlightAttemptId
        ? null
        : PROMPT_REFINER_SHADOW_CASE_IDS[dispatchCount] ?? null,
    inFlightAttemptId,
    approvalExpiresAt: "2026-09-20T10:00:00.000Z",
  });

  const dependencies = {
    nowMs: options.nowMs ?? (() => 0),
    executionEnabled: () => enabled,
    sweep: async () => {
      events.push("sweep");
      return {
        observedAt: "2026-09-20T09:00:00.000Z",
        staleCandidates: 0,
        closedUnknownAttemptIds: [],
        unresolvedStaleAttemptIds: options.unresolved ?? [],
        consumedWithoutAttempt: options.consumedWithoutAttempt ?? [],
        retryCount: 0,
        redispatched: 0,
      };
    },
    readState: async () => {
      events.push("state");
      return state();
    },
    reserve: async ({ requestId }) => {
      events.push(`reserve:${requestId}`);
      if (options.reserveRefusalReason) {
        return { ok: false, reason: options.reserveRefusalReason };
      }
      return {
        ok: true,
        value: {
          reservation: {
            reservationId: `reservation_${dispatchCount}`,
            requestId,
            stageId: "prompt-refiner-shadow-v2",
            contractDigest: `sha256:${"c".repeat(64)}`,
          },
        },
      };
    },
    release: async () => {
      events.push("release");
      if (options.releaseRefusalReason) {
        return { ok: false, reason: options.releaseRefusalReason };
      }
      return { ok: true, value: { status: "released" } };
    },
    recordIntent: async ({ caseId, caseIndex, fact }) => {
      events.push(`intent:${caseId}`);
      assert.equal(caseIndex, dispatchCount);
      assert.equal(fact.retryCount, 0);
      if (options.intentRefusalAt === caseIndex) {
        return {
          ok: false,
          reason: options.intentRefusalReason ?? "run_not_executable",
        };
      }
      dispatchCount += 1;
      status = "running";
      inFlightAttemptId = `attempt_${caseIndex}`;
      return { ok: true, attempt: { id: inFlightAttemptId } };
    },
    adapter: async ({ requestId, onDispatch }) => {
      const caseIndex = dispatchCount;
      events.push(`adapter:${requestId}`);
      if (options.failBeforeIntentAt === caseIndex) throw new Error("before intent");
      if (options.resolveWithoutIntentAt === caseIndex) {
        return {
          status: "failed",
          terminalReason: "response_validation_failed",
          refinedPrompt: null,
          durationMs: 1,
          usage: null,
        };
      }
      await onDispatch({
        requestId,
        adapterVersion: PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
        provider: "openai",
        modelId: "gpt-5-6-luna",
        apiModelId: "gpt-5.6-luna",
        maxOutputTokens: 4096,
        timeoutMs: 15000,
        retryCount: 0,
        tokenizerPackage: PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE,
        tokenizerPackageVersion: PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION,
        tokenizerEncoding: PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING,
        admissionInputTokens: 100,
      });
      if (options.failAfterIntentAt === caseIndex) throw new Error("after intent");
      const terminalReason = terminalReasons[caseIndex] ?? "suggested";
      return {
        status: terminalReason === "suggested" ? "suggested" : "failed",
        terminalReason,
        refinedPrompt: terminalReason === "suggested" ? "discarded transient result" : null,
        durationMs: 10,
        usage: {
          inputTokens: 100,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 20,
          reasoningTokens: 8,
          costUpperBoundMicroUsd: 44,
        },
      };
    },
    recordTerminal: async ({ attemptId, terminalReason, evidence }) => {
      events.push(`terminal:${attemptId}:${terminalReason}`);
      assert.equal(evidence.caseId, PROMPT_REFINER_SHADOW_CASE_IDS[terminalCount]);
      assert.equal("refinedPrompt" in evidence, false);
      terminalEvidence.push(evidence);
      if (options.failTerminalAt === terminalCount) {
        throw new Error("raw terminal failure must not escape");
      }
      terminalCount += 1;
      inFlightAttemptId = null;
      if (terminalReason === "unknown_after_dispatch") status = "stopped_unknown";
      else if (terminalCount === PROMPT_REFINER_SHADOW_CASE_IDS.length) status = "completed";
      if (options.disableAfterTerminal === terminalCount) enabled = false;
    },
    reportIncident: async (incident) => {
      incidents.push(incident);
      events.push(`incident:${incident.context.phase}`);
      if (options.failIncidentReporting) {
        throw new Error("incident delivery failure");
      }
      return { notified: true, suppressed: false };
    },
    corpus: options.corpus ?? corpus,
  };
  return {
    run: createPromptRefinerShadowRunner(dependencies),
    events,
    incidents,
    state,
    terminalEvidence,
  };
};

test("the runner sweeps first and executes all 16 cases once in exact order", async () => {
  const world = fixture();
  const result = await world.run();
  assert.equal(world.events[0], "sweep");
  assert.equal(result.status, "completed");
  assert.equal(result.attemptedThisInvocation, 16);
  assert.equal(result.dispatchCount, 16);
  assert.equal(result.terminalCount, 16);
  assert.equal(result.retryCount, 0);
  assert.equal(result.redispatched, 0);
  assert.deepEqual(
    world.events.filter((event) => event.startsWith("intent:")),
    PROMPT_REFINER_SHADOW_CASE_IDS.map((id) => `intent:${id}`),
  );
  const reservations = world.events.filter((event) => event.startsWith("reserve:"));
  assert.equal(reservations.length, 16);
  assert.equal(new Set(reservations).size, 16);
  assert.equal(world.terminalEvidence.length, 16);
  assert.doesNotMatch(JSON.stringify(world.terminalEvidence), /discarded transient result/);
});

test("a known unknown outcome latches the run and stops later cases", async () => {
  const reasons = ["suggested", "unknown_after_dispatch"];
  const world = fixture({ terminalReasons: reasons });
  const result = await world.run();
  assert.equal(result.status, "stopped_unknown");
  assert.equal(result.dispatchCount, 2);
  assert.equal(result.terminalCount, 2);
  assert.equal(world.events.filter((event) => event.startsWith("reserve:")).length, 2);
});

test("a pre-intent failure releases once and never retries", async () => {
  const world = fixture({ failBeforeIntentAt: 0 });
  await assert.rejects(
    world.run(),
    (error) =>
      error instanceof PromptRefinerShadowRunnerError &&
      error.code === "PROMPT_REFINER_SHADOW_PRE_DISPATCH_FAILED",
  );
  assert.equal(world.events.filter((event) => event === "release").length, 1);
  assert.equal(world.events.filter((event) => event.startsWith("intent:")).length, 0);
  assert.equal(world.events.filter((event) => event.startsWith("reserve:")).length, 1);
  assert.equal(world.incidents.length, 1);
  assert.equal(world.incidents[0].context.phase, "pre_dispatch");
  assert.doesNotMatch(JSON.stringify(world.incidents), /before intent/);
});

test("a reservation refusal reports its fixed cause before stopping", async () => {
  const world = fixture({ reserveRefusalReason: "stage_capacity_exhausted" });
  await assert.rejects(
    world.run(),
    (error) =>
      error instanceof PromptRefinerShadowRunnerError &&
      error.code === "PROMPT_REFINER_SHADOW_RESERVATION_REFUSED",
  );
  assert.equal(world.events.filter((event) => event.startsWith("reserve:")).length, 1);
  assert.equal(world.events.includes("release"), false);
  assert.equal(world.incidents.length, 1);
  assert.equal(world.incidents[0].context.phase, "pre_dispatch");
  assert.equal(world.incidents[0].context.causeCode, "stage_capacity_exhausted");
  assert.doesNotMatch(JSON.stringify(world.incidents), /prsv4_/);
});

test("a post-intent exception leaves one durable intent and forbids redispatch", async () => {
  const world = fixture({ failAfterIntentAt: 0 });
  await assert.rejects(
    world.run(),
    (error) =>
      error instanceof PromptRefinerShadowRunnerError &&
      error.code === "PROMPT_REFINER_SHADOW_OUTCOME_UNKNOWN",
  );
  assert.equal(world.events.includes("release"), false);
  assert.equal(world.events.filter((event) => event.startsWith("intent:")).length, 1);
  assert.equal(world.events.filter((event) => event.startsWith("terminal:")).length, 0);
  assert.equal(world.events.filter((event) => event.startsWith("reserve:")).length, 1);
  assert.equal(world.incidents.length, 1);
  assert.equal(world.incidents[0].context.phase, "post_dispatch");
  assert.equal(world.incidents[0].context.causeCode, "unexpected_error");
  assert.doesNotMatch(JSON.stringify(world.incidents), /after intent/);
});

test("an expired reservation refusal is not released again and preserves the refusal", async () => {
  const world = fixture({
    intentRefusalAt: 0,
    intentRefusalReason: "reservation_expired",
  });
  await assert.rejects(
    world.run(),
    (error) =>
      error instanceof PromptRefinerShadowRunnerError &&
      error.code === "PROMPT_REFINER_SHADOW_DISPATCH_REFUSED" &&
      /reservation_expired/.test(error.message),
  );
  assert.equal(world.events.includes("release"), false);
  assert.equal(world.incidents[0].context.causeCode, "PROMPT_REFINER_SHADOW_DISPATCH_REFUSED");
});

test("other intent refusals release once and preserve the dispatch refusal", async () => {
  const world = fixture({
    intentRefusalAt: 0,
    intentRefusalReason: "run_not_executable",
  });
  await assert.rejects(
    world.run(),
    (error) =>
      error instanceof PromptRefinerShadowRunnerError &&
      error.code === "PROMPT_REFINER_SHADOW_DISPATCH_REFUSED",
  );
  assert.equal(world.events.filter((event) => event === "release").length, 1);
});

test("a fixed reservation release refusal reaches the content-free incident", async () => {
  const world = fixture({
    failBeforeIntentAt: 0,
    releaseRefusalReason: "reservation_not_found",
  });
  await assert.rejects(
    world.run(),
    (error) =>
      error instanceof PromptRefinerShadowRunnerError &&
      error.code === "PROMPT_REFINER_SHADOW_PRE_DISPATCH_RELEASE_FAILED",
  );
  assert.equal(world.incidents.length, 2);
  assert.equal(world.incidents[1].context.phase, "reservation_release");
  assert.equal(world.incidents[1].context.causeCode, "reservation_not_found");
  assert.equal(world.incidents[1].error, "reservation_not_found");
});

test("incident delivery failure preserves the original runner classification", async () => {
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (line) => logged.push(String(line));
  try {
    const world = fixture({ failBeforeIntentAt: 0, failIncidentReporting: true });
    await assert.rejects(
      world.run(),
      (error) =>
        error instanceof PromptRefinerShadowRunnerError &&
        error.code === "PROMPT_REFINER_SHADOW_PRE_DISPATCH_FAILED",
    );
    assert.equal(world.events.filter((event) => event === "release").length, 1);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /prompt_refiner_shadow_incident_reporting_failed/);
  assert.doesNotMatch(logged[0], /before intent|incident delivery failure/);
});

test("an adapter return without dispatch intent releases its reservation once", async () => {
  const world = fixture({ resolveWithoutIntentAt: 0 });
  await assert.rejects(
    world.run(),
    (error) =>
      error instanceof PromptRefinerShadowRunnerError &&
      error.code === "PROMPT_REFINER_SHADOW_INTENT_MISSING",
  );
  assert.equal(world.events.filter((event) => event === "release").length, 1);
  assert.equal(world.events.filter((event) => event.startsWith("intent:")).length, 0);
  assert.equal(world.events.filter((event) => event.startsWith("reserve:")).length, 1);
  assert.equal(world.incidents[0].context.phase, "intent_missing");
  assert.equal(world.incidents[0].context.causeCode, "intent_missing");
});

test("a terminal-write exception is reported without raw error text before stopping", async () => {
  const world = fixture({ failTerminalAt: 0 });
  await assert.rejects(
    world.run(),
    (error) =>
      error instanceof PromptRefinerShadowRunnerError &&
      error.code === "PROMPT_REFINER_SHADOW_TERMINAL_WRITE_UNKNOWN",
  );
  assert.equal(world.incidents.length, 1);
  assert.equal(world.incidents[0].context.phase, "terminal_write");
  assert.equal(world.incidents[0].context.attemptId, "attempt_0");
  assert.doesNotMatch(JSON.stringify(world.incidents), /raw terminal failure/);
  assert.equal(world.events.includes("release"), false);
});

test("the kill switch is rechecked between cases", async () => {
  const world = fixture({ disableAfterTerminal: 1 });
  const result = await world.run();
  assert.equal(result.status, "paused");
  assert.equal(result.dispatchCount, 1);
  assert.equal(result.terminalCount, 1);
});

test("the invocation budget pauses before reserving a case that may outlive the route", async () => {
  let calls = 0;
  const threshold =
    PROMPT_REFINER_SHADOW_INVOCATION_BUDGET_MS -
    PROMPT_REFINER_TIMEOUT_MS -
    PROMPT_REFINER_SHADOW_TERMINAL_WRITE_MARGIN_MS;
  const world = fixture({
    nowMs: () => (calls++ === 0 ? 0 : threshold + 1),
  });
  const result = await world.run();
  assert.equal(result.status, "paused");
  assert.equal(result.attemptedThisInvocation, 0);
  assert.equal(world.events.some((event) => event.startsWith("reserve:")), false);
});

test("the route maxDuration is mechanically bound to the run contract", () => {
  const source = readFileSync(
    new URL("../app/api/admin/prompt-refiner/shadow-run/execute/route.ts", import.meta.url),
    "utf8",
  );
  const match = source.match(/export const maxDuration\s*=\s*(\d+)\s*;/);
  assert.ok(match, "execute route must expose a statically analyzable maxDuration literal");
  const routeMaxDurationSeconds = Number(match[1]);
  assert.equal(routeMaxDurationSeconds, PROMPT_REFINER_SHADOW_ROUTE_MAX_DURATION_SECONDS);
  assert.ok(
    PROMPT_REFINER_SHADOW_INVOCATION_BUDGET_MS < routeMaxDurationSeconds * 1_000,
  );
});

test("the runner binds its execution corpus directly to the frozen digest", async () => {
  const world = fixture({
    corpus: { ...corpus, contentDigest: "0".repeat(64) },
  });
  await assert.rejects(
    world.run(),
    (error) =>
      error instanceof PromptRefinerShadowRunnerError &&
      error.code === "PROMPT_REFINER_SHADOW_CORPUS_DIGEST_INVALID",
  );
  assert.deepEqual(world.events, ["sweep"]);
});

test("an existing in-flight intent and a sweep incident both block dispatch", async () => {
  const inFlight = fixture({ initialInFlight: "attempt_existing" });
  const result = await inFlight.run();
  assert.equal(result.status, "in_flight");
  assert.equal(inFlight.events.some((event) => event.startsWith("reserve:")), false);

  const incident = fixture({ unresolved: ["attempt_stale"] });
  await assert.rejects(
    incident.run(),
    (error) =>
      error instanceof PromptRefinerShadowRunnerError &&
      error.code === "PROMPT_REFINER_SHADOW_SWEEP_INCIDENT",
  );
  assert.deepEqual(incident.events, ["sweep"]);
});
