import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { beforeEach, mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const requestId = "11111111-1111-4111-8111-111111111111";
let release: { explicitEnabled: boolean; autoEnabled: boolean;
  runtimeDeploymentId: string | null } = { explicitEnabled: true, autoEnabled: true,
  runtimeDeploymentId: "22222222-2222-4222-8222-222222222222" };
let adapterOutcome: Record<string, unknown>;
let reserveError: Error | null = null;
let providerCalls = 0;
let reserves = 0;
let dispatches = 0;
let settlements = 0;
let unknowns = 0;
let releases = 0;
let releasedFacts: Array<Record<string, unknown>> = [];
let holds = 0;
let receiptStates: string[] = [];
let settlementDelayMs = 0;
let autoGuardAvailable = true;
let guardAdmissions = 0;
let auditLatches = 0;
let receiptError = false;
let adapterConstructionError = false;
let executeErrorBeforeAuthorization = false;
let dispatchIntentError = false;
let releaseError = false;

class BudgetError extends Error {
  constructor(readonly code: string) { super(code); }
}

mock.module(mod("lib/activeAiModel.ts"), { namedExports: {
  getActiveAiModel: () => ({ provider: "openai.responses",
    modelId: "gpt-5.6-luna" }),
} });
mock.module(mod("lib/promptRefinerAutoBudgetHold.ts"), { namedExports: {
  PromptRefinerAutoBudgetError: BudgetError,
  reservePromptRefinerAutoBudget: async () => {
    reserves += 1;
    if (reserveError) throw reserveError;
    return { id: "33333333-3333-4333-8333-333333333333" };
  },
  createPromptRefinerAutoBudgetTransitionAuthority: (verifiers: Record<string,
    (raw: unknown) => Promise<unknown>>) => ({
    recordDispatchIntent: async (raw: unknown) => {
      await verifiers.verifyDispatchIntent(raw);
      if (dispatchIntentError) throw new Error("synthetic dispatch outcome unknown");
      dispatches += 1;
    },
    settleVerifiedBilled: async (raw: unknown) => {
      await verifiers.verifyVerifiedBilling(raw);
      if (settlementDelayMs) await new Promise(resolve =>
        setTimeout(resolve, settlementDelayMs));
      settlements += 1;
    },
    retainUnknown: async (raw: unknown) => {
      await verifiers.verifyBillingUnknown(raw); unknowns += 1;
    },
    releaseConfirmedUndispatched: async (raw: unknown) => {
      const fact = await verifiers.verifyUndispatched(raw);
      if (releaseError) throw new Error("synthetic release outcome unknown");
      releasedFacts.push(fact as Record<string, unknown>);
      releases += 1;
    },
  }),
} });
mock.module(mod("lib/promptRefinerChatExecutionStore.ts"), { namedExports: {
  isPromptRefinerCapturedChatDraft: () => true,
  claimPromptRefinerProductAttempt: async () => ({ outcome: "claimed" }),
  holdPromptRefinerProductChatSuggestion: async (input: { snapshot: {
    requestId: string; clientRequestId: string; id: string; epoch: number;
  }; response: Record<string, unknown> }) => {
    holds += 1;
    return { ...input.response, suggestionId: input.response.suggestionId,
      scopeId: input.snapshot.id, epoch: input.snapshot.epoch,
      clientRequestId: input.snapshot.clientRequestId,
      executionReceiptId: "receipt" };
  },
} });
mock.module(mod("lib/modelRegistry.ts"), { namedExports: {
  getEnabledRuntimeModel: async () => ({ provider: "openai",
    apiModel: "gpt-5.6-luna" }),
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  conversation: { findFirst: async () => ({ selectionMode: "auto" }) },
  $transaction: async (work: (tx: object) => Promise<unknown>) => work({}),
} } });
mock.module(mod("lib/promptRefinerChatExecutionRelease.ts"), { namedExports: {
  promptRefinerChatExecutionRelease: async () => release,
} });
mock.module(mod("lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback.ts"), {
  namedExports: { readPromptRefinerVnextOneShotPrice: async () => ({
    pricePinMatchesRegistry: true, problems: [],
  }) },
});
mock.module(mod("lib/promptRefinerProductReceiptStore.ts"), { namedExports: {
  recordPromptRefinerProductExecutionReceipt: async (receipt: Record<string, unknown>,
    _mode: string, state = "terminal") => {
    if (receiptError) throw new Error("synthetic receipt audit failure");
    receiptStates.push(state);
    return { ...receipt, receiptId: receipt.receiptId ?? "receipt" };
  },
} });
mock.module(mod("lib/promptRefinerProductOperationalGuard.ts"), { namedExports: {
  requirePromptRefinerProductAutoAdmission: async () => {
    guardAdmissions += 1;
    if (!autoGuardAvailable) throw new Error("operationally paused");
    return { active: true, generation: 1, reasonCode: null };
  },
  latchPromptRefinerProductAutoAuditFailure: async () => {
    auditLatches += 1;
    return { active: false, generation: 1, reasonCode: "audit_failure" };
  },
} });
mock.module(mod("lib/promptRefinerProductAdapter.ts"), { namedExports: {
  createPromptRefinerProductAdapter: (dependencies: {
    authorizeDispatch: (intent: object) => Promise<void>;
  }) => {
    if (adapterConstructionError) {
      throw new Error("synthetic adapter construction failure");
    }
    const intents = new WeakSet<object>();
    const billed = new WeakSet<object>();
    const unknown = new WeakSet<object>();
    const undispatched = new WeakSet<object>();
    return {
      execute: async () => {
        if (executeErrorBeforeAuthorization) {
          throw new Error("synthetic pre-authorization adapter failure");
        }
        const intent = Object.freeze({ intentId:
          "44444444-4444-4444-8444-444444444444",
        adapterConfigDigest: "a".repeat(64) });
        intents.add(intent);
        await dependencies.authorizeDispatch(intent);
        const outcome = Object.freeze({ ...adapterOutcome });
        if (outcome.status !== "undispatched") providerCalls += 1;
        if (outcome.status === "billing_unknown") unknown.add(outcome);
        else if (outcome.status === "undispatched") undispatched.add(outcome);
        else billed.add(outcome);
        return outcome;
      },
      isTrustedDispatchIntent: (value: object) => intents.has(value),
      isTrustedVerifiedBilling: (value: object) => billed.has(value),
      isTrustedBillingUnknown: (value: object) => unknown.has(value),
      isTrustedUndispatched: (value: object) => undispatched.has(value),
    };
  },
} });

