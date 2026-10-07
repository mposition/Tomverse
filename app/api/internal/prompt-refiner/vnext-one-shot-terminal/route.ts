export const dynamic = "force-dynamic";

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { recordPromptRefinerVnextOneShotTerminal } from
  "@/lib/promptRefinerVnextOneShotTerminalReceipt";
import { PROMPT_REFINER_VNEXT_CONFIRMED_FAILURE_CODES } from
  "@/lib/promptRefinerVnextOneShotFailureCodes";

const headers = { "Cache-Control": "private, no-store, max-age=0" };
const id = z.string().min(1).max(128);
const bodySchema = z.object({
  stageId: z.literal("prompt-refiner-vnext-one-shot-v5").optional(),
  requestId: z.string().uuid(),
  slotIndex: z.number().int().min(0).max(79),
  runApprovalAuditLogId: id,
  slotConsumptionAuditLogId: id,
  resultKind: z.enum(["suggested", "abstained", "failed"]),
  failureCode: z.enum(PROMPT_REFINER_VNEXT_CONFIRMED_FAILURE_CODES).optional(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    cacheWriteInputTokens: z.literal(0),
    reasoningTokens: z.number().int().nonnegative().nullable(),
  }).strict(),
  observedCostMicroUsd: z.number().int().min(0).max(29_918),
  intentToTerminalLatencyMs: z.number().int().min(0).max(15_000),
}).strict();
const REFUSALS = new Set([
  "vnext_one_shot_terminal_input_invalid",
  "vnext_one_shot_terminal_stage_unavailable",
  "vnext_one_shot_terminal_binding_mismatch",
  "vnext_one_shot_terminal_duplicate",
  "vnext_one_shot_unknown_stage_mismatch",
  "vnext_one_shot_unknown_slot_mismatch",
  "vnext_one_shot_unknown_consumption_audit_invalid",
  "vnext_one_shot_unknown_consumption_audit_mismatch",
]);

function authorized(request: Request): boolean {
  const expected = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN;
  const provided = request.headers.get("authorization");
  if (!expected || expected.length < 32 || expected.length > 256 ||
      !provided?.startsWith("Bearer ")) return false;
  const token = provided.slice(7);
  if (token.length < 32 || token.length > 256) return false;
  return timingSafeEqual(
    createHash("sha256").update(expected).digest(),
    createHash("sha256").update(token).digest(),
  );
}

/** Terminal settlement remains available if dispatch was switched off mid-run. */
export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers });
  }
  try {
    const input = await readLimitedJson(request, 2 * 1024, bodySchema);
    const receipt = await recordPromptRefinerVnextOneShotTerminal(input);
    return NextResponse.json(receipt, { status: 201, headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    if (error instanceof Error && REFUSALS.has(error.message)) {
      return NextResponse.json({ code: "ONE_SHOT_TERMINAL_REFUSED",
        retryAuthorized: false, humanReviewRequired: true },
      { status: 409, headers });
    }
    return NextResponse.json({ code: "ONE_SHOT_TERMINAL_OUTCOME_UNKNOWN",
      retryAuthorized: false, humanReviewRequired: true },
    { status: 503, headers });
  }
}
