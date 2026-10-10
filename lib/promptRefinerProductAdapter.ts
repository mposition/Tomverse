import "server-only";

import { randomUUID } from "node:crypto";

import { getEnabledModel } from "@/lib/models";
import {
  PROMPT_REFINER_PRODUCT_ADAPTER_CONFIG_DIGEST,
  PROMPT_REFINER_PRODUCT_ADAPTER_VERSION,
  PROMPT_REFINER_PRODUCT_TIMEOUT_MS,
} from "@/lib/promptRefinerProductContract";
import {
  promptRefinerVnextCandidateMessages,
} from "@/lib/promptRefinerQualityEvaluationVnextCandidate";
import {
  parsePromptRefinerVnextModelOutput,
} from "@/lib/promptRefinerQualityEvaluationVnextCore";
import {
  guardPromptRefinerVnextBilledUsage,
  PROMPT_REFINER_VNEXT_MAX_INPUT_TOKENS,
  PROMPT_REFINER_VNEXT_MAX_OUTPUT_TOKENS,
  PROMPT_REFINER_VNEXT_PRICE_PIN,
} from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";

type Generate = (options: Record<string, unknown>) => Promise<unknown>;
type Schedule = (callback: () => void, delayMs: number) => unknown;
type Cancel = (handle: unknown) => void;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FRAMING_BYTES = 128;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

export type PromptRefinerProductDispatchIntent = Readonly<{
  intentId: string;
  adapterConfigDigest: string;
}>;

type Usage = Readonly<{
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  actualCostMicroUsd: number;
}>;

type Timing = Readonly<{
  requestedAt: string;
  dispatchedAt: string;
  completedAt: string;
  preparationLatencyMs: number;
}>;

type UndispatchedTiming = Readonly<{
  requestedAt: string;
  dispatchedAt: null;
  completedAt: string;
  preparationLatencyMs: number;
}>;

export type PromptRefinerProductAdapterOutcome =
  | (UndispatchedTiming & Readonly<{
      status: "undispatched";
      reason: "timeout";
      inputTokens: null;
      cachedInputTokens: null;
      outputTokens: null;
      reasoningTokens: null;
      actualCostMicroUsd: null;
    }>)
  | (Timing & Usage & Readonly<{ status: "suggested"; refinedPrompt: string }>)
  | (Timing & Usage & Readonly<{ status: "abstained" }>)
  | (Timing & Usage & Readonly<{
      status: "invalid_response";
      reason: "invalid_response" | "no_change";
    }>)
  | (Timing & Readonly<{
      status: "billing_unknown";
      reason: "timeout" | "provider_error" | "response_unverified";
      inputTokens: null;
      cachedInputTokens: null;
      outputTokens: null;
      reasoningTokens: null;
      actualCostMicroUsd: null;
    }>);

export class PromptRefinerProductAdapterError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PromptRefinerProductAdapterError";
  }
}

/**
 * The caller supplies one server authority that durably records the dispatch
 * intent before this closure can call the provider. Returned intent/billing
 * objects are WeakSet branded; freezing caller-shaped JSON is not authority.
 */
