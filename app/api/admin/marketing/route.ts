export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";
import {
  MARKETING_READ_PAGE_SIZE,
  marketingSectionAvailability,
  type MarketingConsoleSection,
} from "@/lib/marketingConsoleSections";

/**
 * Everything the Marketing console reads, and nothing it writes.
 *
 * Authorisation is ordinary admin authentication and nothing else
 * (docs/policy/marketing-automation.md §6.1, 기록 열람: 관리자 인증, 스위치 무관).
 * Reading the queue is how an operator finds out why nothing published, so a
 * feature switch being off changes what this returns, never whether it answers,
 * and recent-authentication step-up belongs to the mutations that S2b1 adds --
 * not here. A reader refused because their sign-in aged out cannot tell a
 * stopped pipeline from a broken console.
 */

const querySchema = z
  .object({
    section: z.enum([
      "queue",
      "published",
      "accounts",
      "experiments",
      "reports",
      "comments",
    ]),
  })
  .strict();

/** A draft's own words, shortened for a list row. */
const excerpt = (envelope: unknown): string | null => {
  if (!envelope || typeof envelope !== "object") return null;
  const text = (envelope as { renderedText?: unknown }).renderedText;
  if (typeof text !== "string") return null;
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length === 0) return null;
  return flat.length > 180 ? `${flat.slice(0, 179)}…` : flat;
};

async function readSection(section: MarketingConsoleSection) {
  const availability = marketingSectionAvailability(section);
  if (!availability.available) {
    return { section, availability, rows: [], pageSize: 0 };
  }

  if (section === "queue") {
    const posts = await prisma.marketingPost.findMany({
      where: { status: { in: ["drafted", "pending_approval"] } },
      orderBy: { createdAt: "desc" },
      take: MARKETING_READ_PAGE_SIZE,
      select: {
        id: true,
        locale: true,
        kind: true,
        status: true,
        mode: true,
        guardDecision: true,
        guardCodes: true,
        guardRuleIds: true,
        envelope: true,
        approvalExpiresAt: true,
        createdAt: true,
        channel: { select: { accountSlug: true, channel: true } },
      },
    });
    return {
      section,
      availability,
      pageSize: MARKETING_READ_PAGE_SIZE,
      rows: posts.map((post) => ({
        id: post.id,
        accountSlug: post.channel.accountSlug,
        channel: post.channel.channel,
        locale: post.locale,
        kind: post.kind,
        status: post.status,
        mode: post.mode,
        guardDecision: post.guardDecision,
        guardCodes: post.guardCodes,
        guardRuleIds: post.guardRuleIds,
        excerpt: excerpt(post.envelope),
        approvalExpiresAt: post.approvalExpiresAt?.toISOString() ?? null,
        createdAt: post.createdAt.toISOString(),
      })),
    };
  }

  if (section === "published") {
    const posts = await prisma.marketingPost.findMany({
      where: {
        status: { in: ["published", "verified", "removed_by_platform", "deleted"] },
      },
      orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
      take: MARKETING_READ_PAGE_SIZE,
      select: {
        id: true,
        locale: true,
        status: true,
        mode: true,
        externalUrl: true,
        publishedAt: true,
        verifiedPublicAt: true,
        verificationMethod: true,
        channel: { select: { accountSlug: true, channel: true } },
      },
    });
    return {
      section,
      availability,
      pageSize: MARKETING_READ_PAGE_SIZE,
      rows: posts.map((post) => ({
        id: post.id,
        accountSlug: post.channel.accountSlug,
        channel: post.channel.channel,
        locale: post.locale,
        status: post.status,
        mode: post.mode,
        externalUrl: post.externalUrl,
        publishedAt: post.publishedAt?.toISOString() ?? null,
        verifiedPublicAt: post.verifiedPublicAt?.toISOString() ?? null,
        verificationMethod: post.verificationMethod,
      })),
    };
  }

  if (section === "accounts") {
    const channels = await prisma.marketingChannel.findMany({
      orderBy: [{ channel: "asc" }, { accountSlug: "asc" }],
      take: MARKETING_READ_PAGE_SIZE,
      select: {
        id: true,
        channel: true,
        accountSlug: true,
        provider: true,
        defaultLocale: true,
        allowedLocales: true,
        status: true,
        approvalStartedAt: true,
        graduatedAt: true,
        pausedAt: true,
        pausedFromMode: true,
        pauseReasonCode: true,
        dailyCapOverride: true,
        weeklyCapOverride: true,
      },
    });
    return {
      section,
      availability,
      pageSize: MARKETING_READ_PAGE_SIZE,
      rows: channels.map((channel) => ({
        ...channel,
        approvalStartedAt: channel.approvalStartedAt?.toISOString() ?? null,
        graduatedAt: channel.graduatedAt?.toISOString() ?? null,
        pausedAt: channel.pausedAt?.toISOString() ?? null,
      })),
    };
  }

  // reports
  const reports = await prisma.marketingReport.findMany({
    orderBy: { createdAt: "desc" },
    take: MARKETING_READ_PAGE_SIZE,
    select: {
      id: true,
      kind: true,
      periodStart: true,
      periodEnd: true,
      sourceVersion: true,
      createdAt: true,
    },
  });
  return {
    section,
    availability,
    pageSize: MARKETING_READ_PAGE_SIZE,
    rows: reports.map((report) => ({
      ...report,
      periodStart: report.periodStart.toISOString(),
      periodEnd: report.periodEnd.toISOString(),
      createdAt: report.createdAt.toISOString(),
    })),
  };
}

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-marketing-read", {
      minute: 60,
      day: 600,
    });

    const parsed = querySchema.safeParse({
      section: new URL(req.url).searchParams.get("section") ?? "queue",
    });
    if (!parsed.success) {
      return NextResponse.json({ error: "Unknown section." }, { status: 400 });
    }

    return NextResponse.json(await readSection(parsed.data.section));
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load the marketing console:", error);
    return NextResponse.json(
      { error: "Failed to load marketing data." },
      { status: 500 }
    );
  }
}
