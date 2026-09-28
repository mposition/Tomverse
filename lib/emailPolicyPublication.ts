import "server-only";

import { prisma } from "@/lib/prisma";
import { isEmailReleaseNotesEnabled } from "@/lib/appSettings";
import { SITEMAP_CONTENT_EVIDENCE } from "@/lib/sitemapContentDates";
import { emailTemplateDefinition, EMAIL_TEMPLATE_KEYS } from "@/lib/emailTemplateDefinitions";
import {
  AMENDED_DOCUMENT_PATHS,
  publicationProblems,
  type AmendedDocument,
  type ChangeNoticeFacts,
  type PublicationProblem,
} from "@/lib/emailPolicyPublicationCore";

/**
 * S10's gate, and where it stands.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md sections 10, 11
 * approval E and 12 (S10).
 *
 * ## Why the gate is on the flag's reader
 *
 * Section 12 orders activation as: documents in force, policy version active,
 * readiness confirmed, and only then the release-notes flag. The flag has no
 * writer in this application -- an operator sets the `AppSetting` row -- so a
 * refusal at write time would guard nothing. And every email policy draft now
 * carries the release-notes country rules, so refusing *policy activation* would
 * block every email policy change, including the ones that have nothing to do
 * with release notes.
 *
 * So `isEmailReleaseNotesLive()` is the reader every caller asks, and it answers
 * yes only when the stored flag is on **and** this amendment is published. A flag
 * switched on early is then a flag that does nothing yet, which is the honest
 * state: the pages still promise mail only on request, and a product that sent
 * release notes under that promise is the Gateway Learning shape section 5.5
 * names.
 *
 * ## Recorded digests, not recomputed ones
 *
 * The obvious implementation reads `components/legal/PrivacyPolicy.tsx` and the
 * locale files and hashes them. It would be wrong twice: a production build has
 * no guarantee those source files are on disk, and a second implementation of
 * the digest is a second answer to the question `tests/sitemapLastModified.
 * test.mjs` already answers.
 *
 * So both sides of the comparison are constants. `SITEMAP_CONTENT_EVIDENCE` holds
 * what the page renders now -- and that test fails the build unless it really
 * does -- while `DIGEST_BEFORE_AMENDMENT` holds what it rendered before.
 *
 * ## `/terms` has no entry, and that is the honest answer
 *
 * `SITEMAP_CONTENT_EVIDENCE` deliberately omits `/terms`: its own module records
 * that the displayed "Last updated" line did not move across three edits to the
 * copy, so the date on the page is evidence of nothing. The gate reports
 * `document_state_unrecorded` for `/terms` rather than passing it, which is the
 * true state -- nothing in this repository vouches for what `/terms` says or when
 * it last changed.
 */

/**
 * What each document rendered before the amendment approval E describes.
 *
 * `/privacy`: the digest recorded on 2026-09-14, which is the state section 10
 * quotes when it says the policy currently promises mail only on request. A path
 * with no entry is `document_state_unrecorded`: a document whose previous state
 * nobody wrote down cannot be shown to have changed.
 */
export const DIGEST_BEFORE_AMENDMENT: Readonly<Record<string, string>> = {
  "/privacy": "ac3b5f82fa492671259539bf426e52e17824f27f673dc5d3396d1fa4bc9c9233",
};

/**
 * The template that carries the amendment notice, once one exists.
 *
 * Null until the approved wording is written. Null is `change_notice_unidentified`,
 * a refusal: section 10 has the legal copy drafted and approved before it is
 * implemented, and a gate that passed while no notice existed would let the rules
 * go live silently -- the thing approval E is about.
 */
export const CHANGE_NOTICE_TEMPLATE_KEY: string | null = null;

const documentFacts = (): AmendedDocument[] =>
  AMENDED_DOCUMENT_PATHS.map((path) => {
    const evidence = SITEMAP_CONTENT_EVIDENCE[path];
    return {
      path,
      digestBeforeAmendment: DIGEST_BEFORE_AMENDMENT[path] ?? null,
      publishedDigest: evidence?.contentSha256 ?? null,
      effectiveFrom: evidence?.date ?? null,
    };
  });