export function createPromptRefinerProductAdapter(dependencies: {
  generate: Generate;
  languageModel: unknown;
  authorizeDispatch: (intent: PromptRefinerProductDispatchIntent) => Promise<void>;
  now?: () => number;
  wallClock?: () => Date;
  requestedAt?: Date;
  deadlineAtMonotonicMs?: number;
  scheduleTimeout?: Schedule;
  cancelTimeout?: Cancel;
}) {
  const model = getEnabledModel(PROMPT_REFINER_VNEXT_PRICE_PIN.modelId);
  if (!model || model.provider !== PROMPT_REFINER_VNEXT_PRICE_PIN.provider ||
      model.apiModel !== PROMPT_REFINER_VNEXT_PRICE_PIN.apiModelId ||
      model.reasoning !== "medium") {
    throw new PromptRefinerProductAdapterError("product_adapter_model_pin_mismatch");
  }
  const transport = record(dependencies.languageModel);
  if (transport?.provider !== "openai.responses" ||
      transport.modelId !== PROMPT_REFINER_VNEXT_PRICE_PIN.apiModelId) {
    throw new PromptRefinerProductAdapterError("product_adapter_transport_pin_mismatch");
  }
  const now = dependencies.now ?? (() => performance.now());
  const wallClock = dependencies.wallClock ?? (() => new Date());
  const schedule = dependencies.scheduleTimeout ??
    ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const cancel = dependencies.cancelTimeout ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const trustedIntents = new WeakSet<object>();
  const trustedBilled = new WeakSet<object>();
  const trustedUnknown = new WeakSet<object>();
  const trustedUndispatched = new WeakSet<object>();

  const execute = async (input: Readonly<{ requestId: string; sourceText: string }>):
    Promise<PromptRefinerProductAdapterOutcome> => {
    if (!UUID.test(input.requestId)) {
      throw new PromptRefinerProductAdapterError("product_adapter_request_id_invalid");
    }
    const messages = promptRefinerVnextCandidateMessages(input.sourceText);
    const upperBound = messages.reduce((sum, message) =>
      sum + Buffer.byteLength(message.content, "utf8"), FRAMING_BYTES);
    if (upperBound > PROMPT_REFINER_VNEXT_MAX_INPUT_TOKENS) {
      throw new PromptRefinerProductAdapterError("product_adapter_input_cap_invalid");
    }
    const requestedAtDate = dependencies.requestedAt ?? wallClock();
    const started = now();
    const deadlineAt = Math.min(
      dependencies.deadlineAtMonotonicMs ??
        started + PROMPT_REFINER_PRODUCT_TIMEOUT_MS,
      started + PROMPT_REFINER_PRODUCT_TIMEOUT_MS,
    );
    const undispatchedTimeout = () => {
      const completedAtDate = wallClock();
      const outcome = Object.freeze({
        requestedAt: requestedAtDate.toISOString(),
        dispatchedAt: null,
        completedAt: completedAtDate.toISOString(),
        preparationLatencyMs: Math.max(0,
          completedAtDate.getTime() - requestedAtDate.getTime()),
        status: "undispatched" as const,
        reason: "timeout" as const,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        actualCostMicroUsd: null,
      });
      trustedUndispatched.add(outcome);
      return outcome;
    };
    if (!Number.isFinite(deadlineAt) || deadlineAt <= started) {
      return undispatchedTimeout();
    }
    const intent = Object.freeze({ intentId: randomUUID(),
      adapterConfigDigest: PROMPT_REFINER_PRODUCT_ADAPTER_CONFIG_DIGEST });
    trustedIntents.add(intent);
    await dependencies.authorizeDispatch(intent);
    const authorizedElapsed = now() - started;
    if (!Number.isFinite(authorizedElapsed) || authorizedElapsed < 0 ||
        now() >= deadlineAt) {
      return undispatchedTimeout();
    }
    const dispatchedAtDate = wallClock();
    const remainingMs = Math.max(1,
      deadlineAt - now());

    const abort = new AbortController();
    let timedOut = false;
    let timeoutHandle: unknown;
    const deadline = new Promise<{ kind: "timeout" }>((resolve) => {
      timeoutHandle = schedule(() => {
        timedOut = true;
        abort.abort();
        resolve({ kind: "timeout" });
      }, remainingMs);
    });
    const generation = Promise.resolve().then(async () => {
      if (timedOut || now() >= deadlineAt) {
        return { kind: "timeout" as const };
      }
      try {
        const value = await dependencies.generate({
          model: dependencies.languageModel,
          system: messages[0].content,
          prompt: messages[1].content,
          providerOptions: { openai: { reasoningEffort: "medium",
            store: false, parallelToolCalls: false } },
          maxOutputTokens: PROMPT_REFINER_VNEXT_MAX_OUTPUT_TOKENS,
          maxRetries: 0,
          timeout: remainingMs,
          abortSignal: abort.signal,
          toolChoice: "none",
          include: { requestBody: false, responseBody: false },
        });
        return { kind: "result" as const, value };
      } catch {
        return { kind: "error" as const };
      }
    });
    let settled: Awaited<typeof generation> | { kind: "timeout" };
    try {
      settled = await Promise.race([generation, deadline]);
    } finally {
      cancel(timeoutHandle);
    }
    const completedAtDate = wallClock();
    const elapsed = now() - started;
    const timing = Object.freeze({
      requestedAt: requestedAtDate.toISOString(),
      dispatchedAt: dispatchedAtDate.toISOString(),
      completedAt: completedAtDate.toISOString(),
      preparationLatencyMs: Math.max(0,
        completedAtDate.getTime() - requestedAtDate.getTime()),
    });
    const billingUnknown = (reason: "timeout" | "provider_error" |
      "response_unverified") => {
      const outcome = Object.freeze({ ...timing, status: "billing_unknown" as const,
        reason, inputTokens: null, cachedInputTokens: null, outputTokens: null,
        reasoningTokens: null, actualCostMicroUsd: null });
      trustedUnknown.add(outcome);
      return outcome;
    };
    if (timedOut || settled.kind === "timeout" || !Number.isFinite(elapsed) ||
        elapsed < 0 || now() >= deadlineAt) {
      return billingUnknown("timeout");
    }
    if (settled.kind === "error") return billingUnknown("provider_error");

    try {
      const result = record(settled.value);
      const steps = result?.steps;
      const step = Array.isArray(steps) && steps.length === 1 ? record(steps[0]) : null;
      if (!result || !step || !Array.isArray(result.warnings) ||
          result.warnings.length !== 0 || result.finishReason !== "stop" ||
          !Array.isArray(result.toolCalls) || result.toolCalls.length !== 0 ||
          !Array.isArray(result.toolResults) || result.toolResults.length !== 0 ||
          !Array.isArray(step.toolCalls) || step.toolCalls.length !== 0 ||
          !Array.isArray(step.toolResults) || step.toolResults.length !== 0) {
        return billingUnknown("response_unverified");
      }
      const usage = record(result.usage);
      const inputDetails = record(usage?.inputTokenDetails);
      if (!inputDetails || inputDetails.cacheWriteTokens !== 0) {
        return billingUnknown("response_unverified");
      }
      const normalized = {
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cachedInputTokens: inputDetails.cacheReadTokens,
        cacheWriteInputTokens: inputDetails.cacheWriteTokens,
        reasoningTokens: record(usage?.outputTokenDetails)?.reasoningTokens ?? null,
      };
      const checked = guardPromptRefinerVnextBilledUsage({ usage: normalized,
        effectivePricePin: PROMPT_REFINER_VNEXT_PRICE_PIN });
      if (!checked.complete || checked.costUpperBoundMicroUsd === null) {
        return billingUnknown("response_unverified");
      }
      const telemetry = Object.freeze({
        inputTokens: normalized.inputTokens as number,
        cachedInputTokens: normalized.cachedInputTokens as number,
        outputTokens: normalized.outputTokens as number,
        reasoningTokens: normalized.reasoningTokens as number | null,
        actualCostMicroUsd: checked.costUpperBoundMicroUsd,
      });
      let parsed;
      try {
        if (typeof result.text !== "string") throw new Error("vnext_empty_response");
        parsed = parsePromptRefinerVnextModelOutput(result.text, input.sourceText);
      } catch (error) {
        const reason = error instanceof Error && error.message === "vnext_no_change"
          ? "no_change" as const : "invalid_response" as const;
        const outcome = Object.freeze({ ...timing, ...telemetry,
          status: "invalid_response" as const, reason });
        trustedBilled.add(outcome);
        return outcome;
      }
      const outcome = parsed.outcome === "suggested"
        ? Object.freeze({ ...timing, ...telemetry, status: "suggested" as const,
            refinedPrompt: parsed.refinedPrompt })
        : Object.freeze({ ...timing, ...telemetry, status: "abstained" as const });
      trustedBilled.add(outcome);
      return outcome;
    } catch {
      return billingUnknown("response_unverified");
    }
  };

  return Object.freeze({
    version: PROMPT_REFINER_PRODUCT_ADAPTER_VERSION,
    execute,
    isTrustedDispatchIntent: (value: unknown): value is PromptRefinerProductDispatchIntent =>
      value !== null && typeof value === "object" && trustedIntents.has(value as object),
    isTrustedVerifiedBilling: (value: unknown): value is PromptRefinerProductAdapterOutcome =>
      value !== null && typeof value === "object" && trustedBilled.has(value as object),
    isTrustedBillingUnknown: (value: unknown): value is PromptRefinerProductAdapterOutcome =>
      value !== null && typeof value === "object" && trustedUnknown.has(value as object),
    isTrustedUndispatched: (value: unknown): value is PromptRefinerProductAdapterOutcome =>
      value !== null && typeof value === "object" && trustedUndispatched.has(value as object),
  });
}

