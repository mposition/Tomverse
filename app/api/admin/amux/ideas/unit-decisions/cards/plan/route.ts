export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedText } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AmuxV4CardPlanError, approveAmuxV4CardPlan } from
  "@/lib/amux/ideaCardPlanApprovalService";
import { AMUX_V4_UNIT_WRITE_ENV, AmuxV4DuplicateReasonRequired,
  AmuxV4UnitDecisionError,
  amuxV4UnitWriteEnabled } from "@/lib/amux/ideaUnitDecisionStore";
import { isAmuxV20TaskRegistrationRefusal } from
  "@/lib/amux/ideaUnitRegistrationCore";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

// amux-intake.md v18 item 3 (card part): one owner action approves every
// proposed Story and Task of an idea in one transaction, Stories first and
// Tasks after the plan's own cards they depend on. Each decision keeps its own
// prepare and consume audit entries and cost receipt; a refusal of any unit
// rolls the whole plan back. An implement Task's public PR consent is on
// unless listed in publicPrConsentOff. Read-back after an unknown outcome is
// the existing per-decision read by draft unit.

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const id = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
const body = z.object({
  ideaId: id,
  reasons: z.record(id, z.string().min(3).max(500)).default({}),
  publicPrConsentOff: z.array(id).max(24).default([]),
}).strict();

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "not_found", retryWrite: false },
        { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner" || !hasValidMutationOrigin(request)) {
      return NextResponse.json({ error: "forbidden", retryWrite: false },
        { status: 403, headers: noStore });
    }
    await assertRecentAdminAuthentication(session);
    if (!amuxV4UnitWriteEnabled(process.env[AMUX_V4_UNIT_WRITE_ENV])) {
      return NextResponse.json({ error: "unit_write_disabled", retryWrite: false },
        { status: 503, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") {
      return NextResponse.json({ error: "content_type_refused", retryWrite: false },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-v4-card-plan", { minute: 3, day: 30 });
    let raw: unknown;
    try { raw = JSON.parse(await readLimitedText(request, 8_192)); }
    catch { return NextResponse.json({ error: "schema_rejected", retryWrite: false },
      { status: 400, headers: noStore }); }
    const parsed = body.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: "schema_rejected",
      retryWrite: false }, { status: 400, headers: noStore });
    const result = await approveAmuxV4CardPlan(session, request, parsed.data);
    return NextResponse.json({ state: "approved", ...result, retryWrite: false },
      { status: 201, headers: noStore });
  } catch (error) {
    if (error instanceof AmuxV4CardPlanError) {
      return NextResponse.json({ error: error.code, draftUnitIds: error.draftUnitIds,
        retryWrite: false }, { status: 409, headers: noStore });
    }
    if (error instanceof AmuxV4DuplicateReasonRequired) {
      return NextResponse.json({ error: error.code, candidateIds: error.candidateIds,
        retryWrite: false }, { status: 409, headers: noStore });
    }
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED",
        retryWrite: false }, { status: 428, headers: noStore });
    }
    if (error instanceof AmuxV4UnitDecisionError) {
      return NextResponse.json({ error: error.code, retryWrite: false },
        { status: error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 :
          error.code === "not_ready" || error.code === "reconfirm" ||
          isAmuxV20TaskRegistrationRefusal(error.code) ? 409 : 503,
          headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    return NextResponse.json({ error: "outcome_unknown", retryWrite: false },
      { status: 503, headers: noStore });
  }
}
