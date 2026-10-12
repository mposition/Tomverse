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
import { promptRefinerChatExecutionAdmission } from
  "@/lib/promptRefinerChatExecutionRelease";
import { writePromptRefinerProductExecutionReceipt } from
  "@/lib/promptRefinerProductReceiptStore";
import {
  latchPromptRefinerProductAutoAuditFailure,
  requirePromptRefinerProductAutoAdmission,
} from "@/lib/promptRefinerProductOperationalGuard";
import {
  PROMPT_REFINER_EXECUTION_RECEIPT_VERSION,
  type PromptRefinerFailureCode,
  type PromptRefinerFailureLayer,
} from "@/lib/promptRefinerReceiptCore";
import { readPromptRefinerVnextOneShotPrice } from
  "@/lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback";
import { PROMPT_REFINER_VNEXT_PRICE_PIN } from
  "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";
import { PROMPT_REFINER_VERSION } from "@/lib/promptRefinerSuggestion";

export type GuestPromptRefinerResult = Readonly<
  | { outcome: "refined"; refinedPrompt: string; executionReceiptId: string }
  | { outcome: "original_fallback"; reason: PromptRefinerProductFallbackReason;
      billingUnknown: boolean; executionReceiptId: string | null }
>;

const fallback = (reason: PromptRefinerProductFallbackReason,
  billingUnknown = false, executionReceiptId: string | null = null):
  GuestPromptRefinerResult => Object.freeze({ outcome: "original_fallback",
    reason, billingUnknown, executionReceiptId });

const assertCurrentPrice = async () => {
  await prisma.$transaction(async (tx) => {
    const price = await readPromptRefinerVnextOneShotPrice(tx);
    if (!price.pricePinMatchesRegistry || price.problems.length !== 0) {
      throw new Error("prompt_refiner_guest_product_price_drift");
    }
  }, { maxWait: 2_000, timeout: 5_000 });
};

const latchAuditFailure = async () => {
  try { await latchPromptRefinerProductAutoAuditFailure(); }
  catch { /* This request remains refused if the latch cannot be persisted. */ }
};

const receiptBase = (requestId: string) => ({
  receiptVersion: PROMPT_REFINER_EXECUTION_RECEIPT_VERSION,
  receiptId: randomUUID(), requestId, suggestionId: null,
  refinerVersion: PROMPT_REFINER_VERSION, retryCount: 0 as const,
});

const refusalReceipt = (requestId: string, code: PromptRefinerFailureCode,
  layer: PromptRefinerFailureLayer,
  timing?: Readonly<{ requestedAt: string; completedAt: string;
    preparationLatencyMs: number }>) => {
  const now = new Date().toISOString();
  return { ...receiptBase(requestId), provider: null, modelId: null,
    adapterVersion: null, outcome: "refused_before_dispatch" as const,
    failureLayer: layer, failureCode: code,
    requestedAt: timing?.requestedAt ?? now, dispatchedAt: null,
    completedAt: timing?.completedAt ?? now,
    preparationLatencyMs: timing?.preparationLatencyMs ?? 0,
    inputTokens: null, cachedInputTokens: null, outputTokens: null,
    reasoningTokens: null, actualCostMicroUsd: null };
};

const failedReceipt = (requestId: string,
  outcome: PromptRefinerProductAdapterOutcome,
  code: PromptRefinerFailureCode, layer: PromptRefinerFailureLayer) => ({
  ...receiptBase(requestId), provider: PROMPT_REFINER_VNEXT_PRICE_PIN.provider,
  modelId: PROMPT_REFINER_VNEXT_PRICE_PIN.modelId,
  adapterVersion: PROMPT_REFINER_PRODUCT_ADAPTER_VERSION,
  outcome: "failed" as const, failureLayer: layer, failureCode: code,
  requestedAt: outcome.requestedAt, dispatchedAt: outcome.dispatchedAt,
  completedAt: outcome.completedAt,
  preparationLatencyMs: outcome.preparationLatencyMs,
  inputTokens: outcome.inputTokens, cachedInputTokens: outcome.cachedInputTokens,
  outputTokens: outcome.outputTokens, reasoningTokens: outcome.reasoningTokens,
  actualCostMicroUsd: outcome.actualCostMicroUsd });

const successReceipt = (requestId: string,
  outcome: Extract<PromptRefinerProductAdapterOutcome,
    { status: "suggested" }>) => ({
  ...receiptBase(requestId), suggestionId: randomUUID(),
  provider: PROMPT_REFINER_VNEXT_PRICE_PIN.provider,
  modelId: PROMPT_REFINER_VNEXT_PRICE_PIN.modelId,
  adapterVersion: PROMPT_REFINER_PRODUCT_ADAPTER_VERSION,
  outcome: "suggested" as const, failureLayer: "none" as const,
  failureCode: null, requestedAt: outcome.requestedAt,
  dispatchedAt: outcome.dispatchedAt, completedAt: outcome.completedAt,
  preparationLatencyMs: outcome.preparationLatencyMs,
  inputTokens: outcome.inputTokens, cachedInputTokens: outcome.cachedInputTokens,
  outputTokens: outcome.outputTokens, reasoningTokens: outcome.reasoningTokens,
  actualCostMicroUsd: outcome.actualCostMicroUsd });

