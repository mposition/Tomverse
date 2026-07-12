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

    const [users, feedback, refunds, auditLogs, conversations, messages] =
      await Promise.all([
        prisma.user.findMany({
          where: {
            OR: [
              { id: { contains: query, mode: "insensitive" } },
              { email: { contains: query, mode: "insensitive" } },
              { name: { contains: query, mode: "insensitive" } },
              { stripeCustomerId: { contains: query, mode: "insensitive" } },
              { stripeSubscriptionId: { contains: query, mode: "insensitive" } },
            ],
          },
          orderBy: { id: "desc" },
          take,
          select: { id: true, email: true, name: true, plan: true },
        }),
        prisma.feedback.findMany({
          where: {
            OR: [
              { id: { contains: query, mode: "insensitive" } },
              { email: { contains: query, mode: "insensitive" } },
              { traceId: { contains: query, mode: "insensitive" } },
              { modelId: { contains: query, mode: "insensitive" } },
              { message: { contains: query, mode: "insensitive" } },
            ],
          },
          orderBy: { createdAt: "desc" },
          take,
          select: { id: true, email: true, type: true, status: true, traceId: true, createdAt: true },
        }),
        prisma.refundRequest.findMany({
          where: {
            OR: [
              { id: { contains: query, mode: "insensitive" } },
              { email: { contains: query, mode: "insensitive" } },
              { stripeCustomerId: { contains: query, mode: "insensitive" } },
              { stripeSubscriptionId: { contains: query, mode: "insensitive" } },
              { reason: { contains: query, mode: "insensitive" } },
            ],
          },
          orderBy: { requestedAt: "desc" },
          take,
          select: { id: true, email: true, plan: true, status: true, requestedAt: true },
        }),
        prisma.adminAuditLog.findMany({
          where: {
            OR: [
              { actorEmail: { contains: query, mode: "insensitive" } },
              { action: { contains: query, mode: "insensitive" } },
              { targetType: { contains: query, mode: "insensitive" } },
              { targetId: { contains: query, mode: "insensitive" } },
              { summary: { contains: query, mode: "insensitive" } },
            ],
          },
          orderBy: { createdAt: "desc" },
          take,
          select: { id: true, actorEmail: true, action: true, targetType: true, targetId: true, createdAt: true },
        }),
        prisma.conversation.findMany({
          where: {
            OR: [
              { id: { contains: query, mode: "insensitive" } },
              { title: { contains: query, mode: "insensitive" } },
              { shareToken: { contains: query, mode: "insensitive" } },
            ],
          },
          orderBy: { updatedAt: "desc" },
          take,
          select: { id: true, title: true, userId: true, updatedAt: true },
        }),
        prisma.message.findMany({
          where: {
            OR: [
              { id: { contains: query, mode: "insensitive" } },
              { content: { contains: query, mode: "insensitive" } },
              { modelId: { contains: query, mode: "insensitive" } },
            ],
          },
          orderBy: { createdAt: "desc" },
          take,
          select: { id: true, conversationId: true, modelId: true, createdAt: true },
        }),
      ]);

    return NextResponse.json({
      results: [
        ...users.map((user) => ({
          type: "User",
          id: user.id,
          title: user.email || user.name || user.id,
          detail: `${user.plan || "Free"} plan`,
          href: "/admin?tab=users",
          createdAt: null,
        })),
        ...feedback.map((item) => ({
          type: "Feedback",
          id: item.id,
          title: item.email || item.traceId || item.id,
          detail: `${item.type} / ${item.status}`,
          href: "/admin?tab=feedback",
          createdAt: toIso(item.createdAt),
        })),
        ...refunds.map((item) => ({
          type: "Refund",
          id: item.id,
          title: item.email || item.id,
          detail: `${item.plan || "Unknown"} / ${item.status}`,
          href: "/admin?tab=refunds",
          createdAt: toIso(item.requestedAt),
        })),
        ...auditLogs.map((item) => ({
          type: "Audit",
          id: item.id,
          title: item.action,
          detail: `${item.actorEmail || "Admin"} / ${item.targetType || "-"} ${item.targetId || ""}`,
          href: "/admin?tab=audit",
          createdAt: toIso(item.createdAt),
        })),
        ...conversations.map((item) => ({
          type: "Conversation",
          id: item.id,
          title: item.title,
          detail: `User ${item.userId}`,
          href: "/admin?tab=users",
          createdAt: toIso(item.updatedAt),
        })),
        ...messages.map((item) => ({
          type: "Message",
          id: item.id,
          title: item.modelId || item.id,
          detail: `Conversation ${item.conversationId}`,
          href: "/admin?tab=users",
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
