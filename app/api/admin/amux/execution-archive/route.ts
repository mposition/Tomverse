export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { archiveAllAdminExecutionCards } from
  "@/lib/amux/adminExecutionArchiveService";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const bodySchema = z.object({ confirm: z.literal("archive_all_active_cards") }).strict();

const withNoStore = (response: Response) => {
  response.headers.set("Cache-Control", noStore["Cache-Control"]);
  return response;
};

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner") {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: noStore });
    }
    try { await assertRecentAdminAuthentication(session); }
    catch (error) {
      if (isAdminReauthenticationError(error)) return Response.json({ error:
        "Recent administrator authentication is required.",
        code: "ADMIN_REAUTHENTICATION_REQUIRED" }, { status: 428, headers: noStore });
      throw error;
    }
    if (!hasValidMutationOrigin(request)) {
      return Response.json({ error: "origin_refused" }, { status: 403, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-execution-archive", { minute: 2, day: 10 });
    await readLimitedJson(request, 256, bodySchema);
    return Response.json(await archiveAllAdminExecutionCards({ session, request }),
      { headers: noStore });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) return withNoStore(security);
    throw error;
  }
}