const servicePromise = import(mod("lib/promptRefinerProductService.ts"));
const snapshot = Object.freeze({ requestId, userId: "owner",
  conversationId: "conversation", surface: "chat", id:
  "55555555-5555-4555-8555-555555555555", epoch: 1,
  draftId: "draft", draftRevision: 1, sourcePrompt: "authored source",
  clientRequestId: "66666666-6666-4666-8666-666666666666",
  sourceMessageId: "message", recoveryEpoch: 0 });
const timing = () => ({ requestedAt: new Date().toISOString(),
  dispatchedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
  preparationLatencyMs: 0 });
const telemetry = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5,
  reasoningTokens: 1, actualCostMicroUsd: 9 };

beforeEach(() => {
  release = { explicitEnabled: true, autoEnabled: true,
    runtimeDeploymentId: "22222222-2222-4222-8222-222222222222" };
  adapterOutcome = { ...timing(), ...telemetry, status: "suggested",
    refinedPrompt: "server suggestion" };
  reserveError = null; providerCalls = 0; reserves = 0; dispatches = 0;
  settlements = 0; unknowns = 0; releases = 0; releasedFacts = []; holds = 0;
  receiptStates = []; settlementDelayMs = 0;
  autoGuardAvailable = true; guardAdmissions = 0; auditLatches = 0;
  receiptError = false;
  adapterConstructionError = false;
  executeErrorBeforeAuthorization = false;
  dispatchIntentError = false;
  releaseError = false;
  delete process.env.PROMPT_REFINER_KILL_SWITCH;
});

