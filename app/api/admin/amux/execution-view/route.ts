export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  readAmuxExecutionBoard, readAmuxExecutionBoardSnapshot,
  readAmuxExecutionHierarchy,
  readAmuxExecutionFeedback,
  readAmuxExecutionTaskDetail,
} from "@/lib/amux/adminExecutionRead";
import {
  parseAmuxExecutionLane, parseAmuxExecutionPage,
} from "@/lib/amux/adminExecutionViewCore";
import { readAmuxV22ActivationStatus } from
  "@/lib/amux/v22ActivationReadiness";

const headers = { "Cache-Control": "private, no-store, max-age=0" };
const json = (body: object, status = 200) =>
  NextResponse.json(body, { status, headers });
const ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Owner-only, read-only projection. No column or tree navigation grants a
 * status transition, worker claim, PR publication or completion decision. */
export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session) ||
        getAdminRole(session) !== "owner") return json({ error: "not_found" }, 404);
    await assertRecentAdminAuthentication(session);
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-execution-view", { minute: 40, day: 800 });
    const params = new URL(request.url).searchParams;
    const view = params.get("view");
    const allowed = view === "board_snapshot" ? ["view"] :
      view === "activation" ? ["view"] :
      view === "board" ? ["view", "lane", "page"] :
      view === "hierarchy" ? ["view", "parentKind", "parentId", "page"] :
      view === "feedback" ? ["view", "parentKind", "parentId"] :
      view === "detail" ? ["view", "taskId"] : null;
    if (!allowed || [...params.keys()].some((key) => !allowed.includes(key) ||
        params.getAll(key).length !== 1)) return json({ error: "invalid_request" }, 400);

    if (view === "board_snapshot") return json(await readAmuxExecutionBoardSnapshot());
    if (view === "activation") return json(readAmuxV22ActivationStatus());
    if (view === "board") {
      const lane = parseAmuxExecutionLane(params.get("lane"));
      const page = parseAmuxExecutionPage(params.get("page"));
      if (!lane || page === null) return json({ error: "invalid_request" }, 400);
      return json(await readAmuxExecutionBoard(lane, page));
    }
    if (view === "hierarchy") {
      const parentKind = params.get("parentKind");
      const parentId = params.get("parentId");
      const page = parseAmuxExecutionPage(params.get("page"));
      if (page === null || !["root", "unassigned", "node", "story"].includes(parentKind ?? "") ||
          (parentKind === "root" || parentKind === "unassigned" ? parentId !== null :
            !parentId || !ID.test(parentId))) return json({ error: "invalid_request" }, 400);
      const parent = parentKind === "root" ? { kind: "root" as const } :
        parentKind === "unassigned" ? { kind: "unassigned" as const } :
        { kind: parentKind as "node" | "story", id: parentId! };
      const result = await readAmuxExecutionHierarchy(parent, page);
      return result ? json(result) : json({ error: "not_found" }, 404);
    }
    if (view === "feedback") {
      const kind = params.get("parentKind");
      const id = params.get("parentId");
      if ((kind !== "node" && kind !== "story") || !id || !ID.test(id))
        return json({ error: "invalid_request" }, 400);
      const result = await readAmuxExecutionFeedback({ kind, id });
      return result ? json(result) : json({ error: "not_found" }, 404);
    }
    const taskId = params.get("taskId");
    if (!taskId || !ID.test(taskId)) return json({ error: "invalid_request" }, 400);
    const result = await readAmuxExecutionTaskDetail(taskId);
    return result ? json(result) : json({ error: "not_found" }, 404);
  } catch (error) {
    if (isAdminReauthenticationError(error))
      return json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" }, 428);
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    return json({ error: "execution_view_unavailable" }, 503);
  }
}
