import "server-only";

import { randomUUID } from "node:crypto";
import { generateText } from "ai";

import { getActiveAiModel } from "@/lib/activeAiModel";
import { promptRefinerKillSwitchEngaged } from "@/lib/promptRefinerAccess";
import {
  createPromptRefinerAutoBudgetTransitionAuthority,
  PromptRefinerAutoBudgetError,
  reservePromptRefinerAutoBudget,
  type PromptRefinerAutoBudgetBinding,
} from "@/lib/promptRefinerAutoBudgetHold";
import {
  claimPromptRefinerProductAttempt,
  holdPromptRefinerProductChatSuggestion,
  isPromptRefinerCapturedChatDraft,
  type PromptRefinerCapturedChatDraft,
} from "@/lib/promptRefinerChatExecutionStore";
import { getEnabledRuntimeModel } from "@/lib/modelRegistry";
import { prisma } from "@/lib/prisma";
import {
  createPromptRefinerProductAdapter,
  type PromptRefinerProductAdapterOutcome,
  type PromptRefinerProductDispatchIntent,
} from "@/lib/promptRefinerProductAdapter";
import {
  PROMPT_REFINER_PRODUCT_ADAPTER_VERSION,
  PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST,
  PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
  PROMPT_REFINER_PRODUCT_TIMEOUT_MS,
  type PromptRefinerProductFallbackReason,
} from "@/lib/promptRefinerProductContract";
import { promptRefinerChatExecutionRelease } from
  "@/lib/promptRefinerChatExecutionRelease";
import {
  recordPromptRefinerProductExecutionReceipt,
} from "@/lib/promptRefinerProductReceiptStore";
import { latchPromptRefinerProductAutoAuditFailure,
  requirePromptRefinerProductAutoAdmission } from
  "@/lib/promptRefinerProductOperationalGuard";
import {
  PROMPT_REFINER_EXECUTION_RECEIPT_VERSION,
  type PromptRefinerFailureCode,
  type PromptRefinerFailureLayer,
} from "@/lib/promptRefinerReceiptCore";
import { readPromptRefinerVnextOneShotPrice } from
  "@/lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback";
import {
  PROMPT_REFINER_VNEXT_PRICE_PIN,
} from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";
import {
  PROMPT_REFINER_INPUT_SCOPE,
  PROMPT_REFINER_VERSION,
} from "@/lib/promptRefinerSuggestion";

type Mode = "explicit" | "auto";
type ProductHeld = Readonly<{
  requestId: string;
  suggestionId: string;
  refinedPrompt: string;
  refinerVersion: string;
  inputScope: "current_user_turn_text_only";
  scopeId: string;
  epoch: number;
  clientRequestId: string;
  executionReceiptId: string | null;
}>;
type ProductResult =
  | Readonly<{ outcome: "held"; held: ProductHeld }>
  | Readonly<{ outcome: "original_fallback";
      reason: PromptRefinerProductFallbackReason }>;

const fallback = (reason: PromptRefinerProductFallbackReason): ProductResult =>
  Object.freeze({ outcome: "original_fallback", reason });

const assertCurrentPrice = async () => {
  await prisma.$transaction(async (tx) => {
    const price = await readPromptRefinerVnextOneShotPrice(tx);
    if (!price.pricePinMatchesRegistry || price.problems.length !== 0) {
      throw new Error("prompt_refiner_product_price_drift");
    }
  }, { maxWait: 2_000, timeout: 5_000 });
};

const refusalReceipt = (snapshot: PromptRefinerCapturedChatDraft,
  code: PromptRefinerFailureCode, layer: PromptRefinerFailureLayer,
  timing?: Readonly<{ requestedAt: string; completedAt: string;
    preparationLatencyMs: number }>) => {
  const now = new Date().toISOString();
  return {
    receiptVersion: PROMPT_REFINER_EXECUTION_RECEIPT_VERSION,
    receiptId: randomUUID(), requestId: snapshot.requestId, suggestionId: null,
    refinerVersion: PROMPT_REFINER_VERSION,
    provider: null, modelId: null, adapterVersion: null,
    outcome: "refused_before_dispatch" as const,
    failureLayer: layer, failureCode: code,
    requestedAt: timing?.requestedAt ?? now, dispatchedAt: null,
    completedAt: timing?.completedAt ?? now,
    preparationLatencyMs: timing?.preparationLatencyMs ?? 0,
    inputTokens: null, cachedInputTokens: null, outputTokens: null,
    reasoningTokens: null, actualCostMicroUsd: null, retryCount: 0 as const,
  };
};

