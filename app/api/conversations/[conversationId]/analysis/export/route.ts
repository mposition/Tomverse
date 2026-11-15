export const dynamic = "force-dynamic";

import { z } from "zod";
import { createHash } from "node:crypto";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { prisma } from "@/lib/prisma";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { conversationLockedResponse, hasConversationUnlockGrant } from "@/lib/conversationLock";
import { isChatConversationKind, conversationKindNotSupportedResponse } from "@/lib/conversationKindGuard";
import { featureNotIncludedResponse, getUserBillingPlan } from "@/lib/billingEntitlements";
import { loadReviewAnalysisReport, reviewReportSelectionSchema, ReviewReportSourceChanged } from "@/lib/reviewAnalysisReportServer";
import { renderDocumentArtifact } from "@/lib/generatedArtifactRenderers";
import { artifactContentDisposition } from "@/lib/generatedArtifactCore";
import { continuationShareRefusal } from "@/lib/continuationSharingPolicy";

const requestSchema = z.object({ analysis: reviewReportSelectionSchema, format: z.enum(["pdf", "docx", "txt", "md"]) }).strict();

export async function POST(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  try {
    const authentication = await resolveChatRouteSession(request);
    if (authentication.response) return authentication.response;
    const userId = authentication.session?.user?.id;
    if (!userId) return Response.json({ code: "AUTH_REQUIRED" }, { status: 401 });
    const { conversationId } = await context.params;
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, userId }, select: { password: true, kind: true, continuationBridge: { select: { id: true } } } });
    if (!conversation) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    if (!isChatConversationKind(conversation.kind)) return conversationKindNotSupportedResponse();
    if (!hasConversationUnlockGrant(request, userId, conversationId, conversation.password)) return conversationLockedResponse();
    const refusal = continuationShareRefusal({ hasContinuationBridge: Boolean(conversation.continuationBridge) });
    if (refusal) return Response.json({ code: refusal.code }, { status: refusal.status });
    if (!(await getUserBillingPlan(userId)).allowDownloads) return featureNotIncludedResponse("downloads");
    await consumeApiRateLimit(request, userId, "conversation-export", { minute: 10, day: 100 });
    const payload = await readLimitedJson(request, 4096, requestSchema);
    const { report } = await loadReviewAnalysisReport(userId, conversationId, payload.analysis);
    const rendered = renderDocumentArtifact({ ...report.spec, filename: `answer-analysis.${payload.format}`, format: payload.format });
    // CPU rendering does not keep a revoked lock grant alive. Recheck immediately
    // before releasing bytes; no Conversation, artifact or Message is written.
    const current = await prisma.conversation.findFirst({ where: { id: conversationId, userId }, select: { password: true, kind: true, continuationBridge: { select: { id: true } } } });
    if (!current) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    if (!isChatConversationKind(current.kind)) return conversationKindNotSupportedResponse();
    if (current.continuationBridge) return Response.json({ code: "REVIEW_REPORT_SOURCE_CHANGED" }, { status: 409 });
    if (!hasConversationUnlockGrant(request, userId, conversationId, current.password)) return conversationLockedResponse();
    await loadReviewAnalysisReport(userId, conversationId, payload.analysis);
    return new Response(rendered.bytes as unknown as BodyInit, { headers: {
      "Content-Type": rendered.mediaType, "Content-Disposition": artifactContentDisposition(`answer-analysis.${payload.format}`, payload.format),
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      "X-Export-Bytes": String(rendered.bytes.byteLength), "X-Export-SHA256": createHash("sha256").update(rendered.bytes).digest("hex"),
    } });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) return security;
    if (error instanceof ReviewReportSourceChanged) return Response.json({ code: "REVIEW_REPORT_SOURCE_CHANGED" }, { status: 409 });
    const code = (error as { code?: string })?.code;
    return Response.json({ code: code === "UNSUPPORTED_CHARACTERS" ? code : "REVIEW_REPORT_EXPORT_FAILED" }, { status: 500 });
  }
}
