import "server-only";

import { getEnabledModel } from "@/lib/models";
import {
  promptRefinerVnextCandidateMessages,
} from "@/lib/promptRefinerQualityEvaluationVnextCandidate";
import {
  parsePromptRefinerVnextModelOutput,
  type PromptRefinerVnextModelOutput,
} from "@/lib/promptRefinerQualityEvaluationVnextCore";
import {
  isPromptRefinerVnextConfirmedFailureCode,
  type PromptRefinerVnextConfirmedFailureCode,
} from "@/lib/promptRefinerVnextOneShotFailureCodes";
import {
  guardPromptRefinerVnextBilledUsage,
  PROMPT_REFINER_VNEXT_MAX_INPUT_TOKENS,
  PROMPT_REFINER_VNEXT_MAX_OUTPUT_TOKENS,
  PROMPT_REFINER_VNEXT_PRICE_PIN,
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_RETRY_COUNT,
  PROMPT_REFINER_VNEXT_TIMEOUT_MS,
} from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const FRAMING_BYTES = 128;

type Generate = (options: Record<string, unknown>) => Promise<unknown>;
type Schedule = (callback: () => void, delayMs: number) => unknown;
type Cancel = (handle: unknown) => void;
type BilledResult = Readonly<{
  costUpperBoundMicroUsd: number;
  usage: Readonly<{
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: 0;
    reasoningTokens: number | null;
  }>;
  intentToTerminalLatencyMs: number;
  cacheWriteInputTokens: 0;
  toolCallCount: 0;
  dispatchAuthorized: false;
}>;
type Outcome = (BilledResult & Readonly<{
  status: "bounded_response";
  output: PromptRefinerVnextModelOutput;
}>) | (BilledResult & Readonly<{
  status: "confirmed_failure";
  failureCode: PromptRefinerVnextConfirmedFailureCode;
}>) | Readonly<{
  status: "outcome_unknown";
  reason: "timeout" | "provider_error" | "response_unverified";
  diagnosticCode?: "response_envelope_invalid" | "cache_write_unverified" |
    "usage_cost_unverified" | "output_parse_unverified";
  dispatchAuthorized: false;
}>;

export class PromptRefinerVnextOneShotPreDispatchError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PromptRefinerVnextOneShotPreDispatchError";
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const unknown = (reason: "timeout" | "provider_error" | "response_unverified",
  diagnosticCode?: Extract<Outcome, { status: "outcome_unknown" }>["diagnosticCode"]
): Outcome => Object.freeze({ status: "outcome_unknown", reason,
  ...(diagnosticCode ? { diagnosticCode } : {}), dispatchAuthorized: false });

/**
 * A11's isolated generation boundary. The A15 owner runner reaches this
 * adapter only after the app has consumed an approved slot. These adapter
 * checks enforce request and response bounds but never grant dispatch authority.
 */