const failedReceipt = (snapshot: PromptRefinerCapturedChatDraft,
  outcome: PromptRefinerProductAdapterOutcome,
  code: PromptRefinerFailureCode, layer: PromptRefinerFailureLayer) => ({
  receiptVersion: PROMPT_REFINER_EXECUTION_RECEIPT_VERSION,
  receiptId: randomUUID(), requestId: snapshot.requestId, suggestionId: null,
  refinerVersion: PROMPT_REFINER_VERSION,
  provider: PROMPT_REFINER_VNEXT_PRICE_PIN.provider,
  modelId: PROMPT_REFINER_VNEXT_PRICE_PIN.modelId,
  adapterVersion: PROMPT_REFINER_PRODUCT_ADAPTER_VERSION,
  outcome: "failed" as const, failureLayer: layer, failureCode: code,
  requestedAt: outcome.requestedAt, dispatchedAt: outcome.dispatchedAt,
  completedAt: outcome.completedAt,
  preparationLatencyMs: outcome.preparationLatencyMs,
  inputTokens: outcome.inputTokens, cachedInputTokens: outcome.cachedInputTokens,
  outputTokens: outcome.outputTokens, reasoningTokens: outcome.reasoningTokens,
  actualCostMicroUsd: outcome.actualCostMicroUsd, retryCount: 0 as const,
});

const latchProductAutoAuditFailure = async () => {
  try { await latchPromptRefinerProductAutoAuditFailure(); }
  catch { /* The request remains refused; a DB outage cannot persist a latch. */ }
};

const successFacts = (outcome: Extract<PromptRefinerProductAdapterOutcome,
  { status: "suggested" }>) => ({
  receiptVersion: PROMPT_REFINER_EXECUTION_RECEIPT_VERSION,
  refinerVersion: PROMPT_REFINER_VERSION,
  provider: PROMPT_REFINER_VNEXT_PRICE_PIN.provider,
  modelId: PROMPT_REFINER_VNEXT_PRICE_PIN.modelId,
  adapterVersion: PROMPT_REFINER_PRODUCT_ADAPTER_VERSION,
  outcome: "suggested" as const, failureLayer: "none" as const,
  failureCode: null,
  requestedAt: outcome.requestedAt, dispatchedAt: outcome.dispatchedAt,
  completedAt: outcome.completedAt,
  preparationLatencyMs: outcome.preparationLatencyMs,
  inputTokens: outcome.inputTokens, cachedInputTokens: outcome.cachedInputTokens,
  outputTokens: outcome.outputTokens, reasoningTokens: outcome.reasoningTokens,
  actualCostMicroUsd: outcome.actualCostMicroUsd, retryCount: 0 as const,
});

const recordRefusal = async (snapshot: PromptRefinerCapturedChatDraft,
  mode: Mode, code: PromptRefinerFailureCode,
  layer: PromptRefinerFailureLayer,
  timing?: Readonly<{ requestedAt: string; completedAt: string;
    preparationLatencyMs: number }>) => {
  try {
    await recordPromptRefinerProductExecutionReceipt(
      refusalReceipt(snapshot, code, layer, timing), mode);
    return true;
  } catch {
    await latchProductAutoAuditFailure();
    return false;
  }
};

const recordFailure = async (snapshot: PromptRefinerCapturedChatDraft,
  mode: Mode, outcome: PromptRefinerProductAdapterOutcome,
  code: PromptRefinerFailureCode, layer: PromptRefinerFailureLayer,
  attemptState: "terminal" | "unknown" = "terminal") => {
  try {
    await recordPromptRefinerProductExecutionReceipt(
      failedReceipt(snapshot, outcome, code, layer), mode, attemptState);
    return true;
  } catch {
    await latchProductAutoAuditFailure();
    return false;
  }
};

/**
 * One paid attempt for one server-captured draft. No caller text, model id,
 * boolean approval or execution prompt is accepted here.
 */
