export const dynamic = "force-dynamic";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";
import { BoardImportError } from "@/lib/amux/boardImportCore";
import { amuxV22RecoveryAdminSchema, amuxV22TaskRecoveryEnabled,
  amuxV22LegacySafeStopEnabled, AMUX_V22_TASK_RECOVERY_ENABLED_ENV,
  AMUX_V22_LEGACY_SAFE_STOP_ENABLED_ENV } from "@/lib/amux/v22TaskRecoveryCore";
import { requestAmuxV22RecoveryInspection, approveAmuxV22TaskRecovery,
  acceptAmuxV22UnknownPriorEffects, readAmuxV22TaskRecovery,
  requestAmuxV22LegacySafeStop } from
  "@/lib/amux/v22TaskRecoveryService";
const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const readSchema = z.object({ taskId: z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/),
  requestId: z.string().uuid() }).strict();
async function recentOwner() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) return { response:
    Response.json({ error: "Not found." }, { status: 404, headers: noStore }) } as const;
  if (getAdminRole(session) !== "owner") return { response:
    Response.json({ error: "Forbidden." }, { status: 403, headers: noStore }) } as const;
  try { await assertRecentAdminAuthentication(session); }
  catch (error) {
    if (isAdminReauthenticationError(error)) return { response: Response.json({
      error: "Recent administrator authentication is required.", code: "ADMIN_REAUTHENTICATION_REQUIRED" },
      { status: 428, headers: noStore }) } as const;
    throw error;
  }
  return { session } as const;
}
function failure(error: unknown) {
  if (error instanceof BoardImportError) return Response.json({ error: error.code,
    ...(error.code === "outcome_unknown" ? { retry: false } : {}) },
    { status: error.code === "outcome_unknown" ? 503 : error.httpStatus, headers: noStore });
  const response = apiSecurityResponse(error);
  if (response) { response.headers.set("Cache-Control", noStore["Cache-Control"]); return response; }
  throw error;
}
export async function GET(request: Request) {
  try {
    const auth = await recentOwner(); if ("response" in auth) return auth.response;
    await consumeApiRateLimit(request, auth.session.user.id, "admin-amux-execution-recovery-read", { minute: 20, day: 200 });
    const params = new URL(request.url).searchParams;
    const parsed = readSchema.safeParse(Object.fromEntries(params));
    if (!parsed.success) return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers: noStore });
    return Response.json({ ...await readAmuxV22TaskRecovery(auth.session, parsed.data.taskId, parsed.data.requestId),
      recoveryEnabled: amuxV22TaskRecoveryEnabled(process.env[AMUX_V22_TASK_RECOVERY_ENABLED_ENV]),
      safeStopEnabled: amuxV22LegacySafeStopEnabled(
        process.env[AMUX_V22_LEGACY_SAFE_STOP_ENABLED_ENV]) }, { headers: noStore });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const auth = await recentOwner(); if ("response" in auth) return auth.response;
    if (!amuxV22TaskRecoveryEnabled(process.env[AMUX_V22_TASK_RECOVERY_ENABLED_ENV]))
      return Response.json({ error: "recovery_disabled" }, { status: 409, headers: noStore });
    if (!hasValidMutationOrigin(request)) return Response.json({ error: "origin_refused" }, { status: 403, headers: noStore });
    await consumeApiRateLimit(request, auth.session.user.id, "admin-amux-execution-recovery", { minute: 5, day: 30 });
    const body = await readLimitedJson(request, 2_048, amuxV22RecoveryAdminSchema);
    const input = { session: auth.session, request, ...body };
    const result = body.action === "request_inspection" ?
      await requestAmuxV22RecoveryInspection({ ...input, ...body }) :
      body.action === "accept_unknown_prior_effects" ?
        await acceptAmuxV22UnknownPriorEffects({ ...input, ...body }) :
      body.action === "request_safe_stop" ?
        await requestAmuxV22LegacySafeStop({ ...input, ...body }) :
        await approveAmuxV22TaskRecovery({ ...input, ...body });
    return Response.json(result, { headers: noStore });
  } catch (error) { return failure(error); }
}
