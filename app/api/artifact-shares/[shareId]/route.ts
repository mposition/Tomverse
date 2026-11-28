import { NextResponse } from "next/server";

import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { revokeArtifactShare } from "@/lib/artifactShareService";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { logSecurityAuditEvent } from "@/lib/securityAudit";

/**
 * Stopping a share link (docs/policy/generated-artifacts.md section 19). The
 * row and the page it held are deleted, so the link stops opening at once.
 *
 * Allowed whatever the switches say and whether or not the conversation is
 * unlocked right now: taking a public page down only ever narrows what is
 * public. Not the owner's, or not there, is the same 404.
 */
export async function DELETE(req: Request, context: { params: Promise<{ shareId: string }> }) {
  const authentication = await resolveChatRouteSession(req);
  if (authentication.response) return authentication.response;
  const userId = authentication.session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Login required" }, { status: 401 });
  const { shareId } = await context.params;
  try {
    await consumeApiRateLimit(req, userId, "artifact-share-revoke", { minute: 20, day: 200 });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (!security) throw error;
    logSecurityAuditEvent("artifact.share.revoke", { userId, resourceId: shareId, request: req, outcome: "rate_limited" });
    return security;
  }
  logSecurityAuditEvent("artifact.share.revoke", { userId, resourceId: shareId, request: req, outcome: "attempt" });
  // The removal records its own success, as an expired link's removal does (lib/artifactShareService.ts).
  const removed = typeof shareId === "string" && shareId.length <= 64 ? await revokeArtifactShare(userId, shareId, req) : false;
  if (!removed) {
    logSecurityAuditEvent("artifact.share.revoke", { userId, resourceId: shareId, request: req, outcome: "denied", reason: "NOT_FOUND" });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