export async function preparePromptRefinerProductSuggestion(input: {
  snapshot: PromptRefinerCapturedChatDraft;
  mode: Mode;
  requestedAt?: Date;
  deadlineAtMonotonicMs?: number;
}): Promise<ProductResult> {
  const requestedAt = input.requestedAt ?? new Date();
  const deadlineAtMonotonicMs = Math.min(
    input.deadlineAtMonotonicMs ??
      performance.now() + PROMPT_REFINER_PRODUCT_TIMEOUT_MS,
    performance.now() + PROMPT_REFINER_PRODUCT_TIMEOUT_MS,
  );
  const requestTiming = () => {
    const completed = new Date();
    return { requestedAt: requestedAt.toISOString(),
      completedAt: completed.toISOString(),
      preparationLatencyMs: Math.max(0,
        completed.getTime() - requestedAt.getTime()) };
  };
  if (!isPromptRefinerCapturedChatDraft(input.snapshot) ||
      input.snapshot.surface !== "chat") return fallback("stale");
  // The kill switch is the first product boundary. It performs no release,
  // price, budget or provider read and cannot leave a partial reservation.
  if (promptRefinerKillSwitchEngaged(process.env)) return fallback("unavailable");
  const release = await promptRefinerChatExecutionRelease();
  if ((input.mode === "explicit" ? !release.explicitEnabled : !release.autoEnabled) ||
      !release.runtimeDeploymentId) return fallback("unavailable");
  if (input.mode === "auto") {
    try { await requirePromptRefinerProductAutoAdmission(); }
    catch { return fallback("unavailable"); }
  }

  let model;
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: input.snapshot.conversationId,
        userId: input.snapshot.userId, kind: "chat", productKey: "chat" },
      select: { selectionMode: true },
    });
    if (!conversation || (input.mode === "auto" &&
        conversation.selectionMode !== "auto")) {
      throw new Error("prompt_refiner_product_conversation_scope_changed");
    }
  } catch {
    return fallback("stale");
  }
  const attempt = await claimPromptRefinerProductAttempt(input);
  if (attempt.outcome === "replay") {
    return Object.freeze({ outcome: "held", held: attempt.held });
  }
  if (attempt.outcome !== "claimed") return fallback("stale");
  if (performance.now() >= deadlineAtMonotonicMs) {
    return await recordRefusal(input.snapshot, input.mode,
      "cancelled", "admission", requestTiming())
      ? fallback("timeout") : fallback("audit_unavailable");
  }
  try {
    await assertCurrentPrice();
    model = await getEnabledRuntimeModel(PROMPT_REFINER_VNEXT_PRICE_PIN.modelId);
    if (!model || model.provider !== PROMPT_REFINER_VNEXT_PRICE_PIN.provider ||
        model.apiModel !== PROMPT_REFINER_VNEXT_PRICE_PIN.apiModelId) {
      throw new Error("prompt_refiner_product_model_drift");
    }
  } catch {
    return await recordRefusal(input.snapshot, input.mode,
      "execution_contract_mismatch", "admission")
      ? fallback("unavailable") : fallback("audit_unavailable");
  }
  if (performance.now() >= deadlineAtMonotonicMs) {
    return await recordRefusal(input.snapshot, input.mode,
      "cancelled", "admission", requestTiming())
      ? fallback("timeout") : fallback("audit_unavailable");
  }

  let hold;
  try {
    hold = await reservePromptRefinerAutoBudget({
      requestKey: input.snapshot.requestId,
      candidateDigest: PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST,
      pricePinDigest: PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
      runtimeDeploymentId: release.runtimeDeploymentId,
    });
  } catch (error) {
    const exhausted = error instanceof PromptRefinerAutoBudgetError &&
      error.code === "budget_exhausted";
    if (!exhausted) await latchProductAutoAuditFailure();
    const recorded = await recordRefusal(input.snapshot, input.mode,
      "execution_not_approved", "admission");
    return recorded ? fallback(exhausted ? "budget_exhausted" : "unavailable")
      : fallback("audit_unavailable");
  }
  const binding: PromptRefinerAutoBudgetBinding = Object.freeze({
    holdId: hold.id, requestKey: input.snapshot.requestId,
    candidateDigest: PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST,
    pricePinDigest: PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
    runtimeDeploymentId: release.runtimeDeploymentId,
  });
  let adapter: ReturnType<typeof createPromptRefinerProductAdapter> | null = null;
  let currentIntent: PromptRefinerProductDispatchIntent | null = null;
  const undispatched = new WeakSet<object>();
  type BilledRaw = { intent: PromptRefinerProductDispatchIntent;
    outcome: PromptRefinerProductAdapterOutcome; observationId: string };
  type UndispatchedRaw = { proofId: string;
    intent: PromptRefinerProductDispatchIntent | null;
    outcome?: PromptRefinerProductAdapterOutcome };
  const authority = createPromptRefinerAutoBudgetTransitionAuthority({
    verifyDispatchIntent: async (intent: PromptRefinerProductDispatchIntent) => {
      if (!adapter?.isTrustedDispatchIntent(intent)) throw new Error("intent_untrusted");
      return { binding, intentId: intent.intentId,
        adapterConfigDigest: intent.adapterConfigDigest };
    },
    verifyVerifiedBilling: async (raw: BilledRaw) => {
      if (!adapter?.isTrustedDispatchIntent(raw.intent) ||
          !adapter.isTrustedVerifiedBilling(raw.outcome) ||
          raw.outcome.actualCostMicroUsd === null) throw new Error("billing_untrusted");
      return { kind: "verified_billed" as const, binding,
        intentId: raw.intent.intentId,
        adapterConfigDigest: raw.intent.adapterConfigDigest,
        observationId: raw.observationId,
        billedMicroUsd: BigInt(raw.outcome.actualCostMicroUsd) };
    },
    verifyBillingUnknown: async (raw: BilledRaw) => {
      if (!adapter?.isTrustedDispatchIntent(raw.intent) ||
          !adapter.isTrustedBillingUnknown(raw.outcome)) throw new Error("unknown_untrusted");
      return { kind: "billing_unknown" as const, binding,
        intentId: raw.intent.intentId,
        adapterConfigDigest: raw.intent.adapterConfigDigest,
        observationId: raw.observationId };
    },
    verifyUndispatched: async (raw: UndispatchedRaw) => {
      if (!undispatched.has(raw) || (raw.outcome !== undefined &&
          !adapter?.isTrustedUndispatched(raw.outcome))) {
        throw new Error("undispatched_untrusted");
      }
      return { kind: "confirmed_undispatched" as const, binding,
        proofId: raw.proofId, intentId: raw.intent?.intentId ?? null,
        adapterConfigDigest: raw.intent?.adapterConfigDigest ?? null };
    },
  });

  try {
    const languageModel = getActiveAiModel(model);
    adapter = createPromptRefinerProductAdapter({
      generate: (options) => generateText(options as never),
      languageModel,
      requestedAt,
      deadlineAtMonotonicMs,
      authorizeDispatch: async (intent) => {
        // Recheck the live registry immediately before durable intent. The
        // adapter cannot call generateText until this promise succeeds.
        await assertCurrentPrice();
        currentIntent = intent;
        await authority.recordDispatchIntent(intent);
      },
    });
  } catch {
    const proof: UndispatchedRaw = Object.freeze({ proofId: randomUUID(),
      intent: null });
    undispatched.add(proof);
    let released = false;
    try {
      await authority.releaseConfirmedUndispatched(proof);
      released = true;
    }
    catch { await latchProductAutoAuditFailure(); }
    const recorded = await recordRefusal(input.snapshot, input.mode,
      "adapter_unavailable", "adapter");
    return recorded && released ? fallback("unavailable") :
      fallback("audit_unavailable");
  }

  let outcome: PromptRefinerProductAdapterOutcome;
  try {
    if (!adapter) throw new Error("prompt_refiner_product_adapter_unavailable");
    outcome = await adapter.execute({ requestId: input.snapshot.requestId,
      sourceText: input.snapshot.sourcePrompt });
  } catch {
    // Until the service marks the trusted intent immediately before its DB
    // transition, neither a durable intent nor a provider call can exist, so
    // the reserved hold can be released through the closure-owned proof.
    // Once marked, the transition result may be unknown: retain the full hold
    // and never retry.
    let releasedOrRetained = currentIntent !== null;
    if (currentIntent === null) {
      const proof: UndispatchedRaw = Object.freeze({ proofId: randomUUID(),
        intent: null });
      undispatched.add(proof);
      try {
        await authority.releaseConfirmedUndispatched(proof);
        releasedOrRetained = true;
      } catch {
        await latchProductAutoAuditFailure();
      }
    } else {
      await latchProductAutoAuditFailure();
    }
    const recorded = await recordRefusal(input.snapshot, input.mode,
      currentIntent === null ? "adapter_unavailable" :
        "execution_not_approved",
      currentIntent === null ? "adapter" : "admission");
    return recorded && releasedOrRetained ? fallback("unavailable") :
      fallback("audit_unavailable");
  }
  if (outcome.status === "undispatched") {
    const proof: UndispatchedRaw = Object.freeze({ proofId: randomUUID(),
      intent: currentIntent, outcome });
    undispatched.add(proof);
    let released = false;
    try {
      await authority.releaseConfirmedUndispatched(proof);
      released = true;
    } catch { await latchProductAutoAuditFailure(); }
    const recorded = await recordRefusal(input.snapshot, input.mode,
      "cancelled", "admission", outcome);
    return recorded && released ? fallback("timeout") :
      fallback("audit_unavailable");
  }
  if (!currentIntent) {
    return await recordFailure(input.snapshot, input.mode, outcome,
      "unknown_after_dispatch", "provider")
      ? fallback("billing_unknown") : fallback("audit_unavailable");
  }
  const observation = Object.freeze({ intent: currentIntent, outcome,
    observationId: randomUUID() });
  if (outcome.status === "billing_unknown") {
    try { await authority.retainUnknown(observation); } catch { /* retain hold */ }
    const code = outcome.reason === "timeout" ? "timeout" :
      outcome.reason === "provider_error" ? "provider_error" :
      "unknown_after_dispatch";
    const recorded = await recordFailure(input.snapshot, input.mode, outcome,
      code, "provider", "unknown");
    const reason = outcome.reason === "timeout" ? "timeout" :
      outcome.reason === "provider_error" ? "provider_error" : "billing_unknown";
    return recorded ? fallback(reason) : fallback("audit_unavailable");
  }
  try {
    await authority.settleVerifiedBilled(observation);
  } catch {
    const recorded = await recordFailure(input.snapshot, input.mode, outcome,
      "unknown_after_dispatch", "provider", "unknown");
    return recorded ? fallback("billing_unknown") : fallback("audit_unavailable");
  }
  if (outcome.status !== "suggested") {
    const code = outcome.status === "invalid_response" && outcome.reason === "no_change"
      ? "no_change" : "invalid_response";
    const recorded = await recordFailure(input.snapshot, input.mode, outcome,
      code, "response_validation");
    const reason = outcome.status === "abstained" ? "abstained" :
      outcome.reason === "no_change" ? "no_change" : "invalid_response";
    return recorded ? fallback(reason) : fallback("audit_unavailable");
  }
  if (performance.now() >= deadlineAtMonotonicMs) {
    const timing = requestTiming();
    const late = { ...outcome, completedAt: timing.completedAt,
      preparationLatencyMs: timing.preparationLatencyMs };
    const recorded = await recordFailure(input.snapshot, input.mode, late,
      "cancelled", "provider");
    return recorded ? fallback("timeout") : fallback("audit_unavailable");
  }
  try {
    const held = await holdPromptRefinerProductChatSuggestion({
      snapshot: input.snapshot, mode: input.mode,
      response: { requestId: input.snapshot.requestId,
        suggestionId: randomUUID(), refinedPrompt: outcome.refinedPrompt,
        refinerVersion: PROMPT_REFINER_VERSION,
        inputScope: PROMPT_REFINER_INPUT_SCOPE },
      executionReceipt: successFacts(outcome),
      deadlineAtMonotonicMs,
    });
    return Object.freeze({ outcome: "held", held });
  } catch {
    const expired = performance.now() >= deadlineAtMonotonicMs;
    const timing = expired ? requestTiming() : null;
    const finalOutcome = timing ? { ...outcome,
      completedAt: timing.completedAt,
      preparationLatencyMs: timing.preparationLatencyMs } : outcome;
    const recorded = await recordFailure(input.snapshot, input.mode,
      finalOutcome, "cancelled", "provider");
    return recorded ? fallback(expired ? "timeout" : "stale") :
      fallback("audit_unavailable");
  }
}

