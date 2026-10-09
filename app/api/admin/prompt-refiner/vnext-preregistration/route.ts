export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import {
  assertRecentAdminAuthentication,
  isAdminReauthenticationError,
} from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from
  "@/lib/apiSecurity";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";
import {
  preparePromptRefinerVnextOneShotPreregistration,
  readPromptRefinerVnextOneShotPreregistration,
  recordPromptRefinerVnextOneShotPreregistration,
} from "@/lib/promptRefinerVnextOneShotPreregistration";

const headers = { "Cache-Control": "private, no-store, max-age=0" };
const permanentRefusals = new Set([
  "vnext_one_shot_preregistration_already_recorded",
  "vnext_one_shot_preregistration_stage_exists",
  "vnext_one_shot_preregistration_pin_mismatch",
  "vnext_one_shot_preregistration_source_mismatch",
  "vnext_one_shot_preregistration_price_mismatch",
  "vnext_one_shot_preregistration_policy_mismatch",
]);
const requestSchema = z.object({
  sourceCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
  sourceManifestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  runnerDigest: z.string().regex(/^[0-9a-f]{64}$/),
  pricePinDigest: z.string().regex(/^[0-9a-f]{64}$/),
  confirmation: z.literal("PREREGISTER_VNEXT_ONE_SHOT_CANDIDATE"),
}).strict();

/** Owner-only signed receipt read-back; available even when writes are off. */
export async function GET(request: Request) {
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
    await consumeApiRateLimit(request, session.user.id,
      "admin-prompt-refiner-vnext-preregistration-readback", { minute: 3, day: 30 });
    const readback = await readPromptRefinerVnextOneShotPreregistration(session.user.id);
    return NextResponse.json({ readback }, { headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    if (error instanceof Error &&
        error.message === "vnext_one_shot_preregistration_record_unverifiable") {
      return NextResponse.json({ code: "PREREGISTRATION_RECORD_UNVERIFIABLE" },
        { status: 409, headers });
    }
    return NextResponse.json({ code: "PREREGISTRATION_READBACK_UNAVAILABLE" },
      { status: 503, headers });
  }
}

/** Records only source, runner, price, owner access and retention pins. */
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
      "admin-prompt-refiner-vnext-preregistration", { minute: 1, day: 3 });
    if (process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_PREREGISTRATION_WRITE_ENABLED !== "1") {
      return NextResponse.json({ code: "PREREGISTRATION_WRITE_DISABLED" },
        { status: 409, headers });
    }
    const body = await readLimitedJson(request, 1024, requestSchema);
    const pins = await preparePromptRefinerVnextOneShotPreregistration(body);
    const result = await recordPromptRefinerVnextOneShotPreregistration({
      session, request, pins,
    });
    return NextResponse.json({
      preregistrationAuditLogId: result.auditLogId,
      dispatchAuthorized: false,
    }, { status: 201, headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    if (error instanceof Error && permanentRefusals.has(error.message)) {
      return NextResponse.json({ code: "PREREGISTRATION_REFUSED" },
        { status: 409, headers });
    }
    return NextResponse.json({ code: "PREREGISTRATION_UNAVAILABLE" },
      { status: 503, headers });
  }
}