export function createPromptRefinerVnextOneShotAdapter(dependencies: {
  generate: Generate;
  languageModel: unknown;
  now?: () => number;
  scheduleTimeout?: Schedule;
  cancelTimeout?: Cancel;
}) {
  const model = getEnabledModel(PROMPT_REFINER_VNEXT_PRICE_PIN.modelId);
  if (!model || model.provider !== PROMPT_REFINER_VNEXT_PRICE_PIN.provider ||
      model.apiModel !== PROMPT_REFINER_VNEXT_PRICE_PIN.apiModelId ||
      model.reasoning !== "medium") {
    throw new PromptRefinerVnextOneShotPreDispatchError("vnext_adapter_model_pin_mismatch");
  }
  const languageModel = record(dependencies.languageModel);
  if (languageModel?.provider !== "openai.responses" ||
      languageModel.modelId !== PROMPT_REFINER_VNEXT_PRICE_PIN.apiModelId) {
    throw new PromptRefinerVnextOneShotPreDispatchError("vnext_adapter_transport_model_mismatch");
  }
  const now = dependencies.now ?? (() => performance.now());
  const schedule = dependencies.scheduleTimeout ??
    ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const cancel = dependencies.cancelTimeout ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  return async (input: Readonly<{ requestId: string; sourceText: string }>): Promise<Outcome> => {
    if (!UUID.test(input.requestId)) {
      throw new PromptRefinerVnextOneShotPreDispatchError("vnext_adapter_request_id_invalid");
    }
    const messages = promptRefinerVnextCandidateMessages(input.sourceText);
    const upperBound = messages.reduce((sum, message) =>
      sum + Buffer.byteLength(message.content, "utf8"), FRAMING_BYTES);
    if (upperBound > PROMPT_REFINER_VNEXT_MAX_INPUT_TOKENS ||
        PROMPT_REFINER_VNEXT_RETRY_COUNT !== 0) {
      throw new PromptRefinerVnextOneShotPreDispatchError("vnext_adapter_input_cap_invalid");
    }

    const abort = new AbortController();
    const started = now();
    let timeoutHandle: unknown;
    let timedOut = false;
    const deadline = new Promise<{ kind: "timeout" }>((resolve) => {
      timeoutHandle = schedule(() => {
        timedOut = true;
        abort.abort();
        resolve({ kind: "timeout" });
      }, PROMPT_REFINER_VNEXT_TIMEOUT_MS);
    });
    const generation = Promise.resolve().then(async () => {
      // A synchronous test scheduler (or an already-expired deadline) must
      // never start a call after the deadline has been recorded.
      if (timedOut) return { kind: "timeout" as const };
      try {
        const value = await dependencies.generate({
          model: dependencies.languageModel,
          system: messages[0].content,
          prompt: messages[1].content,
          providerOptions: { openai: { reasoningEffort: "medium" } },
          maxOutputTokens: PROMPT_REFINER_VNEXT_MAX_OUTPUT_TOKENS,
          maxRetries: 0,
          timeout: PROMPT_REFINER_VNEXT_TIMEOUT_MS,
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
    const elapsedMs = now() - started;
    if (timedOut || settled.kind === "timeout" || !Number.isFinite(elapsedMs) ||
        elapsedMs < 0 || elapsedMs >= PROMPT_REFINER_VNEXT_TIMEOUT_MS) {
      return unknown("timeout");
    }
    if (settled.kind === "error") return unknown("provider_error");

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
        return unknown("response_unverified", "response_envelope_invalid");
      }
      const usage = record(result.usage);
      const details = record(usage?.inputTokenDetails);
      if (!details || details.cacheWriteTokens !== 0 ||
          !Number.isSafeInteger(details.cacheWriteTokens)) {
        return unknown("response_unverified", "cache_write_unverified");
      }
      const normalizedUsage = {
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cachedInputTokens: details.cacheReadTokens,
        cacheWriteInputTokens: details.cacheWriteTokens,
        reasoningTokens: record(usage?.outputTokenDetails)?.reasoningTokens ?? null,
      };
      const checked = guardPromptRefinerVnextBilledUsage({
        usage: normalizedUsage,
        effectivePricePin: PROMPT_REFINER_VNEXT_PRICE_PIN,
      });
      if (!checked.complete || checked.costUpperBoundMicroUsd === null ||
          checked.costUpperBoundMicroUsd > PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD) {
        return unknown("response_unverified", "usage_cost_unverified");
      }
      const responseText = result.text;
      if (typeof responseText !== "string") {
        return unknown("response_unverified", "output_parse_unverified");
      }
      let output: PromptRefinerVnextModelOutput;
      try {
        output = parsePromptRefinerVnextModelOutput(responseText, input.sourceText);
      } catch (error) {
        const code = error instanceof Error ? error.message : null;
        if (!isPromptRefinerVnextConfirmedFailureCode(code)) {
          return unknown("response_unverified", "output_parse_unverified");
        }
        return Object.freeze({
          status: "confirmed_failure", failureCode: code,
          costUpperBoundMicroUsd: checked.costUpperBoundMicroUsd,
          usage: Object.freeze({
            inputTokens: normalizedUsage.inputTokens as number,
            outputTokens: normalizedUsage.outputTokens as number,
            cachedInputTokens: normalizedUsage.cachedInputTokens as number,
            cacheWriteInputTokens: 0 as const,
            reasoningTokens: normalizedUsage.reasoningTokens as number | null,
          }),
          intentToTerminalLatencyMs: Math.ceil(elapsedMs),
          cacheWriteInputTokens: 0, toolCallCount: 0, dispatchAuthorized: false,
        });
      }
      return Object.freeze({
        status: "bounded_response", output,
        costUpperBoundMicroUsd: checked.costUpperBoundMicroUsd,
        usage: Object.freeze({
          inputTokens: normalizedUsage.inputTokens as number,
          outputTokens: normalizedUsage.outputTokens as number,
          cachedInputTokens: normalizedUsage.cachedInputTokens as number,
          cacheWriteInputTokens: 0 as const,
          reasoningTokens: normalizedUsage.reasoningTokens as number | null,
        }),
        intentToTerminalLatencyMs: Math.ceil(elapsedMs),
        cacheWriteInputTokens: 0, toolCallCount: 0, dispatchAuthorized: false,
      });
    } catch {
      return unknown("response_unverified", "output_parse_unverified");
    }
  };
}
