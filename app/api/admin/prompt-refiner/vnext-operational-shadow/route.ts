export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from
  "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from
  "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  readPromptRefinerVnextOneShotOperationalShadow,
  recordPromptRefinerVnextOneShotOperationalShadow,
  promptRefinerVnextOneShotShadowTarget,
} from "@/lib/promptRefinerVnextOneShotOperationalShadow";
import { promptRefinerVnextOneShotShadowProofSchema } from
  "@/lib/promptRefinerVnextOneShotShadowProof";
import { readPromptRefinerVnextOneShotPaidAuthorization } from
  "@/lib/promptRefinerVnextOneShotPaidAuthorization";
import { readPromptRefinerVnextOneShotStage } from
  "@/lib/promptRefinerVnextOneShotStageReadback";
import { readPromptRefinerVnextOneShotTerminalReceipts } from
  "@/lib/promptRefinerVnextOneShotTerminalReceipt";
import { V4_HELD_COST_MICRO_USD, V4_OBSERVED_COST_MICRO_USD } from
  "@/lib/promptRefinerVnextOneShotV5Recovery";
import { readOnlySnapshotTransaction } from "@/lib/readOnlySnapshotTransaction";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const headers = { "Cache-Control": "private, no-store, max-age=0" };
const V4 = "prompt-refiner-vnext-one-shot-v4";
const V5 = "prompt-refiner-vnext-one-shot-v5";
const V4_CONFIRMATION = "RECORD_VNEXT_ONE_SHOT_OPERATIONAL_SHADOW_80_SLOTS";
const V5_CONFIRMATION = "RECORD_VNEXT_ONE_SHOT_NEW_V5_OPERATIONAL_SHADOW_80_SLOTS";
const requestSchema = z.object({
  stageId: z.literal(V5).optional(),
  proof: promptRefinerVnextOneShotShadowProofSchema,
  confirmation: z.enum([V4_CONFIRMATION, V5_CONFIRMATION]),
}).strict().refine((value) => value.stageId === V5
  ? value.confirmation === V5_CONFIRMATION
  : value.confirmation === V4_CONFIRMATION);
const DEFINITE_REFUSALS = new Set([
  "vnext_one_shot_shadow_context_invalid",
  "vnext_one_shot_shadow_proof_invalid",
  "vnext_one_shot_shadow_signer_pin_unavailable",
  "vnext_one_shot_shadow_custody_pin_unavailable",
  "vnext_one_shot_shadow_stage_unavailable",
  "vnext_one_shot_shadow_binding_mismatch",
  "vnext_one_shot_shadow_duplicate",
  "vnext_one_shot_shadow_evidence_unverified",
  "vnext_one_shot_price_mismatch",
]);

async function owner(request: Request, mutation: boolean) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) {
    return { response: NextResponse.json({ error: "Not found." },
      { status: 404, headers }) } as const;
  }
  if (getAdminRole(session) !== "owner") {
    return { response: NextResponse.json({ error: "Forbidden." },
      { status: 403, headers }) } as const;
  }
  try {
    await assertRecentAdminAuthentication(session);
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return { response: NextResponse.json({ code: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers }) } as const;
    }
    throw error;
  }
  if (mutation && !hasValidMutationOrigin(request)) {
    return { response: NextResponse.json({ error: "Forbidden." },
      { status: 403, headers }) } as const;
  }
  await consumeApiRateLimit(request, session.user.id,
    mutation ? "admin-prompt-refiner-vnext-operational-shadow-write" :
      "admin-prompt-refiner-vnext-operational-shadow-read",
    mutation ? { minute: 1, day: 3 } : { minute: 3, day: 30 });
  return { session } as const;
}

