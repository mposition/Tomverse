export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { moveAdminExecutionCard, readAdminExecutionMove } from
  "@/lib/amux/adminExecutionMoveService";
import { BoardImportError } from "@/lib/amux/boardImportCore";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const taskIdSchema = z.string().min(1).max(80)
  .regex(/^[A-Za-z0-9:_-]+$/);
const requestIdSchema = z.string().uuid();
const bodySchema = z.object({
  taskId: taskIdSchema,
  expectedRevision: z.number().int().min(0),
  requestId: requestIdSchema,
}).strict();

const withNoStore = (response: Response) => {
  response.headers.set("Cache-Control", noStore["Cache-Control"]);
  return response;
};

async function requireRecentOwner() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) {
    return { response: Response.json({ error: "Not found." },
      { status: 404, headers: noStore }) } as const;
  }
  if (getAdminRole(session) !== "owner") {
    return { response: Response.json({ error: "Forbidden." },
      { status: 403, headers: noStore }) } as const;
  }
  try { await assertRecentAdminAuthentication(session); }
  catch (error) {
    if (isAdminReauthenticationError(error)) return {
      response: Response.json({ error:
        "Recent administrator authentication is required.",
        code: "ADMIN_REAUTHENTICATION_REQUIRED" },
      { status: 428, headers: noStore }),
    } as const;
    throw error;
  }
  return { session } as const;
}

export async function GET(request: Request) {
  try {
    const auth = await requireRecentOwner();
    if ("response" in auth) return auth.response;
    await consumeApiRateLimit(request, auth.session.user.id,
      "admin-amux-execution-move-read", { minute: 20, day: 200 });
    const params = new URL(request.url).searchParams;
    const parsed = z.object({ taskId: taskIdSchema,
      requestId: requestIdSchema }).strict().safeParse({
        taskId: params.get("taskId"), requestId: params.get("requestId"),
      });
    if (!parsed.success) return Response.json(
      { error: "INVALID_REQUEST" }, { status: 400, headers: noStore });
    return Response.json(await readAdminExecutionMove(
      parsed.data.taskId, parsed.data.requestId), { headers: noStore });
  } catch (error) {
    if (error instanceof BoardImportError) return Response.json(
      { error: error.code }, { status: error.httpStatus, headers: noStore });
    const security = apiSecurityResponse(error);
    if (security) return withNoStore(security);
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireRecentOwner();
    if ("response" in auth) return auth.response;
    if (!hasValidMutationOrigin(request)) {
      return Response.json({ error: "origin_refused" },
        { status: 403, headers: noStore });
    }
    await consumeApiRateLimit(request, auth.session.user.id,
      "admin-amux-execution-move", { minute: 5, day: 30 });
    const body = await readLimitedJson(request, 1_024, bodySchema);
    return Response.json(await moveAdminExecutionCard({
      session: auth.session, request, ...body,
    }), { headers: noStore });
  } catch (error) {
    if (error instanceof BoardImportError) {
      return Response.json({ error: error.code,
        ...(error.code === "outcome_unknown" ? { retry: false } : {}) },
      { status: error.httpStatus, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) return withNoStore(security);
    throw error;
  }
}
