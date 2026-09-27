import "server-only";

import { prisma } from "@/lib/prisma";
import { sendablePolicyVersionIds } from "@/lib/emailSendableProfiles";
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
 * Candidates are the accounts a Korean marketing message could reach: anyone
 * whose current address has a consent record for a consent-required purpose, and
 * the members of a sealed, unrevoked `risk_accepted` approval scoped to such a
 * purpose on the active policy version. Asking the whole user table would be a
 * jurisdiction lookup per account for a question about a few.
 *
 * The policy versions asked about are every one a message could still be sent
 * under: the active one and any a pending delivery is pinned to. Asking only
 * about the active version was a real hole rather than a conservative
 * simplification, and a review named it -- an approval is valid for the version
 * the delivery carries, so a cohort approved under an older version is a cohort a
 * queued message can still be sent to, and leaving it out makes the deadline
 * later or absent.
 *
 * What remains unapplied is the member's address digest against the account's
 * address now, which needs the normalisation the cohort was sealed with. That one
 * can only shrink the set, so a smaller set has a later deadline and the error
 * runs towards refusing Korean marketing early. That claim is about this filter
 * and not about the candidate set as a whole.
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

  // The latest action per (user, purpose), among the records for the address the
  // account uses now.
  //
  // Consent attaches to an address rather than to an account
  // (docs/policy/email-notifications.md section 13.4), and `ConsentRecord` keeps
  // the address as it was. So a `granted` record for a mailbox somebody has since
  // stopped using is not a consent that could be relied on, and counting it put
  // an anchor -- and therefore a deadline -- on a person no Korean message would
  // go to. The first version of this query said "by address" in a comment and
  // did not do it, which a review pointed out.
  //
  // Normalised the way suppression normalises an address, so a change of case is
  // not a change of mailbox.
  const latest = await prisma.$queryRaw<
    { userId: string; action: string; occurredAt: Date }[]
  >`
    SELECT DISTINCT ON (c."userId", c.purpose)
           c."userId", c.action, c."occurredAt"
      FROM "ConsentRecord" c
      JOIN "User" u ON u."id" = c."userId"
     WHERE c."userId" IS NOT NULL
       AND c.purpose = ANY(${[...CONSENT_REQUIRED_PURPOSES]}::text[])
       AND u."email" IS NOT NULL
       AND lower(btrim(c."emailAddress")) = lower(btrim(u."email"))
     ORDER BY c."userId", c.purpose, c."occurredAt" DESC, c."createdAt" DESC
  `;
  for (const row of latest) {
    if (row.action !== "granted" && row.action !== "reconfirmed") continue;
    const seen = out.get(row.userId) ?? { consentAnchor: null, deemedAnchor: null };
    if (seen.consentAnchor === null || row.occurredAt < seen.consentAnchor) {
      seen.consentAnchor = row.occurredAt;
    }
    out.set(row.userId, seen);
  }

  // The cohort of an override that could actually mail somebody: sealed,
  // unrevoked, scoped to a purpose that needs consent, and on a policy version a
  // message could still be sent under. The first version asked only for sealed
  // and unrevoked, so an approval scoped to a purpose that needs no consent at
  // all put its members' anchors into this answer; the second asked only about
  // the active version, and an approval is valid for the version the delivery
  // carries -- so a cohort approved under an older version, with messages still
  // queued under it, was left out and the deadline came out later or absent.
  //
  // What is still not compared here is the member's address digest against the
  // account's address now. That comparison is the send's own
  // (`overrideWouldSend()`), and it needs the normalisation the cohort was sealed
  // with; this module cannot reproduce it without the slice that writes these
  // rows. Until the two meet, a member who has changed address is still counted:
  // that filter can only shrink the set, so the deadline is earlier than it needs
  // to be, which refuses Korean marketing rather than sending it.
  const active = await prisma.emailPolicyVersion.findFirst({
    where: { status: "active" },
    select: { id: true },
  });
  const members = active
    ? await prisma.emailSendApprovalMember.findMany({
        where: {
          approval: {
            approvalType: "risk_accepted",
            sealedAt: { not: null },
            revocations: { none: {} },
            policyVersionId: { in: await sendablePolicyVersionIds(active.id) },
            purposeKey: { in: ["*", ...CONSENT_REQUIRED_PURPOSES] },
          },
        },
        select: { userId: true, noticeAnchorAt: true },
      })
    : [];
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
