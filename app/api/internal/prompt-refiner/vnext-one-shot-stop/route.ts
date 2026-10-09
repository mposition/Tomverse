export const dynamic = "force-dynamic";

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { stopPromptRefinerVnextOneShotUnknown } from
  "@/lib/promptRefinerVnextOneShotOutcomeRecovery";

const headers = { "Cache-Control": "private, no-store, max-age=0" };
const DEFINITE_REFUSALS = new Set([
  "vnext_one_shot_unknown_input_invalid",
  "vnext_one_shot_unknown_stage_lock_unavailable",
  "vnext_one_shot_unknown_stage_not_running",
  "vnext_one_shot_unknown_stage_mismatch",
  "vnext_one_shot_unknown_slot_mismatch",
  "vnext_one_shot_unknown_consumption_audit_invalid",
  "vnext_one_shot_unknown_consumption_audit_mismatch",
  "vnext_one_shot_unknown_close_conflict",
]);
const bodySchema = z.object({
  stageId: z.literal("prompt-refiner-vnext-one-shot-v5").optional(),
  requestId: z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/),
  slotIndex: z.number().int().min(0).max(79),
  runApprovalAuditLogId: z.string().min(1).max(128),
  slotConsumptionAuditLogId: z.string().min(1).max(128),
  reason: z.enum(["timeout", "provider_error", "response_unverified"]),
}).strict();

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

/**
 * Emergency outcome_unknown stop stays available after slot consumption even
 * if the dispatch switch is off. Failure may be ambiguous: never retry here.
 */
export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers });
  }
  try {
    const input = await readLimitedJson(request, 2 * 1024, bodySchema);
    const receipt = await stopPromptRefinerVnextOneShotUnknown(input);
    return NextResponse.json(receipt, { status: 201, headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    if (error instanceof Error && DEFINITE_REFUSALS.has(error.message)) {
      return NextResponse.json({ code: "ONE_SHOT_STOP_REFUSED",
        retryAuthorized: false, humanReviewRequired: true },
      { status: 409, headers });
    }
    // A commit or transport failure may be ambiguous. Read the content-free
    // stage/slot/audit state and hand off; never resend this stop blindly.
    return NextResponse.json({ code: "ONE_SHOT_STOP_OUTCOME_UNKNOWN",
      retryAuthorized: false, humanReviewRequired: true },
    { status: 503, headers });
  }
}
