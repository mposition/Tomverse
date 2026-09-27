import "server-only";

import { prisma } from "@/lib/prisma";
import {
  BIENNIAL_NOTICE_INTERVAL_MONTHS,
  BIENNIAL_NOTICE_WARN_DAYS,
  biennialNoticeVerdict,
  type BiennialAnchor,
} from "@/lib/biennialConsentNoticeCore";

/**
 * When Korea's two-yearly notice first falls due, per recipient.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.7, which
 * defers the notice itself and says what to put in its place: "잊지 않는 장치는
 * 지금 둡니다" -- readiness computes `actual consent ?? noticeAnchorAt` plus two
 * years for every Korean recipient, warns sixty days before the earliest of
 * them, and blocks the Korean rule once that one has passed.
 *
 * ## Why a deferral needs this and not only a date
 *
 * The duty row carries `dueBy: 2028-01-01`, which is the year section 7.7
 * names, reasoning that the existing accounts all signed up in 2026. That date
 * is a backstop written by a seed; it cannot know when the earliest anchor
 * actually is, and the deadline that matters is a fact about rows. A deferral
 * watched only by its own constant is a deferral that expires on the day
 * somebody guessed.
 *
 * ## Two anchors, and the one that wins
 *
 * A person who actually consented is anchored on their consent. A
 * `risk_accepted` cohort member never did, and section 7.7 (with L12) anchors
 * them on their signup date, recorded as `EmailSendApprovalMember.noticeAnchorAt`
 * with `noticeAnchorSource: signup_date_deemed` -- deliberately not a
 * `ConsentRecord`, because the ledger holds consents and this is not one. Where
 * both exist the consent wins, and the member row is not edited: section 7.7
 * says so in as many words.
 */

export type BiennialNoticeReadiness = {
  ready: boolean;
  /** Whether the answer can hold anything back yet. */
  required: boolean;
  /** The earliest deadline, or null when nobody is anchored. */
  earliestDueAt: Date | null;
  /** How many recipients are anchored at all. */
  recipients: number;
  problems: Array<{
    severity: "error" | "warning";
    code: "EMAIL_BIENNIAL_CONSENT_NOTICE_DUE" | "EMAIL_BIENNIAL_CONSENT_NOTICE_SOON";
    message: string;
  }>;
};

/**
 * Every Korean recipient's anchor: their own consent where they gave one, and
 * the deemed signup date where a sealed approval covers them.
 *
 * Korean by the jurisdiction recorded on the consent, and by the country
 * settled for the account otherwise -- the same two facts a send would read,
 * rather than a third idea of who is Korean.
 */
async function koreanAnchors(): Promise<BiennialAnchor[]> {
  const consents = await prisma.consentRecord.findMany({
    where: { action: "granted", jurisdiction: "KR", userId: { not: null } },
    select: { userId: true, occurredAt: true },
    orderBy: { occurredAt: "asc" },
  });

  const members = await prisma.emailSendApprovalMember.findMany({
    where: {
      approval: { approvalType: "risk_accepted", sealedAt: { not: null } },
      user: { settings: { selfDeclaredCountry: "KR" } },
    },
    select: { userId: true, noticeAnchorAt: true },
  });

  const byUser = new Map<string, BiennialAnchor>();
  // The deemed anchors first, so an actual consent overwrites one.
  for (const row of members) {
    byUser.set(row.userId, {
      userId: row.userId,
      anchoredAt: row.noticeAnchorAt,
      source: "signup_date_deemed",
    });
  }
  for (const row of consents) {
    if (!row.userId) continue;
    const existing = byUser.get(row.userId);
    if (existing?.source === "consent" && existing.anchoredAt <= row.occurredAt) continue;
    byUser.set(row.userId, {
      userId: row.userId,
      anchoredAt: row.occurredAt,
      source: "consent",
    });
  }
  return [...byUser.values()];
}

export async function biennialNoticeReadiness(
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date()
): Promise<BiennialNoticeReadiness> {
  const { marketingSendingConfigured } = await import("@/lib/emailUnsubscribeReadiness");
  const required = marketingSendingConfigured(env);
  const verdict = biennialNoticeVerdict({ anchors: await koreanAnchors(), now });
  return {
    // The same shape the keyring and the business identity use: not knowing, or
    // knowing badly, holds nothing back until marketing is configured.
    ready: verdict.problems.every((problem) => problem.severity !== "error") || !required,
    required,
    earliestDueAt: verdict.earliestDueAt,
    recipients: verdict.recipients,
    problems: verdict.problems,
  };
}

export { BIENNIAL_NOTICE_INTERVAL_MONTHS, BIENNIAL_NOTICE_WARN_DAYS };
