export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";

import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { readPromptRefinerVnextOneShotDisposition,
  recordPromptRefinerVnextOneShotDisposition } from
  "@/lib/promptRefinerVnextOneShotGateEvidence";
import { promptRefinerVnextOneShotGateOwner } from
  "@/lib/promptRefinerVnextOneShotGateRouteAccess";
import { readOnlySnapshotTransaction } from "@/lib/readOnlySnapshotTransaction";
import { V4_STAGE_ID, V5_STAGE_ID } from
  "@/lib/promptRefinerVnextOneShotV5Recovery";

const headers = { "Cache-Control": "private, no-store, max-age=0" };
const id = z.string().min(1).max(128);
const targetShape = {
  stageApprovalAuditLogId: id,
  runApprovalAuditLogId: id,
  shadowAuditLogId: id,
  gateAuditLogId: id,
  runtimeDeploymentId: z.string().regex(
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
  decision: z.enum(["pass", "fail", "insufficient_evidence"]),
};
const v4BodySchema = z.object({
  ...targetShape,
  confirmation: z.literal("RECORD_VNEXT_ONE_SHOT_OWNER_DISPOSITION"),
}).strict();
const v5BodySchema = z.object({
  ...targetShape,
  stageId: z.literal(V5_STAGE_ID),
  confirmation: z.literal("RECORD_VNEXT_ONE_SHOT_V5_OWNER_DISPOSITION"),
}).strict();
const bodySchema = z.union([v4BodySchema, v5BodySchema]);
const DEFINITE = new Set([
  "vnext_one_shot_disposition_context_invalid",
  "vnext_one_shot_disposition_stage_unavailable",
  "vnext_one_shot_disposition_binding_mismatch",
  "vnext_one_shot_disposition_gate_unavailable",
  "vnext_one_shot_disposition_duplicate",
  "vnext_one_shot_disposition_readback_invalid",
]);

export async function POST(request: Request) {
  try {
    const access = await promptRefinerVnextOneShotGateOwner(
      request, true, "disposition");
    if ("response" in access) return access.response;
    if (process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPOSITION_WRITE_ENABLED !== "1") {
      return NextResponse.json({ code: "DISPOSITION_WRITE_DISABLED" },
        { status: 409, headers });
    }
    const body = await readLimitedJson(request, 2 * 1024, bodySchema);
    const stageId = "stageId" in body ? body.stageId : V4_STAGE_ID;
    const result = await recordPromptRefinerVnextOneShotDisposition({
      session: access.session, request,
      stageId,
      target: { stageApprovalAuditLogId: body.stageApprovalAuditLogId,
        runApprovalAuditLogId: body.runApprovalAuditLogId,
        shadowAuditLogId: body.shadowAuditLogId,
        gateAuditLogId: body.gateAuditLogId,
        runtimeDeploymentId: body.runtimeDeploymentId },
      decision: body.decision,
    });
    return NextResponse.json(result, { status: 201, headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    if (error instanceof Error && DEFINITE.has(error.message)) {
      return NextResponse.json({ code: "DISPOSITION_REFUSED",
        retryAuthorized: false }, { status: 409, headers });
    }
    return NextResponse.json({ code: "DISPOSITION_OUTCOME_UNKNOWN",
      retryAuthorized: false, humanReviewRequired: true },
      { status: 503, headers });
  }
}

export async function GET(request: Request) {
  try {
    const access = await promptRefinerVnextOneShotGateOwner(
      request, false, "disposition");
    if ("response" in access) return access.response;
    const stageId = new URL(request.url).searchParams.get("stageId") ?? V4_STAGE_ID;
    if (stageId !== V4_STAGE_ID && stageId !== V5_STAGE_ID) {
      return NextResponse.json({ code: "DISPOSITION_STAGE_ID_INVALID" },
        { status: 400, headers });
    }
    const readback = await readOnlySnapshotTransaction(async (tx) => {
      const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
        where: { id: stageId },
      });
      return readPromptRefinerVnextOneShotDisposition(tx, stage, stageId);
    }, { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json({ readback }, { headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    return NextResponse.json({ code: "DISPOSITION_READBACK_UNAVAILABLE" },
      { status: 503, headers });
  }
}
