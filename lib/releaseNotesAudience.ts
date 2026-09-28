import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { emailTemplateDefinition } from "@/lib/emailTemplateDefinitions";
import { ensureTemplateVersion } from "@/lib/emailTemplateRegistry";
import { isLanguage } from "@/lib/language";
import { releaseNotesEnqueueDecision } from "@/lib/releaseNotesEnqueueDecision";
import { releaseNotesSkipReason } from "@/lib/releaseNotesSkipReasonCore";
import { isEmailMarketingEnabled } from "@/lib/appSettings";

/**
 * Who a release-notes campaign is for, and how many of them it would reach.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md sections 5.6, 7.6
 * and 12 (S9: "audience, estimate and drain share the verdict; a preview with no
 * rows").
 *
 * ## One candidate set, two readers
 *
 * The estimate and the expansion each wrote their own query, and both asked the
 * same narrow question: who holds a confirmed preference. That left out the one
 * population section 5.6 exists for -- the accounts sealed into a
 * `risk_accepted` approval, which by design have no preference row -- so a
 * campaign could never reach them, and the verdict's override code was
 * unreachable from the only path that sends to an audience. And because
 * neither query asked the verdict, the number an operator approved was the
 * count of consents, not the count of messages that would go.
 *
 * So there is one candidate condition, `releaseNotesAudienceWhere()`, and both
 * read it. The candidate set is deliberately wider than the send: the verdict,
 * not the query, decides who is sent to, and a query that tried to decide would
 * be a second answer to the question section 7.6 wants answered once.
 *
 * ## The preview writes nothing
 *
 * A dry run writes delivery rows and marks them. This does not: it takes the
 * enqueue-phase verdict for each candidate, exactly as the expansion will, and
 * counts. That is the number the approval rests on.
 */

/** The accounts a sealed, unrevoked approval covers for this purpose and version. */
const cohortMemberIds = async (input: {
  purpose: string;
  policyVersionId: string;
}): Promise<string[]> => {
  const members = await prisma.emailSendApprovalMember.findMany({
    where: {
      approval: {
        approvalType: "risk_accepted",
        sealedAt: { not: null },
        revocations: { none: {} },
        policyVersionId: input.policyVersionId,
        // The scope rule `approvalScopeRefusal()` applies: an approval names
        // one purpose or every purpose. Filtering here only keeps members of an
        // out-of-scope approval out of the candidate set; the verdict still
        // judges the scope for everyone who is in it.
        purposeKey: { in: [input.purpose, "*"] },
      },
    },
    select: { userId: true },
    distinct: ["userId"],
  });
  return members.map((member) => member.userId);
};

/**
 * The candidate condition both the estimate and the expansion read.
 *
 * Active accounts with an address that either hold a confirmed preference for
 * the purpose or are covered by a sealed `risk_accepted` approval.
 */
export async function releaseNotesAudienceWhere(input: {
  purpose: string;
  policyVersionId: string;
}): Promise<Prisma.UserWhereInput> {
  const memberIds = await cohortMemberIds(input);
  return {
    accountStatus: "active",
    OR: [
      {
        emailPreferences: {
          some: {
            purpose: input.purpose,
            enabled: true,
            grantedAt: { not: null },
            // Confirmed consent only (docs/policy/email-double-opt-in.md §6).
            confirmedAt: { not: null },
          },
        },
      },
      ...(memberIds.length > 0 ? [{ id: { in: memberIds } }] : []),
    ],
  };
}

export type ReleaseNotesAudiencePreview = {
  /** Accounts the candidate condition returned. */
  candidates: number;
  /** Of those, the ones with an address to write to. */
  withEmail: number;
  /**
   * Candidates covered by a sealed approval, whether or not they also consented
   * -- the population a query on consent alone could not reach.
   */
  cohortMembers: number;
  /** Messages the verdict allows now. */
  allowed: number;
  /**
   * Messages the verdict would allow once release notes are live.
   *
   * Separate because section 12 makes the switch the last step: an estimate
   * taken before it would otherwise read zero for every campaign, which is true
   * and useless. This is the count whose only refusal is the switch itself.
   */
  allowedWhenLive: number;
  /** Of `allowedWhenLive`, those held back only by the release-notes switch. */
  awaitingSwitch: number;
  /** Whether marketing as a whole was on when this was taken. */
  marketingOn: boolean;
  /** Refused candidates, by the word the drain would record. Excludes `awaitingSwitch`. */
  refusedBy: Record<string, number>;
};

