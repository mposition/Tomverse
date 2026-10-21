import { z } from "zod";
import { decideMemoryExtractionBudget } from "../../lib/memoryExtractionCore";
import {
  MEMORY_EXTRACTION_OUTPUT_SCHEMA, MEMORY_EXTRACTION_PROMPT_VERSION,
} from "../../lib/memoryExtractionPrompt";
import type { ExtractionModelAdapter } from "../../lib/memoryExtractionPipeline";
import { digest, type ModelAdapter, type ModelRequest } from "./schema";
import { QualityStop } from "./runner";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const scope = z.object({
  providerLimit: count, providerUsed: count, subBudgetLimit: count, subBudgetUsed: count,
  resetAt: z.string().datetime(),
}).strict();
const grantSchema = z.object({
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  reservedMicroUsd: count.positive(), day: scope, month: scope,
}).strict();
export type QualityReservation = {
  grant: z.infer<typeof grantSchema>;
  markIssued: () => Promise<void>;
  close: (result: {
    outcome: "returned" | "unknown" | "undispatched"; retainReservation: boolean;
  }) => Promise<void>;
};
export type QualityBudgetPort = {
  /** The approved host must atomically reserve against its AGENT ledger.
   * Usage is the snapshot before this reservation. Never use user credits.
   * A null result refuses authorization or budget admission. */
  reserve: (input: { purpose: "memory-quality"; requestDigest: string;
    request: ModelRequest; signal?: AbortSignal }) => Promise<QualityReservation | null>;
};

/** Reuse the product extraction provider's adapter; other structured tasks
 * use an already configured host adapter. This module loads no SDK or keys. */
export function existingProviderPort(input: {
  extraction: ExtractionModelAdapter; structured: ModelAdapter;
}): ModelAdapter {
  return async (request, context) => {
    if (request.task !== "extract") return input.structured(request, context);
    if (digest(request.schema) !== digest(MEMORY_EXTRACTION_OUTPUT_SCHEMA)) {
      throw new QualityStop("extraction_schema_drift");
    }
    const payload = z.object({ caseId: z.string(), prompt: z.string() }).strict().parse(request.input);
    const answer = await input.extraction({ prompt: {
      promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION, system: request.system,
      user: payload.prompt, allowedMessageLabels: [],
    } });
    return "output" in answer ? answer.output : JSON.parse(answer.text);
  };
}

/** Dormant integration seam, NOT a live CLI. The host supplies the existing
 * durable reservation/dispatch/settlement adapter after separate approval.
 * Retain the full conservative reservation on every dispatched call; unknown
 * outcomes latch this instance. There is no automatic retry or refund. */
export function budgetedProviderPort(input: {
  enabled?: boolean; maxRunMicroUsd: number; provider: ModelAdapter; budget: QualityBudgetPort;
}): ModelAdapter {
  let used = 0, latched = false, busy = false;
  return async (request, context) => {
    if (input.enabled !== true) throw new QualityStop("paid_execution_disabled");
    if (latched) throw new QualityStop("provider_outcome_unknown");
    if (busy) throw new QualityStop("concurrent_dispatch_refused");
    if (!Number.isSafeInteger(input.maxRunMicroUsd) || input.maxRunMicroUsd <= 0) {
      throw new QualityStop("invalid_run_budget");
    }
    context?.signal.throwIfAborted();
    busy = true;
    let reservation: QualityReservation | null = null, issued = false, closingAttempted = false;
    try {
      const key = digest(request);
      reservation = await input.budget.reserve({
        purpose: "memory-quality", requestDigest: key, request: structuredClone(request), signal: context?.signal,
      });
      if (!reservation) throw new QualityStop("budget_or_authority_refused");
      const grant = grantSchema.parse(reservation.grant);
      if (grant.requestDigest !== key || !decideMemoryExtractionBudget({
        estimatedCostMicroUsd: grant.reservedMicroUsd, day: grant.day, month: grant.month,
      }).allowed || used + grant.reservedMicroUsd > input.maxRunMicroUsd) {
        throw new QualityStop("budget_refused");
      }
      context?.signal.throwIfAborted();
      // A failed mark can have committed remotely: retain and stop on that unknown outcome.
      issued = true;
      await reservation.markIssued();
      used += grant.reservedMicroUsd;
      context?.signal.throwIfAborted();
      const output = await input.provider(structuredClone(request), context);
      context?.signal.throwIfAborted();
      closingAttempted = true;
      await reservation.close({ outcome: "returned", retainReservation: true });
      return output;
    } catch (error) {
      if (issued) latched = true;
      if (reservation && !closingAttempted) {
        try {
          await reservation.close({ outcome: issued ? "unknown" : "undispatched", retainReservation: issued });
        } catch { latched = true; }
      }
      if (issued) throw new QualityStop("provider_outcome_unknown");
      throw error instanceof QualityStop ? error : new QualityStop("budget_unavailable");
    } finally { busy = false; }
  };
}
