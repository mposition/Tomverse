import "server-only";

import { prisma } from "@/lib/prisma";
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
 * The facts S10's gate rests on, read from what the build already vouches for.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md sections 10, 11
 * approval E and 12 (S10).
 *
 * ## Recorded digests, not recomputed ones
 *
 * The obvious implementation reads `components/legal/PrivacyPolicy.tsx` and the
 * locale files and hashes them. It would also be wrong twice: a production build
 * has no guarantee those source files are on disk, and a second implementation
 * of the digest is a second answer to the question `tests/sitemapLastModified.
 * test.mjs` already answers.
 *
 * So both sides of the comparison are constants. `SITEMAP_CONTENT_EVIDENCE`
 * holds what the page renders *now* -- and that test fails the build unless it
 * really does -- while `DIGEST_BEFORE_AMENDMENT` below holds what it rendered
 * before. Nothing is hashed at runtime and nothing can drift without a failing
 * test in between.
 *
 * ## `/terms` has no entry, and that is the honest answer
 *
 * `SITEMAP_CONTENT_EVIDENCE` deliberately omits `/terms`: its own module records
 * that the displayed "Last updated" line did not move across three edits to the
 * copy, so the date on the page is not evidence of anything. The gate therefore
 * reports `document_state_unrecorded` for `/terms` rather than passing it, which
 * is the true state -- nothing in this repository vouches for what `/terms` says
 * or when it last changed. Section 10's table asks for that to be settled, and
 * settling it is what clears this refusal.
 */

/**
 * What each document rendered before the amendment approval E describes.
 *
 * Pinned here, on the day the amendment is prepared, so that "the page changed"
 * is a comparison rather than a memory. A path with no entry is
 * `document_state_unrecorded`, which is a refusal: a document whose previous
 * state nobody wrote down cannot be shown to have changed, and a gate that
 * passed it would pass a page nobody had touched.
 *
 * `/privacy`: the digest recorded on 2026-09-14, which is the state section 10
 * quotes when it says the policy currently promises mail only on request.
 */
export const DIGEST_BEFORE_AMENDMENT: Readonly<Record<string, string>> = {
  "/privacy": "ac3b5f82fa492671259539bf426e52e17824f27f673dc5d3396d1fa4bc9c9233",
};

/**
 * The template that carries the amendment notice, once one exists.
 *
 * Null until the approved wording is written. Null is `change_notice_unidentified`
 * -- a refusal, not a skip: section 10 says the legal copy is drafted and
 * approved before it is implemented, and a gate that passed while no notice
 * existed would let the rules go live silently, which is the whole thing
 * approval E is about.
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

/**
 * How many accounts are owed the notice, and how many a delivery reached.
 *
 * Owed is every account with an address, because a service or legal notice is
 * owed to everybody -- including the people who turned marketing off, who are
 * the ones the amendment is most about.
 */
const noticeFacts = async (): Promise<ChangeNoticeFacts> => {
  const templateKey = CHANGE_NOTICE_TEMPLATE_KEY;
  if (templateKey === null) {
    return {
      templateKey: null,
      classification: null,
      purpose: null,
      owed: 0,
      delivered: 0,
      firstSentAt: null,
    };
  }
  // A key no template defines is as unidentified as none at all, and asking
  // `emailTemplateDefinition()` for it would throw inside an activation.
  if (!EMAIL_TEMPLATE_KEYS.includes(templateKey as (typeof EMAIL_TEMPLATE_KEYS)[number])) {
    return {
      templateKey: null,
      classification: null,
      purpose: null,
      owed: 0,
      delivered: 0,
      firstSentAt: null,
    };
  }
  const definition = emailTemplateDefinition(templateKey);

  const [owed, delivered, first] = await Promise.all([
    prisma.user.count({ where: { email: { not: null } } }),
    prisma.emailDelivery.count({
      where: { templateVersion: { template: { key: templateKey } }, status: "sent" },
    }),
    prisma.emailDelivery.findFirst({
      where: { templateVersion: { template: { key: templateKey } }, status: "sent" },
      orderBy: { sentAt: "asc" },
      select: { sentAt: true },
    }),
  ]);

  return {
    templateKey,
    classification: definition.classification,
    purpose: definition.purpose ?? null,
    owed,
    delivered,
    firstSentAt: first?.sentAt ?? null,
  };
};

/**
 * Why this amendment is not published, or an empty list when it is.
 *
 * Read fresh each time rather than cached: the only caller is an activation,
 * which happens once, and a cached "published" would survive a page being
 * rolled back.
 */
export async function emailPolicyPublicationProblems(
  now: Date = new Date()
): Promise<PublicationProblem[]> {
  return publicationProblems({
    documents: documentFacts(),
    notice: await noticeFacts(),
    now,
  });
}