test("missing release, kill switch and budget exhaustion never call provider", async () => {
  const { preparePromptRefinerProductSuggestion: prepare } = await servicePromise;
  release = { explicitEnabled: false, autoEnabled: false,
    runtimeDeploymentId: null };
  assert.equal((await prepare({ snapshot, mode: "explicit" })).reason,
    "unavailable");
  process.env.PROMPT_REFINER_KILL_SWITCH = "stop";
  release = { explicitEnabled: true, autoEnabled: true,
    runtimeDeploymentId: "22222222-2222-4222-8222-222222222222" };
  assert.equal((await prepare({ snapshot, mode: "explicit" })).reason,
    "unavailable");
  delete process.env.PROMPT_REFINER_KILL_SWITCH;
  reserveError = new BudgetError("budget_exhausted");
  assert.equal((await prepare({ snapshot, mode: "explicit" })).reason,
    "budget_exhausted");
  assert.equal(auditLatches, 0);
  reserveError = new BudgetError("reservation_authority_mismatch");
  assert.equal((await prepare({ snapshot, mode: "explicit" })).reason,
    "unavailable");
  assert.equal(auditLatches, 1);
  assert.equal(providerCalls, 0);
  assert.equal(dispatches, 0);
});

test("verified no-change settles once and falls back to authored text", async () => {
  const { preparePromptRefinerProductSuggestion: prepare } = await servicePromise;
  adapterOutcome = { ...timing(), ...telemetry, status: "invalid_response",
    reason: "no_change" };
  const result = await prepare({ snapshot, mode: "explicit" });
  assert.deepEqual(result, { outcome: "original_fallback", reason: "no_change" });
  assert.equal(reserves, 1); assert.equal(dispatches, 1);
  assert.equal(settlements, 1); assert.equal(unknowns, 0);
  assert.equal(releases, 0);
  assert.equal(holds, 0); assert.deepEqual(receiptStates, ["terminal"]);
});

test("confirmed pre-authorization failure releases once and records refusal", async () => {
  const { preparePromptRefinerProductSuggestion: prepare } = await servicePromise;
  executeErrorBeforeAuthorization = true;
  const result = await prepare({ snapshot, mode: "explicit" });
  assert.deepEqual(result, { outcome: "original_fallback",
    reason: "unavailable" });
  assert.equal(reserves, 1); assert.equal(dispatches, 0);
  assert.equal(providerCalls, 0); assert.equal(releases, 1);
  assert.equal(settlements, 0); assert.equal(unknowns, 0);
  assert.deepEqual(receiptStates, ["terminal"]);
  assert.equal(auditLatches, 0);
});

test("unknown adapter-construction release stays held and fails closed", async () => {
  const { preparePromptRefinerProductSuggestion: prepare } = await servicePromise;
  adapterConstructionError = true;
  releaseError = true;
  const result = await prepare({ snapshot, mode: "explicit" });
  assert.deepEqual(result, { outcome: "original_fallback",
    reason: "audit_unavailable" });
  assert.equal(reserves, 1); assert.equal(dispatches, 0);
  assert.equal(providerCalls, 0); assert.equal(releases, 0);
  assert.deepEqual(receiptStates, ["terminal"]);
  assert.equal(auditLatches, 1);
});

test("unknown authorization retains the full hold without provider or retry", async () => {
  const { preparePromptRefinerProductSuggestion: prepare } = await servicePromise;
  dispatchIntentError = true;
  const result = await prepare({ snapshot, mode: "explicit" });
  assert.deepEqual(result, { outcome: "original_fallback",
    reason: "unavailable" });
  assert.equal(reserves, 1); assert.equal(dispatches, 0);
  assert.equal(providerCalls, 0); assert.equal(releases, 0);
  assert.equal(settlements, 0); assert.equal(unknowns, 0);
  assert.deepEqual(receiptStates, ["terminal"]);
  assert.equal(auditLatches, 1);
});

