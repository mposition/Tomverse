export const dynamic = "force-dynamic";

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { consumePromptRefinerVnextOneShotSlot } from
  "@/lib/promptRefinerVnextOneShotSlotConsumption";

const headers = { "Cache-Control": "private, no-store, max-age=0" };
const DEFINITE_REFUSALS = new Set([
  "vnext_one_shot_slot_request_invalid",
  "vnext_one_shot_slot_custody_pin_unavailable",
  "vnext_one_shot_slot_reservation_unavailable",
  "vnext_one_shot_slot_binding_mismatch",
  "vnext_one_shot_slot_already_consumed",
  "vnext_one_shot_slot_transition_conflict",
  "vnext_one_shot_shadow_evidence_unavailable",
  "vnext_one_shot_paid_authorization_unavailable",
  "vnext_one_shot_price_mismatch",
  "vnext_one_shot_prior_terminal_unverified",
]);
const bodySchema = z.object({
  stageId: z.literal("prompt-refiner-vnext-one-shot-v5").optional(),
  requestId: z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/),
  slotIndex: z.number().int().min(0).max(79),
  runApprovalAuditLogId: z.string().min(1).max(128),
  manifestRoot: z.string().regex(/^[0-9a-f]{64}$/),
  runnerDigest: z.string().regex(/^[0-9a-f]{64}$/),
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
    createHash("sha256").update(token).digest()
  );
}

/** Default-off dispatch admission after the app's stage, run and slot checks. */
export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers });
  }
  if (process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED !== "1") {
    return NextResponse.json({ code: "SLOT_CONSUMPTION_DISABLED" },
      { status: 409, headers });
  }
  if (process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED !== "1") {
    return NextResponse.json({ code: "ONE_SHOT_DISPATCH_DISABLED" },
      { status: 409, headers });
  }
  try {
    const input = await readLimitedJson(request, 2 * 1024, bodySchema);
    if (input.manifestRoot !== process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT ||
        input.runnerDigest !== process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST) {
      return NextResponse.json({ code: "SLOT_CONSUMPTION_REFUSED",
        retryAuthorized: false }, { status: 409, headers });
    }
    const { manifestRoot: _manifestRoot, runnerDigest: _runnerDigest,
      ...slotInput } = input;
    void _manifestRoot;
    void _runnerDigest;
    const result = await consumePromptRefinerVnextOneShotSlot(slotInput);
    if (result.requestId !== slotInput.requestId ||
        result.slotIndex !== slotInput.slotIndex ||
        result.reservationConsumed !== true ||
        typeof result.slotConsumptionAuditLogId !== "string" ||
        result.slotConsumptionAuditLogId.length < 1 ||
        result.slotConsumptionAuditLogId.length > 128) {
      throw new Error("vnext_one_shot_slot_receipt_mismatch");
    }
    return NextResponse.json({
      requestId: result.requestId,
      slotIndex: result.slotIndex,
      slotConsumptionAuditLogId: result.slotConsumptionAuditLogId,
      reservationConsumed: true,
      dispatchAuthorized: true,
    },
      { status: 201, headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    if (error instanceof Error && DEFINITE_REFUSALS.has(error.message)) {
      return NextResponse.json({ code: "SLOT_CONSUMPTION_REFUSED",
        retryAuthorized: false }, { status: 409, headers });
    }
    // A commit or transport failure may be ambiguous. Inspect the content-free
    // stage/slot/audit readback and hand off; never send again automatically.
    return NextResponse.json({ code: "SLOT_CONSUMPTION_OUTCOME_UNKNOWN",
      retryAuthorized: false, humanReviewRequired: true },
      { status: 503, headers });
  }
}
