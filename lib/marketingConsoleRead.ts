import "server-only";

import { prisma } from "@/lib/prisma";
import { readMarketingAutomationSettings } from "@/lib/appSettings";
import { marketingWebhookApplyScopeSchema } from "@/lib/marketingAutomationAccess";
import {
  MARKETING_READ_PAGE_SIZE,
  marketingSectionAvailability,
  type MarketingConsoleSection,
  type MarketingSectionAvailability,
} from "@/lib/marketingConsoleSections";

/**
 * The one loader behind both the Marketing page and its GET route.
 *
 * The page renders the first payload on the server, so the rows are in the
 * HTML rather than arriving after hydration; the route serves the same shape
 * when the operator refreshes. Two readers would be two answers to "what does
 * this screen show", and the screen is an audit surface.
 *
 * Reading takes ordinary admin authentication
 * (docs/policy/marketing-automation.md §6.1, 기록 열람: 관리자 인증,
 * 스위치 무관); the callers check that, and nothing here checks a feature
 * switch before answering. The switch *states* travel with the payload
 * because an operator reading this page is usually asking why nothing
 * published, and "drafts are off" is that answer.
 */

export type MarketingSwitchState =
  | "on"
  | "off"
  | "scope-valid"
  | "scope-invalid"
  | "no-scope"
  | "unreadable";

export type MarketingSwitchStates = {
  drafts: MarketingSwitchState;
  publish: MarketingSwitchState;
  autoPublish: MarketingSwitchState;
  experiments: MarketingSwitchState;
  webhookShadow: MarketingSwitchState;
  /**
   * The state of the stored apply-scope document -- not whether the webhook is
   * applied to publish state.
   *
   * Parsed with the same schema the access decision uses, so a stored value
   * the resolver would refuse reads as invalid here rather than as a working
   * configuration. Two earlier versions of this row were wrong in the same
   * direction: a non-empty string was reported first as "on" and then as
   * "configured", and the stored string "not json" would have satisfied both.
   */
  webhookApplyScope: MarketingSwitchState;
};

export type MarketingConsolePayload = {
  section: MarketingConsoleSection;
  availability: MarketingSectionAvailability;
  /** How the listed rows were chosen, so the screen can say it exactly. */
  ordering: "newest" | "by-account";
  pageSize: number;
  rows: Record<string, unknown>[];
  switches: MarketingSwitchStates;
};

const state = (
  read: { ok: true; value: boolean } | { ok: false }
): MarketingSwitchState => (read.ok ? (read.value ? "on" : "off") : "unreadable");

/**
 * What the stored apply scope is, judged by the schema that judges it for real.
 *
 * No scope is the ordinary state today. An invalid one is a stored document
 * the access resolver would refuse, which is worth a screen precisely because
 * nothing else would tell an operator it is sitting there.
 */
const applyScopeState = (
  read: { ok: true; value: string | null } | { ok: false }
): MarketingSwitchState => {
  if (!read.ok) return "unreadable";
  if (!read.value) return "no-scope";
  try {
    return marketingWebhookApplyScopeSchema.safeParse(JSON.parse(read.value)).success
      ? "scope-valid"
      : "scope-invalid";
  } catch {
    return "scope-invalid";
  }
};

/** A draft's own words, shortened for a list row. */
const excerpt = (envelope: unknown): string | null => {
  if (!envelope || typeof envelope !== "object") return null;
  const value = (envelope as { renderedText?: unknown }).renderedText;
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/gu, " ").trim();
  if (flat.length === 0) return null;
  return flat.length > 180 ? `${flat.slice(0, 179)}…` : flat;
};

/**
 * Everything a post can be once a person has seen it.
 *
 * Deliberately not just the terminal four: a post sitting in `scheduled`, or
 * one that `failed`, or one whose outcome the publisher could not confirm, is
 * exactly what an operator opens this page to find. Listing only `published`
 * and `verified` would make the stuck ones invisible, which is the state that
 * most needs a screen.
 */
