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
import { AMUX_V22_OWNER_ANSWER_MAX_CHARS } from
  "@/lib/amux/v22OwnerQuestionCore";
import { answerAmuxV22OwnerQuestion } from
  "@/lib/amux/v22OwnerQuestionService";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const bodySchema = z.object({
  taskId: z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/),
  questionId: z.string().uuid(),
  answer: z.string().min(1).max(AMUX_V22_OWNER_ANSWER_MAX_CHARS),
}).strict();

/** The owner answers a v22 worker's question; the Task goes back to todo. */
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
      "admin-amux-v22-owner-question", { minute: 5, day: 50 });
    const body = await readLimitedJson(request, 24 * 1024, bodySchema);
    const result = await answerAmuxV22OwnerQuestion({ session, request, ...body });
    return Response.json(result, { headers: noStore });
  } catch (error) {
    if (error instanceof BoardImportError) return Response.json(
      { error: error.code }, { status: error.httpStatus, headers: noStore });
    const security = apiSecurityResponse(error);
    if (security) return security;
    throw error;
  }
}
