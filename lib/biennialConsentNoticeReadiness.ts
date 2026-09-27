import "server-only";

import { prisma } from "@/lib/prisma";
import { jurisdictionForUser } from "@/lib/emailJurisdiction";
import { marketingSendingConfigured } from "@/lib/emailUnsubscribeReadiness";
import { CONSENT_REQUIRED_PURPOSES } from "@/lib/emailPreferenceCore";
import {
  BIENNIAL_NOTICE_INTERVAL_MONTHS,
  BIENNIAL_NOTICE_WARN_DAYS,
  biennialNoticeVerdict,
  type BiennialAnchor,
} from "@/lib/biennialConsentNoticeCore";

/**
 * When Korea's two-yearly consent notice first falls due, per recipient.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.7, which
 * defers the notice itself and says what to put in its place: "잊지 않는 장치는
 * 지금 둡니다" -- the earliest `actual consent ?? noticeAnchorAt` plus two years
 * across Korean recipients, warning sixty days out and blocking past it.
 *
 * ## Why a deferral needs this and not only a date
 *
 * The duty row carries `dueBy: 2028-01-01`, the year section 7.7 reasoned to
 * from the cohort's 2026 signups. A seed cannot know when the earliest anchor
 * actually is, and `obligationsVerdict()` takes this answer as the deadline that
 * applies where it is earlier. A deferral watched only by its backstop expires
 * on the day somebody guessed.
 *
 * ## Korean the way a send decides it
 *
 * The first version read `ConsentRecord.jurisdiction = 'KR'` and a
 * `UserSettings` field that does not exist. A review was right twice over: the
 * query could not run, and even fixed it would have described a different set
 * of people from the one a send describes. Whether a person is Korean is
 * `resolveEmailJurisdiction()`'s answer -- billing country, declaration and its
 * timing, the latest consent, and conflicts -- so this asks
 * `jurisdictionForUser()`, the same call the drain makes, per candidate.
 *
 * Candidates are the accounts that could receive marketing at all: anyone with
 * a consent record for a consent-required purpose, and the members of a sealed,
 * unrevoked `risk_accepted` approval. Asking the whole user table would be a
 * jurisdiction lookup per account for a question about a few.
 *
 * ## Which anchor, and whose
 *
 * A person anchored on their own consent: the earliest purpose whose **latest**
 * action is a grant. The first version took the oldest grant regardless, so a
 * withdrawn consent still anchored someone and a re-grant kept the old date.
 *
 * A `risk_accepted` member never consented, and section 7.7 with L12 anchors
 * them on `noticeAnchorAt` -- the signup date, recorded as
 * `signup_date_deemed`, deliberately not a `ConsentRecord`. Where both exist the
 * consent wins and the member row is untouched, which section 7.7 says in as
 * many words.
 */

export type BiennialNoticeReadiness = {
  /** Whether the answer can hold anything back yet. */
  required: boolean;
  /** Whether the duty's deadline has not passed. */
  healthy: boolean;
  /** The earliest deadline, or null when nobody is anchored. */
  earliestDueAt: Date | null;
  recipients: number;
  problems: Array<{
    severity: "error" | "warning";
    code: "EMAIL_BIENNIAL_CONSENT_NOTICE_DUE" | "EMAIL_BIENNIAL_CONSENT_NOTICE_SOON";
    message: string;
  }>;
};

/** The accounts a Korean marketing message could reach, before jurisdiction. */
async function candidates(): Promise<
  Map<string, { consentAnchor: Date | null; deemedAnchor: Date | null }>
> {
  const out = new Map<string, { consentAnchor: Date | null; deemedAnchor: Date | null }>();

  // The latest action per (user, purpose), by address, which is where consent
  // attaches -- the same reading the send's own withdrawal check uses.
  const latest = await prisma.$queryRaw<
    { userId: string; action: string; occurredAt: Date }[]
  >`
    SELECT DISTINCT ON ("userId", purpose)
           "userId", action, "occurredAt"
      FROM "ConsentRecord"
     WHERE "userId" IS NOT NULL
       AND purpose = ANY(${[...CONSENT_REQUIRED_PURPOSES]}::text[])
     ORDER BY "userId", purpose, "occurredAt" DESC, "createdAt" DESC
  `;
  for (const row of latest) {
    if (row.action !== "granted" && row.action !== "reconfirmed") continue;
    const seen = out.get(row.userId) ?? { consentAnchor: null, deemedAnchor: null };
    if (seen.consentAnchor === null || row.occurredAt < seen.consentAnchor) {
      seen.consentAnchor = row.occurredAt;
    }
    out.set(row.userId, seen);
  }

  const members = await prisma.emailSendApprovalMember.findMany({
    where: {
      approval: {
        approvalType: "risk_accepted",
        sealedAt: { not: null },
        revocations: { none: {} },
      },
    },
    select: { userId: true, noticeAnchorAt: true },
  });
  for (const row of members) {
    const seen = out.get(row.userId) ?? { consentAnchor: null, deemedAnchor: null };
    if (seen.deemedAnchor === null || row.noticeAnchorAt < seen.deemedAnchor) {
      seen.deemedAnchor = row.noticeAnchorAt;
    }
    out.set(row.userId, seen);
  }

  return out;
}

async function koreanAnchors(): Promise<BiennialAnchor[]> {
  const anchors: BiennialAnchor[] = [];
  for (const [userId, found] of await candidates()) {
    const jurisdiction = await jurisdictionForUser({ userId });
    // High confidence only: an inferred or conflicting country is not a finding
    // that somebody is Korean, and the send would not treat it as one either.
    if (jurisdiction.countryCode !== "KR" || jurisdiction.confidence !== "high") continue;
    if (found.consentAnchor !== null) {
      anchors.push({ userId, anchoredAt: found.consentAnchor, source: "consent" });
      continue;
    }
    if (found.deemedAnchor !== null) {
      anchors.push({
        userId,
        anchoredAt: found.deemedAnchor,
        source: "signup_date_deemed",
      });
    }
  }
  return anchors;
}

export async function biennialNoticeReadiness(
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date()
): Promise<BiennialNoticeReadiness> {
  const verdict = biennialNoticeVerdict({ anchors: await koreanAnchors(), now });
  return {
    required: marketingSendingConfigured(env),
    healthy: verdict.problems.every((problem) => problem.severity !== "error"),
    earliestDueAt: verdict.earliestDueAt,
    recipients: verdict.recipients,
    problems: verdict.problems,
  };
}

export { BIENNIAL_NOTICE_INTERVAL_MONTHS, BIENNIAL_NOTICE_WARN_DAYS };