test("unknown pre-authorization release stays held and fails closed", async () => {
  const { preparePromptRefinerProductSuggestion: prepare } = await servicePromise;
  executeErrorBeforeAuthorization = true;
  releaseError = true;
  const result = await prepare({ snapshot, mode: "explicit" });
  assert.deepEqual(result, { outcome: "original_fallback",
    reason: "audit_unavailable" });
  assert.equal(reserves, 1); assert.equal(dispatches, 0);
  assert.equal(providerCalls, 0); assert.equal(releases, 0);
  assert.deepEqual(receiptStates, ["terminal"]);
  assert.equal(auditLatches, 1);
});

test("post-authorization deadline releases the exact dispatching hold once", async () => {
  const { preparePromptRefinerProductSuggestion: prepare } = await servicePromise;
  adapterOutcome = { ...timing(), status: "undispatched", reason: "timeout",
    inputTokens: null, cachedInputTokens: null, outputTokens: null,
    reasoningTokens: null, actualCostMicroUsd: null };
  const result = await prepare({ snapshot, mode: "explicit" });
  assert.deepEqual(result, { outcome: "original_fallback", reason: "timeout" });
  assert.equal(reserves, 1); assert.equal(dispatches, 1);
  assert.equal(providerCalls, 0); assert.equal(releases, 1);
  assert.equal(settlements, 0); assert.equal(unknowns, 0); assert.equal(holds, 0);
  assert.deepEqual(receiptStates, ["terminal"]);
  assert.equal(releasedFacts.length, 1);
  assert.equal(releasedFacts[0]?.intentId,
    "44444444-4444-4444-8444-444444444444");
  assert.equal(releasedFacts[0]?.adapterConfigDigest, "a".repeat(64));
});

test("billing unknown is retained terminal-unknown and never publishes", async () => {
  const { preparePromptRefinerProductSuggestion: prepare } = await servicePromise;
  adapterOutcome = { ...timing(), status: "billing_unknown",
    reason: "response_unverified", inputTokens: null,
    cachedInputTokens: null, outputTokens: null, reasoningTokens: null,
    actualCostMicroUsd: null };
  const result = await prepare({ snapshot, mode: "auto" });
  assert.equal(result.reason, "billing_unknown");
  assert.equal(unknowns, 1); assert.equal(settlements, 0);
  assert.equal(releases, 0);
  assert.equal(holds, 0); assert.deepEqual(receiptStates, ["unknown"]);
});

test("expired preparation and late settlement cannot reserve late or publish", async () => {
  const { preparePromptRefinerProductSuggestion: prepare } = await servicePromise;
  const expired = await prepare({ snapshot, mode: "explicit",
    requestedAt: new Date(Date.now() - 20_000),
    deadlineAtMonotonicMs: performance.now() - 1 });
  assert.equal(expired.reason, "timeout");
  assert.equal(reserves, 0); assert.equal(providerCalls, 0);

  receiptStates = []; settlementDelayMs = 15;
  const late = await prepare({ snapshot, mode: "explicit",
    deadlineAtMonotonicMs: performance.now() + 5 });
  assert.equal(late.reason, "timeout");
  assert.equal(settlements, 1); assert.equal(holds, 0);
  assert.deepEqual(receiptStates, ["terminal"]);
});

test("Auto operational pause blocks dispatch and receipt audit failure latches", async () => {
  const { preparePromptRefinerProductSuggestion: prepare } = await servicePromise;
  autoGuardAvailable = false;
  const paused = await prepare({ snapshot, mode: "auto" });
  assert.deepEqual(paused, { outcome: "original_fallback", reason: "unavailable" });
  assert.equal(guardAdmissions, 1); assert.equal(reserves, 0);
  assert.equal(providerCalls, 0);

  autoGuardAvailable = true; receiptError = true;
  adapterOutcome = { ...timing(), ...telemetry, status: "invalid_response",
    reason: "invalid_response" };
  const failedAudit = await prepare({ snapshot, mode: "auto" });
  assert.deepEqual(failedAudit, { outcome: "original_fallback",
    reason: "audit_unavailable" });
  assert.equal(auditLatches, 1); assert.equal(holds, 0);
});

