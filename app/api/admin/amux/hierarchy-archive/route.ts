export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { archiveAmuxHierarchyNodes } from "@/lib/amux/adminHierarchyArchiveService";
import {
  AMUX_HIERARCHY_ARCHIVE_MAX_NODES, AmuxHierarchyArchiveRefusal,
} from "@/lib/amux/adminHierarchyCore";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const bodySchema = z.object({
  confirm: z.literal("archive_hierarchy_nodes"),
  nodeIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/))
    .min(1).max(AMUX_HIERARCHY_ARCHIVE_MAX_NODES),
}).strict();

const withNoStore = (response: Response) => {
  response.headers.set("Cache-Control", noStore["Cache-Control"]);
  return response;
};

/** Owner-only, one-way hierarchy archive. A failure whose outcome is not
 * known is never retried here; the board reads the hierarchy back instead. */
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
      "admin-amux-hierarchy-archive", { minute: 6, day: 60 });
    const body = await readLimitedJson(request, 32_768, bodySchema);
    try {
      return Response.json(await archiveAmuxHierarchyNodes({ session, request,
        nodeIds: body.nodeIds }), { headers: noStore });
    } catch (error) {
      if (error instanceof AmuxHierarchyArchiveRefusal) {
        return Response.json({ error: error.code === "disabled" ? "archive_disabled" :
          "archive_refused", code: error.code, nodeId: error.nodeId },
        { status: error.code === "disabled" ? 403 : 409, headers: noStore });
      }
      console.error("AMUX hierarchy archive failed");
      return Response.json({ error: "archive_failed", retry: false },
        { status: 500, headers: noStore });
    }
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) return withNoStore(security);
    throw error;
  }
}
