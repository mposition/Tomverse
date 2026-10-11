export const dynamic = "force-dynamic";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { AMUX_V4_ANALYSIS_BUDGET_RESERVE_CODE_LATCH } from "@/lib/amux/ideaAnalysisBudgetReservationService";
import { AMUX_ANALYSIS_BUDGET_READ_ENV, AMUX_ANALYSIS_BUDGET_WRITE_ENV } from "@/lib/amux/ideaAnalysisBudgetSettingCore";
import { AnalysisBudgetSettingError, commitAnalysisBudgetSetting, readAnalysisBudgetSnapshot } from "@/lib/amux/ideaAnalysisBudgetSettingStore";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const schema = z.object({ id: z.string().uuid(),
  expectedPreviousVersion: z.number().int().nonnegative().max(2_147_483_646),
  monthlyUsd: z.string().max(16), ownerConfirmed: z.literal(true) }).strict();
async function owner() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) return null;
  if (getAdminRole(session) !== "owner") throw new AnalysisBudgetSettingError("forbidden");
  await assertRecentAdminAuthentication(session);
  return session;
}
function failure(error: unknown) {
  if (isAdminReauthenticationError(error)) return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" }, { status: 428, headers: noStore });
  if (error instanceof AnalysisBudgetSettingError) return NextResponse.json({ error: error.code,
    retryWrite: false }, { status: error.code === "forbidden" ? 403 : error.code === "budget_unavailable" ? 503 : 409, headers: noStore });
  const security = apiSecurityResponse(error);
  if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
  return NextResponse.json({ error: "outcome_unknown", retryWrite: false }, { status: 503, headers: noStore });
}
function enabled() {
  return AMUX_V4_ANALYSIS_BUDGET_RESERVE_CODE_LATCH && process.env[AMUX_ANALYSIS_BUDGET_READ_ENV] === "enabled";
}
export async function GET(request: Request): Promise<Response> {
  try {
    if (!await owner()) return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
    if (!enabled()) return NextResponse.json({ error: "budget_disabled" }, { status: 409, headers: noStore });
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((k) => k !== "id") || params.getAll("id").length > 1) {
      throw new AnalysisBudgetSettingError("invalid_budget");
    }
    const id = params.get("id");
    if (id !== null) {
      if (!z.string().uuid().safeParse(id).success) throw new AnalysisBudgetSettingError("invalid_budget");
      const saved = await prisma.amuxIdeaAnalysisBudgetSetting.findUnique({ where: { id }, select: {
        id: true, version: true, limitMicroUsd: true, approvalAuditLogId: true,
      } });
      return NextResponse.json(saved ? { state: "saved", id: saved.id, version: saved.version,
        limitMicroUsd: saved.limitMicroUsd.toString(), auditId: saved.approvalAuditLogId }
        : { state: "not_visible", retryWrite: false }, { headers: noStore });
    }
    const snapshot = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('statement_timeout', '5000', true),
        set_config('idle_in_transaction_session_timeout', '10000', true)`;
      return readAnalysisBudgetSnapshot(tx);
    }, { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json({ state: "snapshot", ...snapshot,
      writeEnabled: process.env[AMUX_ANALYSIS_BUDGET_WRITE_ENV] === "enabled" }, { headers: noStore });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (!session) return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
    if (!enabled() || process.env[AMUX_ANALYSIS_BUDGET_WRITE_ENV] !== "enabled") return NextResponse.json({ error: "budget_disabled" }, { status: 409, headers: noStore });
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return NextResponse.json({ error: "Invalid content type." }, { status: 415, headers: noStore });
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-budget-setting", { minute: 3, day: 20 });
    const body = await readLimitedJson(request, 2_048, schema);
    const saved = await prisma.$transaction((tx) => commitAnalysisBudgetSetting(tx, { ...body, session, request }), { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json({ state: "saved", ...saved }, { status: 201, headers: noStore });
  } catch (error) { return failure(error); }
}