/** One content-free, app-observed shadow after exact stage and run approval. */
export async function POST(request: Request) {
  try {
    const access = await owner(request, true);
    if ("response" in access) return access.response;
    if (process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_WRITE_ENABLED !== "1") {
      return NextResponse.json({ code: "SHADOW_WRITE_DISABLED" },
        { status: 409, headers });
    }
    const body = await readLimitedJson(request, 4 * 1024, requestSchema);
    const result = await recordPromptRefinerVnextOneShotOperationalShadow({
      session: access.session, request, proof: body.proof,
      stageId: body.stageId,
    });
    return NextResponse.json(result, { status: 201, headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    if (error instanceof Error && DEFINITE_REFUSALS.has(error.message)) {
      return NextResponse.json({ code: "SHADOW_EVIDENCE_REFUSED",
        retryAuthorized: false }, { status: 409, headers });
    }
    return NextResponse.json({ code: "SHADOW_EVIDENCE_OUTCOME_UNKNOWN",
      retryAuthorized: false, humanReviewRequired: true },
      { status: 503, headers });
  }
}

/** Diagnostic readback; absent, invalid and duplicate evidence remain visible. */
export async function GET(request: Request) {
  try {
    const access = await owner(request, false);
    if ("response" in access) return access.response;
    const requested = new URL(request.url).searchParams.get("stageId");
    if (requested !== null && requested !== V5) {
      return NextResponse.json({ code: "SHADOW_READBACK_STAGE_INVALID" },
        { status: 400, headers });
    }
    const stageId = requested === V5 ? V5 : V4;
    const readback = await readOnlySnapshotTransaction(async (tx) => {
      const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
        where: { id: stageId },
      });
      const snapshot = await readPromptRefinerVnextOneShotStage(tx, stageId);
      const evidence = await readPromptRefinerVnextOneShotOperationalShadow(
        tx, stage, stageId);
      const paidAuthorization = stage && await readPromptRefinerVnextOneShotPaidAuthorization(
        tx, stage, evidence.shadowAuditLogId ?? "",
      );
      const predecessor = stageId === V5
        ? await readPromptRefinerVnextOneShotTerminalReceipts(tx, V4)
        : null;
      const predecessorCostValid = Boolean(predecessor?.valid &&
        predecessor.stageStatus === "closed" &&
        predecessor.terminalReceipts === 33 &&
        predecessor.unknownReceipts === 1 &&
        predecessor.consumedWithoutReceipt === 0 &&
        predecessor.observedCostMicroUsd === V4_OBSERVED_COST_MICRO_USD &&
        predecessor.unresolvedCostUpperBoundMicroUsd === V4_HELD_COST_MICRO_USD);
      return { stageStatus: snapshot.stageStatus,
        slotCount: snapshot.slotCount, reservedSlots: snapshot.reservedSlots,
        consumedSlots: snapshot.consumedSlots,
        reservationShapeValid: snapshot.reservationShapeValid,
        approvalAuditsValid: snapshot.approvalAuditsValid,
        dispatchAuthorized: snapshot.dispatchAuthorized,
        target: stage && snapshot.stageStatus === "run_approved" &&
          snapshot.reservationShapeValid && snapshot.approvalAuditsValid &&
          snapshot.slotCount === 80 && snapshot.reservedSlots === 80 &&
          snapshot.consumedSlots === 0
          ? promptRefinerVnextOneShotShadowTarget(stage) : null,
        evidence,
        ...(stageId === V5 ? { crossRunCostReadback: predecessorCostValid && stage
          ? { v4ObservedCostMicroUsd: predecessor!.observedCostMicroUsd,
              v4HeldCostUpperBoundMicroUsd:
                predecessor!.unresolvedCostUpperBoundMicroUsd,
              v5RunCeilingMicroUsd: Number(stage.costCeilingMicroUsd),
              crossRunWorstCaseMicroUsd: predecessor!.observedCostMicroUsd +
                predecessor!.unresolvedCostUpperBoundMicroUsd +
                Number(stage.costCeilingMicroUsd) }
          : null } : {}),
        paidAuthorizationAuditPresent: paidAuthorization?.present ?? false,
        paidAuthorizationAuditValid: paidAuthorization?.valid ?? false };
    }, { maxWait: 5_000, timeout: 10_000 });
    return NextResponse.json({ readback }, { headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    return NextResponse.json({ code: "SHADOW_READBACK_UNAVAILABLE" },
      { status: 503, headers });
  }
}
