export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";

import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { readPromptRefinerVnextOneShotGateEvidence,
  recordPromptRefinerVnextOneShotGateEvidence } from
  "@/lib/promptRefinerVnextOneShotGateEvidence";
import { promptRefinerVnextOneShotGateAttestationSchema } from
  "@/lib/promptRefinerVnextOneShotGateAttestation";
import { promptRefinerVnextOneShotGateOwner } from
  "@/lib/promptRefinerVnextOneShotGateRouteAccess";
import { readOnlySnapshotTransaction } from "@/lib/readOnlySnapshotTransaction";
import { V4_STAGE_ID, V5_STAGE_ID } from
  "@/lib/promptRefinerVnextOneShotV5Recovery";

const headers = { "Cache-Control": "private, no-store, max-age=0" };
const v4BodySchema = z.object({
  attestation: promptRefinerVnextOneShotGateAttestationSchema,
  confirmation: z.literal("RECORD_VNEXT_ONE_SHOT_DETERMINISTIC_GATE"),
}).strict();
const v5BodySchema = z.object({
  stageId: z.literal(V5_STAGE_ID),
  attestation: promptRefinerVnextOneShotGateAttestationSchema,
  confirmation: z.literal("RECORD_VNEXT_ONE_SHOT_V5_DETERMINISTIC_GATE"),
}).strict();
const bodySchema = z.union([v4BodySchema, v5BodySchema]);
const DEFINITE = new Set([
  "vnext_one_shot_gate_attestation_invalid",
  "vnext_one_shot_gate_summary_invalid",
  "vnext_one_shot_gate_context_invalid",
  "vnext_one_shot_gate_custody_pin_unavailable",
  "vnext_one_shot_gate_stage_unavailable",
  "vnext_one_shot_gate_binding_mismatch",
  "vnext_one_shot_gate_shadow_unavailable",
  "vnext_one_shot_gate_slot_evidence_mismatch",
  "vnext_one_shot_gate_duplicate",
  "vnext_one_shot_gate_readback_invalid",
]);

export async function POST(request: Request) {
  try {
    const access = await promptRefinerVnextOneShotGateOwner(request, true, "gate");
    if ("response" in access) return access.response;
    if (process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_WRITE_ENABLED !== "1") {
      return NextResponse.json({ code: "GATE_WRITE_DISABLED" },
        { status: 409, headers });
    }
    const body = await readLimitedJson(request, 32 * 1024, bodySchema);
    const stageId = "stageId" in body ? body.stageId : V4_STAGE_ID;
    const result = await recordPromptRefinerVnextOneShotGateEvidence({
      session: access.session, request, attestation: body.attestation, stageId,
    });
    return NextResponse.json(result, { status: 201, headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    if (error instanceof Error && DEFINITE.has(error.message)) {
      return NextResponse.json({ code: "GATE_EVIDENCE_REFUSED",
        retryAuthorized: false }, { status: 409, headers });
    }
    if (error instanceof Error &&
        error.message === "vnext_one_shot_gate_signer_pin_unavailable") {
      return NextResponse.json({ code: "GATE_SIGNER_PIN_UNAVAILABLE",
        retryAuthorized: false, humanReviewRequired: true },
        { status: 503, headers });
    }
    return NextResponse.json({ code: "GATE_EVIDENCE_OUTCOME_UNKNOWN",
      retryAuthorized: false, humanReviewRequired: true },
      { status: 503, headers });
  }
}

export async function GET(request: Request) {
  try {
    const access = await promptRefinerVnextOneShotGateOwner(request, false, "gate");
    if ("response" in access) return access.response;
    const stageId = new URL(request.url).searchParams.get("stageId") ?? V4_STAGE_ID;
    if (stageId !== V4_STAGE_ID && stageId !== V5_STAGE_ID) {
      return NextResponse.json({ code: "GATE_STAGE_ID_INVALID" },
        { status: 400, headers });
    }
    const readback = await readOnlySnapshotTransaction(async (tx) => {
      const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
        where: { id: stageId },
      });
      return readPromptRefinerVnextOneShotGateEvidence(tx, stage, stageId);
    }, { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json({ readback }, { headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    return NextResponse.json({ code: "GATE_READBACK_UNAVAILABLE" },
      { status: 503, headers });
  }
}