const PUBLISH_STATE_STATUSES = [
  "approved",
  "scheduled",
  "publishing",
  "published",
  "verified",
  "failed",
  "outcome_unknown",
  "removed_by_platform",
  "deleted",
] as const;

async function readSwitches(): Promise<MarketingSwitchStates> {
  try {
    const settings = await readMarketingAutomationSettings();
    return {
      drafts: state(settings.draftsEnabled),
      publish: state(settings.publishEnabled),
      autoPublish: state(settings.autoPublishEnabled),
      experiments: state(settings.experimentsEnabled),
      webhookShadow: state(settings.webhookShadowEnabled),
      webhookApplyScope: applyScopeState(settings.webhookApplyScopeValue),
    };
  } catch {
    // A switch strip that cannot be read says so. It never says "off",
    // because "off" is a claim and a failed read is not evidence for it.
    return {
      drafts: "unreadable",
      publish: "unreadable",
      autoPublish: "unreadable",
      experiments: "unreadable",
      webhookShadow: "unreadable",
      webhookApplyScope: "unreadable",
    };
  }
}

export async function readMarketingConsole(
  section: MarketingConsoleSection
): Promise<MarketingConsolePayload> {
  const [availability, switches] = [
    marketingSectionAvailability(section),
    await readSwitches(),
  ];

  if (!availability.available) {
    return {
      section,
      availability,
      ordering: "newest",
      pageSize: 0,
      rows: [],
      switches,
    };
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
      ordering: "newest",
      pageSize: MARKETING_READ_PAGE_SIZE,
      switches,
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
      where: { status: { in: [...PUBLISH_STATE_STATUSES] } },
      orderBy: { createdAt: "desc" },
      take: MARKETING_READ_PAGE_SIZE,
      select: {
        id: true,
        locale: true,
        status: true,
        mode: true,
        scheduledAt: true,
        externalUrl: true,
        publishedAt: true,
        verifiedPublicAt: true,
        verificationMethod: true,
        errorCode: true,
        outcomeUnknownAt: true,
        publishAttempt: true,
        channel: { select: { accountSlug: true, channel: true } },
      },
    });
    return {
      section,
      availability,
      ordering: "newest",
      pageSize: MARKETING_READ_PAGE_SIZE,
      switches,
      rows: posts.map((post) => ({
        id: post.id,
        accountSlug: post.channel.accountSlug,
        channel: post.channel.channel,
        locale: post.locale,
        status: post.status,
        mode: post.mode,
        scheduledAt: post.scheduledAt?.toISOString() ?? null,
        externalUrl: post.externalUrl,
        publishedAt: post.publishedAt?.toISOString() ?? null,
        verifiedPublicAt: post.verifiedPublicAt?.toISOString() ?? null,
        verificationMethod: post.verificationMethod,
        errorCode: post.errorCode,
        outcomeUnknownAt: post.outcomeUnknownAt?.toISOString() ?? null,
        publishAttempt: post.publishAttempt,
      })),
    };
  }

  if (section === "accounts") {
    const channels = await prisma.marketingChannel.findMany({
      orderBy: { createdAt: "desc" },
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
      ordering: "newest",
      pageSize: MARKETING_READ_PAGE_SIZE,
      switches,
      rows: channels.map((channel) => ({
        ...channel,
        approvalStartedAt: channel.approvalStartedAt?.toISOString() ?? null,
        graduatedAt: channel.graduatedAt?.toISOString() ?? null,
        pausedAt: channel.pausedAt?.toISOString() ?? null,
      })),
    };
  }

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
    ordering: "newest",
    pageSize: MARKETING_READ_PAGE_SIZE,
    switches,
    rows: reports.map((report) => ({
      ...report,
      periodStart: report.periodStart.toISOString(),
      periodEnd: report.periodEnd.toISOString(),
      createdAt: report.createdAt.toISOString(),
    })),
  };
}