const recordReceipt = async (value: unknown) => {
  try {
    return await prisma.$transaction((tx) =>
      writePromptRefinerProductExecutionReceipt(tx, value, "auto"),
    { maxWait: 2_000, timeout: 5_000 });
  } catch {
    await latchAuditFailure();
    return null;
  }
};

/**
 * Runs one request-memory-only Prompt Refiner attempt for one verified Guest
 * authority. No raw or refined prompt is written to a product table.
 */
export async function refineGuestChatPrompt(input: Readonly<{
  authorityId: string;
  sourcePrompt: string;
  requestedAt?: Date;
  deadlineAtMonotonicMs?: number;
}>): Promise<GuestPromptRefinerResult> {
  const requestedAt = input.requestedAt ?? new Date();
  const started = performance.now();
  const deadlineAt = Math.min(input.deadlineAtMonotonicMs ??
    started + PROMPT_REFINER_PRODUCT_TIMEOUT_MS,
  started + PROMPT_REFINER_PRODUCT_TIMEOUT_MS);
  const timing = () => {
    const completed = new Date();
    return { requestedAt: requestedAt.toISOString(),
      completedAt: completed.toISOString(),
      preparationLatencyMs: Math.max(0,
        completed.getTime() - requestedAt.getTime()) };
  };
  if (promptRefinerKillSwitchEngaged(process.env)) return fallback("unavailable");
  const release = await promptRefinerChatExecutionAdmission();
  if (!release.autoEnabled || !release.runtimeDeploymentId) {
    return fallback("unavailable");
  }
  try { await requirePromptRefinerProductAutoAdmission(); }
  catch { return fallback("unavailable"); }

  if (performance.now() >= deadlineAt) {
    const recorded = await recordReceipt(refusalReceipt(input.authorityId,
      "cancelled", "admission", timing()));
    return fallback(recorded ? "timeout" : "audit_unavailable", false,
      recorded?.receiptId ?? null);
  }

  let model;
  try {
    await assertCurrentPrice();
    model = await getEnabledRuntimeModel(PROMPT_REFINER_VNEXT_PRICE_PIN.modelId);
    if (!model || model.provider !== PROMPT_REFINER_VNEXT_PRICE_PIN.provider ||
        model.apiModel !== PROMPT_REFINER_VNEXT_PRICE_PIN.apiModelId) {
      throw new Error("prompt_refiner_guest_product_model_drift");
    }
  } catch {
    const recorded = await recordReceipt(refusalReceipt(input.authorityId,
      "execution_contract_mismatch", "admission"));
    return fallback(recorded ? "unavailable" : "audit_unavailable", false,
      recorded?.receiptId ?? null);
  }

  let hold;
  try {
    hold = await reservePromptRefinerAutoBudget({ requestKey: input.authorityId,
      candidateDigest: PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST,
      pricePinDigest: PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
      runtimeDeploymentId: release.runtimeDeploymentId });
  } catch (error) {
    const exhausted = error instanceof PromptRefinerAutoBudgetError &&
      error.code === "budget_exhausted";
    if (!exhausted) await latchAuditFailure();
    const recorded = await recordReceipt(refusalReceipt(input.authorityId,
      "execution_not_approved", "admission"));
    return fallback(recorded
      ? (exhausted ? "budget_exhausted" : "unavailable")
      : "audit_unavailable", false, recorded?.receiptId ?? null);
  }

  const binding: PromptRefinerAutoBudgetBinding = Object.freeze({
    holdId: hold.id, requestKey: input.authorityId,
    candidateDigest: PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST,
    pricePinDigest: PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
    runtimeDeploymentId: release.runtimeDeploymentId,
  });
  let adapter: ReturnType<typeof createPromptRefinerProductAdapter> | null = null;
  let currentIntent: PromptRefinerProductDispatchIntent | null = null;
  let recordedDispatch: Readonly<{ holdId: string; status: "dispatching";
    intentId: string; adapterConfigDigest: string;
    dispatchAuditLogId: string }> | null = null;
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
      generate: (options) => generateText(options as never), languageModel,
      requestedAt, deadlineAtMonotonicMs: deadlineAt,
      authorizeDispatch: async (intent) => {
        await assertCurrentPrice();
        currentIntent = intent;
        recordedDispatch = await authority.recordDispatchIntent(intent);
      },
    });
  } catch {
    const proof: UndispatchedRaw = Object.freeze({ proofId: randomUUID(),
      intent: null });
    undispatched.add(proof);
    try { await authority.releaseConfirmedUndispatched(proof); }
    catch { await latchAuditFailure(); }
    const recorded = await recordReceipt(refusalReceipt(input.authorityId,
      "adapter_unavailable", "adapter"));
    return fallback(recorded ? "unavailable" : "audit_unavailable", false,
      recorded?.receiptId ?? null);
  }

  let outcome: PromptRefinerProductAdapterOutcome;
  try {
    outcome = await adapter.execute({ requestId: input.authorityId,
      sourceText: input.sourcePrompt });
  } catch {
    if (currentIntent === null) {
      const proof: UndispatchedRaw = Object.freeze({ proofId: randomUUID(),
        intent: null });
      undispatched.add(proof);
      try { await authority.releaseConfirmedUndispatched(proof); }
      catch { await latchAuditFailure(); }
      const recorded = await recordReceipt(refusalReceipt(input.authorityId,
        "adapter_unavailable", "adapter"));
      return fallback(recorded ? "unavailable" : "audit_unavailable", false,
        recorded?.receiptId ?? null);
    }
    if (recordedDispatch === null) {
      await latchAuditFailure();
      const recorded = await recordReceipt(refusalReceipt(input.authorityId,
        "execution_not_approved", "admission"));
      return fallback(recorded ? "unavailable" : "audit_unavailable", true,
        recorded?.receiptId ?? null);
    }
    try {
      const retained = await authority.retainUnknownAfterRecordedDispatch(
        recordedDispatch);
      const unknown = Object.freeze({ status: "billing_unknown" as const,
        reason: "response_unverified" as const,
        requestedAt: requestedAt.toISOString(),
        dispatchedAt: retained.dispatchedAt.toISOString(),
        completedAt: retained.unknownAt.toISOString(),
        preparationLatencyMs: Math.max(0,
          retained.unknownAt.getTime() - requestedAt.getTime()),
        inputTokens: null, cachedInputTokens: null, outputTokens: null,
        reasoningTokens: null, actualCostMicroUsd: null });
      const recorded = await recordReceipt(failedReceipt(input.authorityId,
        unknown, "unknown_after_dispatch", "provider"));
      return fallback(recorded ? "billing_unknown" : "audit_unavailable", true,
        recorded?.receiptId ?? null);
    } catch {
      await latchAuditFailure();
      return fallback("audit_unavailable", true);
    }
  }

  if (outcome.status === "undispatched") {
    const proof: UndispatchedRaw = Object.freeze({ proofId: randomUUID(),
      intent: currentIntent, outcome });
    undispatched.add(proof);
    try { await authority.releaseConfirmedUndispatched(proof); }
    catch { await latchAuditFailure(); }
    const recorded = await recordReceipt(refusalReceipt(input.authorityId,
      "cancelled", "admission", outcome));
    return fallback(recorded ? "timeout" : "audit_unavailable", false,
      recorded?.receiptId ?? null);
  }
  if (!currentIntent) {
    const recorded = await recordReceipt(failedReceipt(input.authorityId,
      outcome, "unknown_after_dispatch", "provider"));
    return fallback(recorded ? "billing_unknown" : "audit_unavailable", true,
      recorded?.receiptId ?? null);
  }
  const observation = Object.freeze({ intent: currentIntent, outcome,
    observationId: randomUUID() });
  if (outcome.status === "billing_unknown") {
    try { await authority.retainUnknown(observation); } catch { /* retain hold */ }
    const code = outcome.reason === "timeout" ? "timeout" :
      outcome.reason === "provider_error" ? "provider_error" :
      "unknown_after_dispatch";
    const recorded = await recordReceipt(failedReceipt(input.authorityId,
      outcome, code, "provider"));
    const reason = outcome.reason === "timeout" ? "timeout" :
      outcome.reason === "provider_error" ? "provider_error" : "billing_unknown";
    return fallback(recorded ? reason : "audit_unavailable", true,
      recorded?.receiptId ?? null);
  }
  try { await authority.settleVerifiedBilled(observation); }
  catch {
    const recorded = await recordReceipt(failedReceipt(input.authorityId,
      outcome, "unknown_after_dispatch", "provider"));
    return fallback(recorded ? "billing_unknown" : "audit_unavailable", true,
      recorded?.receiptId ?? null);
  }
  if (outcome.status !== "suggested") {
    const code = outcome.status === "invalid_response" && outcome.reason === "no_change"
      ? "no_change" : "invalid_response";
    const recorded = await recordReceipt(failedReceipt(input.authorityId,
      outcome, code, "response_validation"));
    const reason = outcome.status === "abstained" ? "abstained" :
      outcome.reason === "no_change" ? "no_change" : "invalid_response";
    return fallback(recorded ? reason : "audit_unavailable", false,
      recorded?.receiptId ?? null);
  }
  const recorded = await recordReceipt(successReceipt(input.authorityId, outcome));
  if (!recorded) return fallback("audit_unavailable", false);
  return Object.freeze({ outcome: "refined", refinedPrompt: outcome.refinedPrompt,
    executionReceiptId: recorded.receiptId });
}
