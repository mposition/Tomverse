export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { BoardImportError } from "@/lib/amux/boardImportCore";
import { declareV22Lane, readV22LaneDecision } from
  "@/lib/amux/v22LaneDecisionService";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const taskIdSchema = z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/);
const bodySchema = z.object({ policyVersion: z.literal(22),
  taskId: taskIdSchema,
  lane: z.enum(["normal", "parallel", "sev1"]),
  expectedLaneSequence: z.string().regex(/^\d+$/).nullable(),
}).strict();

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) return Response.json(
    { error: "Not found." }, { status: 404, headers: noStore });
  if (getAdminRole(session) !== "owner") return Response.json(
    { error: "Forbidden." }, { status: 403, headers: noStore });
  const taskId = taskIdSchema.safeParse(new URL(request.url).searchParams.get("taskId"));
  if (!taskId.success) return Response.json(
    { error: "Invalid task ID." }, { status: 400, headers: noStore });
  try {
    return Response.json(await readV22LaneDecision(taskId.data),
      { headers: noStore });
  } catch (error) {
    if (error instanceof BoardImportError) return Response.json(
      { error: error.code }, { status: error.httpStatus, headers: noStore });
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) return Response.json(
      { error: "Not found." }, { status: 404, headers: noStore });
    if (getAdminRole(session) !== "owner") return Response.json(
      { error: "Forbidden." }, { status: 403, headers: noStore });
    try { await assertRecentAdminAuthentication(session); }
    catch (error) {
      if (isAdminReauthenticationError(error)) return Response.json({ error:
        "Recent administrator authentication is required.",
        code: "ADMIN_REAUTHENTICATION_REQUIRED" },
      { status: 428, headers: noStore });
      throw error;
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-v22-lane", { minute: 5, day: 20 });
    const body = await readLimitedJson(request, 1024, bodySchema);
    const result = await declareV22Lane({ session, request, ...body });
    return Response.json(result, { headers: noStore });
  } catch (error) {
    if (error instanceof BoardImportError) return Response.json(
      { error: error.code }, { status: error.httpStatus, headers: noStore });
    const security = apiSecurityResponse(error);
    if (security) return security;
    throw error;
  }
}
