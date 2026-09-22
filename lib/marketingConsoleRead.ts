import "server-only";

import { prisma } from "@/lib/prisma";
import {
  marketingConfigGenerationFromValue,
  readMarketingAutomationSettings,
} from "@/lib/appSettings";
import { marketingWebhookApplyScopeStatus } from "@/lib/marketingAutomationAccess";
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
   * Judged by the access module's own `marketingWebhookApplyScopeStatus()`,
   * so the screen and the decision cannot disagree about a stored value.
   * Three earlier versions of this row were wrong in the same direction --
   * "on", then "configured", then a local parse that differed from the
   * resolver on an empty string and on a BOM -- each of them reporting the
   * presence of a value as though it were a working configuration.
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
  /**
   * The version token a switch change must send back, or null when it cannot
   * be read.
   *
   * Beside the switches rather than inside them: it is not a switch state, and
   * putting it in that map made the map stop being a map of states. Read from
   * the same snapshot as the values, because a screen showing old values with
   * a new generation would save against a state nobody saw.
   */
  configGeneration: number | null;
};

const state = (
  read: { ok: true; value: boolean } | { ok: false }
): MarketingSwitchState => (read.ok ? (read.value ? "on" : "off") : "unreadable");

/**
 * What the stored apply scope is, judged by the module that judges it for real.
 *
 * The judgement is not made here: `marketingWebhookApplyScopeStatus()` is the
 * access module's own, so the screen and the decision cannot disagree. Two
 * earlier versions of this made it locally and did disagree -- an empty string
 * read as "no scope" where the resolver refuses a stored document, and a
 * BOM-prefixed scope read as invalid where the resolver canonicalises the BOM
 * away and accepts it.
 *
 * No scope is the ordinary state today. An invalid one is worth a screen
 * precisely because nothing else would tell an operator it is sitting there.
 */
const applyScopeState = (
  read: { ok: true; value: string | null } | { ok: false }
): MarketingSwitchState => {
  if (!read.ok) return "unreadable";
  const status = marketingWebhookApplyScopeStatus(read.value);
  if (status === "absent") return "no-scope";
  return status === "valid" ? "scope-valid" : "scope-invalid";
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

async function readSwitches(): Promise<{
  switches: MarketingSwitchStates;
  configGeneration: number | null;
}> {
  try {
    const settings = await readMarketingAutomationSettings();
    return {
      configGeneration: settings.configGenerationValue.ok
        ? marketingConfigGenerationFromValue(settings.configGenerationValue.value)
        : null,
      switches: {
      drafts: state(settings.draftsEnabled),
      publish: state(settings.publishEnabled),
      autoPublish: state(settings.autoPublishEnabled),
      experiments: state(settings.experimentsEnabled),
      webhookShadow: state(settings.webhookShadowEnabled),
      webhookApplyScope: applyScopeState(settings.webhookApplyScopeValue),
      },
    };
  } catch {
    // A switch strip that cannot be read says so. It never says "off",
    // because "off" is a claim and a failed read is not evidence for it.
    return {
      configGeneration: null,
      switches: {
      drafts: "unreadable",
      publish: "unreadable",
      autoPublish: "unreadable",
      experiments: "unreadable",
      webhookShadow: "unreadable",
      webhookApplyScope: "unreadable",
      },
    };
  }
}

export async function readMarketingConsole(
  section: MarketingConsoleSection
): Promise<MarketingConsolePayload> {
  const availability = marketingSectionAvailability(section);
  const { switches, configGeneration } = await readSwitches();

  if (!availability.available) {
    return {
      section,
      availability,
      ordering: "newest",
      pageSize: 0,
      rows: [],
      switches,
      configGeneration,
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
        envelopeDigest: true,
        historyVersion: true,
        legalHold: true,
        reusableAsTemplate: true,
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
      configGeneration,
      rows: posts.map((post) => ({
        id: post.id,
        accountSlug: post.channel.accountSlug,
        channel: post.channel.channel,
        locale: post.locale,
        kind: post.kind,
        status: post.status,
        mode: post.mode,
        // The two values every post writer compares against. They are what
        // makes a decision about *this* version of the draft rather than
        // whichever version is there when the request lands.
        envelopeDigest: post.envelopeDigest,
        historyVersion: post.historyVersion,
        legalHold: post.legalHold,
        reusableAsTemplate: post.reusableAsTemplate,
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
        envelopeDigest: true,
        historyVersion: true,
        legalHold: true,
        scheduledAt: true,
        externalPostId: true,
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
      configGeneration,
      rows: posts.map((post) => ({
        id: post.id,
        accountSlug: post.channel.accountSlug,
        channel: post.channel.channel,
        locale: post.locale,
        status: post.status,
        mode: post.mode,
        envelopeDigest: post.envelopeDigest,
        historyVersion: post.historyVersion,
        legalHold: post.legalHold,
        scheduledAt: post.scheduledAt?.toISOString() ?? null,
        // The id the unpublish writer compares against, not a link: an
        // operator saying a post is gone has to be saying it about the post
        // the row names.
        externalPostId: post.externalPostId,
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
        // The four values the identity and connection writers compare
        // against. Without them the console can display an account it cannot
        // act on, which is the defect the round-2 review found one table over.
        connectionGeneration: true,
        scopesDigest: true,
        policyVersion: true,
        graduationEpoch: true,
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
      configGeneration,
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
    configGeneration,
    rows: reports.map((report) => ({
      ...report,
      periodStart: report.periodStart.toISOString(),
      periodEnd: report.periodEnd.toISOString(),
      createdAt: report.createdAt.toISOString(),
    })),
  };
}