const UNIDENTIFIED: ChangeNoticeFacts = {
  templateKey: null,
  classification: null,
  purpose: null,
  owed: 0,
  delivered: 0,
  firstSentAt: null,
};

/**
 * How many accounts are owed the notice, and how many a delivery reached.
 *
 * Owed is every account with an address that existed **when the first notice
 * went out**. A service or legal notice is owed to everybody, including the
 * people who turned marketing off. An account created afterwards signed up under
 * the amended documents and was shown them at signup; counting it as owed would
 * make the gate fail again with every new signup, for a notice nobody owes them.
 *
 * Fixing the population at the first send is also what makes a pass stable:
 * the owed set stops growing, and delivered deliveries do not un-deliver.
 */
const noticeFacts = async (): Promise<ChangeNoticeFacts> => {
  const templateKey = CHANGE_NOTICE_TEMPLATE_KEY;
  // A key no template defines is as unidentified as none at all, and asking
  // `emailTemplateDefinition()` for it would throw.
  if (
    templateKey === null ||
    !EMAIL_TEMPLATE_KEYS.includes(templateKey as (typeof EMAIL_TEMPLATE_KEYS)[number])
  ) {
    return UNIDENTIFIED;
  }
  const definition = emailTemplateDefinition(templateKey);
  const sentFor = { templateVersion: { template: { key: templateKey } }, status: "sent" };

  const first = await prisma.emailDelivery.findFirst({
    where: sentFor,
    orderBy: { sentAt: "asc" },
    select: { sentAt: true },
  });
  const firstSentAt = first?.sentAt ?? null;

  const [owed, delivered] = await Promise.all([
    prisma.user.count({
      where: {
        email: { not: null },
        ...(firstSentAt ? { createdAt: { lte: firstSentAt } } : {}),
      },
    }),
    // Accounts, not deliveries: a person whose first notice bounced and whose
    // retry went out is one person told, and counting rows would let a single
    // account's retries stand in for somebody who was never reached.
    prisma.emailDelivery
      .findMany({
        where: { ...sentFor, userId: { not: null } },
        distinct: ["userId"],
        select: { userId: true },
      })
      .then((rows) => rows.length),
  ]);

  return {
    templateKey,
    classification: definition.classification,
    purpose: definition.purpose ?? null,
    owed,
    delivered,
    firstSentAt,
  };
};

/** Why this amendment is not published, or an empty list when it is. */
export async function emailPolicyPublicationProblems(
  now: Date = new Date()
): Promise<PublicationProblem[]> {
  return publicationProblems({
    documents: documentFacts(),
    notice: await noticeFacts(),
    now,
  });
}

/**
 * A pass, remembered for the life of the process; a failure, for a minute.
 *
 * Asked once per recipient by the verdict, so an uncached answer would be three
 * queries over the user and delivery tables for every message in a fan-out.
 *
 * Caching a pass is sound because nothing it rests on can move back within one
 * process: the documents are constants a deploy replaces (and a deploy starts a
 * new process), the owed population is fixed at the first send, and a delivered
 * notice does not un-deliver. A failure is cached briefly so a notice finishing
 * its last recipient is noticed within a minute rather than at the next deploy.
 */
const FAILURE_TTL_MS = 60_000;
let cached: { published: boolean; at: number } | null = null;

export async function isEmailPolicyPublished(now: Date = new Date()): Promise<boolean> {
  if (cached && (cached.published || now.getTime() - cached.at < FAILURE_TTL_MS)) {
    return cached.published;
  }
  const published = (await emailPolicyPublicationProblems(now)).length === 0;
  cached = { published, at: now.getTime() };
  return published;
}

/**
 * Whether release notes may be sent at all: the operator's switch, and the
 * amendment the switch is not allowed to run ahead of.
 *
 * The one reader for every caller -- both enqueue paths and the send verdict.
 * A caller that read the raw flag would be the path by which release notes went
 * out under pages that still said they would not.
 */
export async function isEmailReleaseNotesLive(): Promise<boolean> {
  if (!(await isEmailReleaseNotesEnabled())) return false;
  return isEmailPolicyPublished();
}
