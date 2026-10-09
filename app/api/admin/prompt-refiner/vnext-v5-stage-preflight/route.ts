export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import {
  assertRecentAdminAuthentication,
  isAdminReauthenticationError,
} from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from
  "@/lib/apiSecurity";
import { inspectPromptRefinerVnextOneShotStageControls,
  preparePromptRefinerVnextOneShotStageBinding } from
  "@/lib/promptRefinerVnextOneShotStageAdmission";
import { readPromptRefinerVnextOneShotPrice } from
  "@/lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback";
import { inspectPromptRefinerVnextOneShotV5Predecessor } from
  "@/lib/promptRefinerVnextOneShotV5PredecessorReadback";
import { V5_STAGE_ID } from "@/lib/promptRefinerVnextOneShotV5Recovery";
import { readOnlySnapshotTransaction } from "@/lib/readOnlySnapshotTransaction";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const headers = { "Cache-Control": "private, no-store, max-age=0" };
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const deploymentId = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const requestSchema = z.object({
  sourceCommitSha: sha,
  sourceManifestDigest: digest,
  runnerDigest: digest,
  manifestRoot: digest,
  runtimeDeploymentId: deploymentId,
  runtimeCommitSha: sha,
  pricePinDigest: digest,
}).strict();
const BINDING_FAILURES = new Set([
  "vnext_one_shot_stage_custody_pin_mismatch",
  "vnext_one_shot_recovery_capability_unavailable",
  "vnext_one_shot_recovery_source_unavailable",
  "vnext_one_shot_stage_observation_mismatch",
  "vnext_one_shot_candidate_commit_mismatch",
  "vnext_one_shot_candidate_pin_invalid",
  "vnext_one_shot_candidate_source_unavailable",
  "vnext_one_shot_candidate_manifest_drift",
  "vnext_one_shot_candidate_manifest_invalid",
  "vnext_one_shot_candidate_source_size",
  "vnext_one_shot_candidate_file_drift",
]);

/** Advisory owner diagnostic only. It writes no stage, slot, audit or provider state. */
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404, headers });
    }
    if (getAdminRole(session) !== "owner") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403, headers });
    }
    try {
      await assertRecentAdminAuthentication(session);
    } catch (error) {
      if (isAdminReauthenticationError(error)) {
        return NextResponse.json({ code: "ADMIN_REAUTHENTICATION_REQUIRED" },
          { status: 428, headers });
      }
      throw error;
    }
    if (!hasValidMutationOrigin(request)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403, headers });
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-prompt-refiner-vnext-v5-stage-preflight", { minute: 3, day: 12 });
    const expected = await readLimitedJson(request, 2 * 1024, requestSchema);
    const controls = inspectPromptRefinerVnextOneShotStageControls(expected, "v5");
    const stageWriteEnabled =
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_V5_STAGE_WRITE_ENABLED === "1";
    const auditKeyAvailable = adminAuditIntegrityKeys(process.env).length > 0;
    let binding;
    try {
      binding = await preparePromptRefinerVnextOneShotStageBinding(expected, "v5");
    } catch (error) {
      if (!(error instanceof Error) || !BINDING_FAILURES.has(error.message)) {
        throw error;
      }
      return NextResponse.json({ status: "diagnostic_only",
        bindingValid: false, bindingFailureClass: error.message,
        controls, stageWriteEnabled, auditKeyAvailable,
        predecessorValid: null, priceValid: null, priceReadAvailable: null,
        v5Absent: null,
        retryAuthorized: false, dispatchAuthorized: false }, { headers });
    }
    const readback = await readOnlySnapshotTransaction(async (tx) => {
      const predecessor = await inspectPromptRefinerVnextOneShotV5Predecessor(
        tx, binding, session.user.id);
      const v5 = await tx.promptRefinerVnextOneShotStage.findUnique({
        where: { id: V5_STAGE_ID },
        select: { id: true },
      });
      return { predecessorValid: Boolean(predecessor),
        v5Absent: v5 === null };
    }, { maxWait: 5_000, timeout: 15_000 });
    let priceValid = false;
    let priceReadAvailable = false;
    try {
      const price = await readOnlySnapshotTransaction(
        (tx) => readPromptRefinerVnextOneShotPrice(tx),
        { maxWait: 5_000, timeout: 15_000 });
      priceReadAvailable = true;
      priceValid = price.pricePinMatchesRegistry && price.problems.length === 0;
    } catch (error) {
      if (!(error instanceof Error) ||
          error.message !== "vnext_one_shot_price_read_failed") throw error;
    }
    return NextResponse.json({ status: "diagnostic_only",
      bindingValid: true, bindingFailureClass: null, controls,
      stageWriteEnabled, auditKeyAvailable, ...readback,
      priceValid, priceReadAvailable,
      retryAuthorized: false, dispatchAuthorized: false }, { headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    return NextResponse.json({ code: "V5_STAGE_PREFLIGHT_UNAVAILABLE",
      retryAuthorized: false, dispatchAuthorized: false },
      { status: 503, headers });
  }
}
