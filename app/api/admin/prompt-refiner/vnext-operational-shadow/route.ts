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
import { readOnlySnapshotTransaction } from "@/lib/readOnlySnapshotTransaction";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const headers = { "Cache-Control": "private, no-store, max-age=0" };
const requestSchema = z.object({
  proof: promptRefinerVnextOneShotShadowProofSchema,
  confirmation: z.literal("RECORD_VNEXT_ONE_SHOT_OPERATIONAL_SHADOW_80_SLOTS"),
}).strict();
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
    const readback = await readOnlySnapshotTransaction(async (tx) => {
      const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
        where: { id: "prompt-refiner-vnext-one-shot-v4" },
      });
      const snapshot = await readPromptRefinerVnextOneShotStage(tx);
      const evidence = await readPromptRefinerVnextOneShotOperationalShadow(tx, stage);
      const paidAuthorization = stage && await readPromptRefinerVnextOneShotPaidAuthorization(
        tx, stage, evidence.shadowAuditLogId ?? "",
      );
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
