export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  adminSearchWhere,
  hashAdminSearchQuery,
} from "@/lib/adminSearchPolicy";

const toIso = (value: Date | null | undefined) => value?.toISOString() || null;

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-global-search", {
      minute: 30,
      day: 500,
    });

    const url = new URL(req.url);
    const query = (url.searchParams.get("q") || "").trim();
    if (query.length < 2) {
      return NextResponse.json({ results: [] });
    }
    const take = Math.min(Math.max(Number(url.searchParams.get("take") || 8), 1), 15);

    const [
      users,
      feedback,
      refunds,
      auditLogs,
      conversations,
      messages,
      limitDecisions,
    ] = await Promise.all([
        prisma.user.findMany({
          where: adminSearchWhere("user", query),
          orderBy: { id: "desc" },
          take,
          select: { id: true, email: true, name: true, plan: true },
        }),
        prisma.feedback.findMany({
          where: adminSearchWhere("feedback", query),
          orderBy: { createdAt: "desc" },
          take,
          select: { id: true, email: true, type: true, status: true, traceId: true, createdAt: true },
        }),
        prisma.refundRequest.findMany({
          where: adminSearchWhere("refundRequest", query),
          orderBy: { requestedAt: "desc" },
          take,
          select: { id: true, email: true, plan: true, status: true, requestedAt: true },
        }),
        prisma.adminAuditLog.findMany({
          where: adminSearchWhere("adminAuditLog", query),
          orderBy: { createdAt: "desc" },
          take,
          select: { id: true, actorEmail: true, action: true, targetType: true, targetId: true, createdAt: true },
        }),
        prisma.conversation.findMany({
          where: adminSearchWhere("conversation", query),
          orderBy: { updatedAt: "desc" },
          take,
          select: { id: true, title: true, userId: true, updatedAt: true },
        }),
        prisma.message.findMany({
          where: adminSearchWhere("message", query),
          orderBy: { createdAt: "desc" },
          take,
          select: {
            id: true,
            conversationId: true,
            modelId: true,
            createdAt: true,
            conversation: { select: { userId: true } },
          },
        }),
        // A blocked user only ever has their Trace ID, so it has to resolve
        // here as well as through /api/admin/limit-decisions.
        prisma.chatLimitDecisionEvent.findMany({
          where: adminSearchWhere("chatLimitDecisionEvent", query),
          orderBy: { createdAt: "desc" },
          take,
          select: {
            id: true,
            traceId: true,
            decision: true,
            errorCode: true,
            limitLayer: true,
            plan: true,
            createdAt: true,
          },
        }),
      ]);

    // SEC-008. Every search is attributable. Only the digest of the term is
    // stored: a plain-text row would turn the audit log into a transcript of
    // what administrators went looking for, readable by the next administrator
    // and carried into every export. The counts are what make a fishing
    // expedition visible -- many searches, few hits.
    await writeAdminAuditLog({
      session,
      request: req,
      action: "admin.search",
      targetType: "Search",
      targetId: null,
      summary: `Ran a global administrator search (${query.length} characters).`,
      metadata: {
        queryDigest: hashAdminSearchQuery(
          query,
          process.env.ADMIN_AUDIT_INTEGRITY_KEY || process.env.NEXTAUTH_SECRET
        ),
        queryLength: query.length,
        matches: {
          user: users.length,
          feedback: feedback.length,
          refundRequest: refunds.length,
          adminAuditLog: auditLogs.length,
          conversation: conversations.length,
          message: messages.length,
          chatLimitDecisionEvent: limitDecisions.length,
        },
      },
    });

    return NextResponse.json({
      results: [
        ...users.map((user) => ({
          type: "User",
          id: user.id,
          title: user.email || user.name || user.id,
          detail: `${user.plan || "Free"} plan`,
          href: `/admin/users/${encodeURIComponent(user.id)}`,
          createdAt: null,
        })),
        ...feedback.map((item) => ({
          type: "Feedback",
          id: item.id,
          title: item.email || item.traceId || item.id,
          detail: `${item.type} / ${item.status}`,
          href: "/admin/support?tab=feedback",
          createdAt: toIso(item.createdAt),
        })),
        ...refunds.map((item) => ({
          type: "Refund",
          id: item.id,
          title: item.email || item.id,
          detail: `${item.plan || "Unknown"} / ${item.status}`,
          href: "/admin/refunds",
          createdAt: toIso(item.requestedAt),
        })),
        ...auditLogs.map((item) => ({
          type: "Audit",
          id: item.id,
          title: item.action,
          detail: `${item.actorEmail || "Admin"} / ${item.targetType || "-"} ${item.targetId || ""}`,
          href: "/admin/audit",
          createdAt: toIso(item.createdAt),
        })),
        ...conversations.map((item) => ({
          type: "Conversation",
          id: item.id,
          title: item.title,
          detail: `User ${item.userId}`,
          href: `/admin/users/${encodeURIComponent(item.userId)}`,
          createdAt: toIso(item.updatedAt),
        })),
        ...messages.map((item) => ({
          type: "Message",
          id: item.id,
          title: item.modelId || item.id,
          detail: `Conversation ${item.conversationId}`,
          href: `/admin/users/${encodeURIComponent(item.conversation.userId)}`,
          createdAt: toIso(item.createdAt),
        })),
        ...limitDecisions.map((item) => ({
          type: "Limit decision",
          id: item.id,
          title: item.traceId,
          detail: `${item.decision}${item.errorCode ? ` / ${item.errorCode}` : ""} / ${item.limitLayer || "-"} / ${item.plan}`,
          href: `/api/admin/limit-decisions?traceId=${encodeURIComponent(item.traceId)}`,
          createdAt: toIso(item.createdAt),
        })),
      ].slice(0, 40),
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin global search failed:", error);
    return NextResponse.json(
      { error: "Failed to search admin records." },
      { status: 500 }
    );
  }
}