export async function releaseNotesAudiencePreview(input: {
  purpose: string;
  templateKey: string;
  policyVersionId: string;
  /**
   * The language a recipient will actually be sent in, given the one they
   * prefer. The expansion falls back to approved English and then to the
   * campaign's first approved locale, and the template version -- which is
   * inside the display contract -- follows the language. A preview that used the
   * preferred language would compose a different contract from the one the
   * expansion pins.
   */
  languageFor?: (preferred: string) => string;
}): Promise<ReleaseNotesAudiencePreview> {
  const [where, memberIds] = await Promise.all([
    releaseNotesAudienceWhere(input),
    cohortMemberIds(input),
  ]);
  const members = new Set(memberIds);
  const candidates = await prisma.user.findMany({
    where,
    orderBy: { id: "asc" },
    select: { id: true, email: true, settings: { select: { language: true } } },
  });

  const definition = emailTemplateDefinition(input.templateKey);
  // One template version per language, resolved once: the id is inside the
  // display contract, so the preview has to use the version the expansion will.
  const templateVersions = new Map<string, string>();
  const templateVersionFor = async (language: string) => {
    const known = templateVersions.get(language);
    if (known) return known;
    const version = await ensureTemplateVersion({ templateKey: input.templateKey, language });
    templateVersions.set(language, version.templateVersionId);
    return version.templateVersionId;
  };

  // `feature_disabled` covers two switches, and only one of them is the last
  // step of the activation order. Marketing as a whole is off in production
  // until the sending accounts are split, and while it is, switching release
  // notes on sends nothing -- the expansion refuses with `marketing_disabled`.
  // So "would send once live" is counted only when marketing is already on;
  // otherwise it would be a number of messages that switching release notes on
  // does not send.
  const marketingOn = await isEmailMarketingEnabled();

  const preview: ReleaseNotesAudiencePreview = {
    candidates: candidates.length,
    withEmail: 0,
    cohortMembers: 0,
    allowed: 0,
    allowedWhenLive: 0,
    awaitingSwitch: 0,
    marketingOn,
    refusedBy: {},
  };

  for (const candidate of candidates) {
    if (members.has(candidate.id)) preview.cohortMembers += 1;
    if (!candidate.email) {
      preview.refusedBy.no_email = (preview.refusedBy.no_email ?? 0) + 1;
      continue;
    }
    preview.withEmail += 1;

    const { verdict } = await releaseNotesEnqueueDecision({
      userId: candidate.id,
      purpose: input.purpose,
      classification: definition.classification,
      emailAddress: candidate.email,
      policyVersionId: input.policyVersionId,
      templateVersionId: await templateVersionFor(
        (input.languageFor ?? ((preferred: string) => preferred))(
          isLanguage(candidate.settings?.language) ? candidate.settings.language : "en"
        )
      ),
    });

    if (verdict.allowed) {
      preview.allowed += 1;
      preview.allowedWhenLive += 1;
      continue;
    }
    const onlyTheSwitch =
      marketingOn &&
      verdict.blockers.length === 1 &&
      verdict.blockers[0] === "feature_disabled" &&
      (verdict.legalAllowed || verdict.overrideApplied !== null);
    if (onlyTheSwitch) {
      // Counted once. Filing them under `marketing_disabled` as well put the
      // same person in the approved column and the excluded column.
      preview.allowedWhenLive += 1;
      preview.awaitingSwitch += 1;
      continue;
    }

    const reason = releaseNotesSkipReason(verdict) ?? "unknown";
    preview.refusedBy[reason] = (preview.refusedBy[reason] ?? 0) + 1;
  }
  return preview;
}
