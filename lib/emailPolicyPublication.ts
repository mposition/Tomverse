import "server-only";

import { prisma } from "@/lib/prisma";
import { isEmailReleaseNotesEnabled } from "@/lib/appSettings";
import { SITEMAP_CONTENT_EVIDENCE } from "@/lib/sitemapContentDates";
import { emailTemplateDefinition, EMAIL_TEMPLATE_KEYS } from "@/lib/emailTemplateDefinitions";
import {
  CHANGE_NOTICE_WINDOW_DAYS,
  REACHED_STATUSES,
  UNREACHED_STATUSES,
  effectiveDateOf,
  publicationProblems,
  type AmendedDocument,
  type ChangeNoticeFacts,
  type PublicationProblem,
} from "@/lib/emailPolicyPublicationCore";

/**
 * S10's gate, and where it stands.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md sections 10, 11
 * approval E and 12 (S10). The rules are in `emailPolicyPublicationCore.ts`;
 * this supplies the facts.
 *
 * ## Why the gate is on the flag's reader
 *
 * Section 12 orders activation as: documents in force, policy version active,
 * readiness confirmed, and only then the release-notes flag. The flag has no
 * writer in this application -- an operator sets the `AppSetting` row -- so a
 * refusal at write time would guard nothing. And every email policy draft
 * carries the release-notes country rules, so refusing *policy activation* would
 * block every email policy change, including ones unrelated to release notes.
 *
 * So `isEmailReleaseNotesLive()` is the reader every caller asks, and it answers
 * yes only when the stored flag is on **and** this amendment is published. A flag
 * switched on early does nothing yet, which is the honest state.
 *
 * ## Recorded digests, and only verified ones
 *
 * Nothing is hashed at runtime: a production build does not promise the source
 * files are on disk, and a second digest implementation would be a second answer
 * to a question a test already answers. Both sides are constants -- and a
 * constant counts only where a test recomputes it from what is rendered
 * (`DIGEST_VERIFIED_BY`). A digest typed into a table and checked by nothing is a
 * claim about the page, and the first version of this gate would have treated
 * one as the page itself.
 */

/**
 * What each document rendered before the amendment approval E describes.
 *
 * `/privacy`: the digest recorded on 2026-09-14, the state section 10 quotes when
 * it says the policy promises mail only on request.
 */
export const DIGEST_BEFORE_AMENDMENT: Readonly<Record<string, string>> = {
  "/privacy": "ac3b5f82fa492671259539bf426e52e17824f27f673dc5d3396d1fa4bc9c9233",
};

/**
 * The test that recomputes each document's current digest from the rendered
 * source. `tests/emailPolicyPublication.test.mjs` checks each named file exists
 * and names the document, so an entry here cannot point at nothing.
 */
export const DIGEST_VERIFIED_BY: Readonly<Record<string, string>> = {
  "/privacy": "tests/sitemapLastModified.test.mjs",
};

/**
 * Section 10's table: the two pages, and the two pieces of product copy that
 * carry the same promise.
 *
 * The signup consent devices and the login consent sentence are here because
 * the first version listed only the pages, and its own opening procedure would
 * have switched release notes on with both of those still in their earlier
 * wording. Neither has a recorded state yet, so each is
 * `document_state_unrecorded` -- which is true.
 */
export const AMENDED_DOCUMENTS = [
  "/privacy",
  "/terms",
  "signup consent copy",
  "login consent sentence",
] as const;

/**
 * The template that carries the amendment notice, once one exists.
 *
 * It must be a template made for this amendment: `CHANGE_NOTICE_WINDOW_DAYS`
 * bounds how old a delivery may be and still count, but a template already
 * sending for another reason inside that window would still be counted. Null
 * until the approved wording is written, which is `change_notice_unidentified`.
 */
export const CHANGE_NOTICE_TEMPLATE_KEY: string | null = null;

export const documentFacts = (): AmendedDocument[] =>
  AMENDED_DOCUMENTS.map((path) => {
    const evidence = (
      SITEMAP_CONTENT_EVIDENCE as Readonly<
        Record<string, { date: string; contentSha256: string } | undefined>
      >
    )[path];
    return {
      path,
      digestBeforeAmendment: DIGEST_BEFORE_AMENDMENT[path] ?? null,
      publishedDigest: evidence?.contentSha256 ?? null,
      effectiveFrom: evidence?.date ?? null,
      verified: Boolean(DIGEST_VERIFIED_BY[path]),
    };
  });

const UNIDENTIFIED: ChangeNoticeFacts = {
  templateKey: null,
  classification: null,
  purpose: null,
  owed: 0,
  reached: 0,
  unreachable: 0,
  notAttempted: 0,
  firstSentAt: null,
};

const DAY_MS = 86_400_000;
const ATTEMPTED = [...REACHED_STATUSES, ...UNREACHED_STATUSES];

/**
 * The notice's reach, as one statement.
 *
 * Takes the template key rather than reading `CHANGE_NOTICE_TEMPLATE_KEY` so the
 * statement can be exercised against a database before any notice exists
 * (tests/integration/email-policy-publication.db.test.ts).
 *
 * One SELECT so the four counts come from one snapshot: an owed account cannot
 * be counted as not attempted by one sub-query and reached by another while a
 * wave is in flight.
 */
export const noticeFactsFor = async (
  templateKey: string | null,
  effective: Date | null,
  now: Date
): Promise<ChangeNoticeFacts> => {
  // A key no template defines is as unidentified as none at all, and asking
  // `emailTemplateDefinition()` for it would throw.
  if (
    templateKey === null ||
    !EMAIL_TEMPLATE_KEYS.includes(templateKey as (typeof EMAIL_TEMPLATE_KEYS)[number])
  ) {
    return UNIDENTIFIED;
  }
  const definition = emailTemplateDefinition(templateKey);
  // Before every document shows a usable date there is no anchor; the gate is
  // closed on those documents anyway, and counting against "now" still tells an
  // operator how far the notice has got.
  const anchor = effective ?? now;
  const windowStart = new Date(anchor.getTime() - CHANGE_NOTICE_WINDOW_DAYS * DAY_MS);

  const [row] = await prisma.$queryRaw<
    {
      owed: bigint;
      reached: bigint;
      unreachable: bigint;
      notAttempted: bigint;
      firstSentAt: Date | null;
    }[]
  >`
    WITH owed AS (
      SELECT u."id"
        FROM "User" u
       WHERE u."email" IS NOT NULL
         AND u."createdAt" < ${anchor}
    ),
    notice AS (
      SELECT d."userId", d."status", d."sentAt"
        FROM "EmailDelivery" d
        JOIN "TemplateVersion" tv ON tv."id" = d."templateVersionId"
        JOIN "EmailTemplate" t ON t."id" = tv."templateId"
       WHERE t."key" = ${templateKey}
         AND d."userId" IS NOT NULL
         AND d."createdAt" >= ${windowStart}
    )
    SELECT
      (SELECT COUNT(*) FROM owed) AS "owed",
      (SELECT COUNT(*) FROM owed o WHERE EXISTS (
         SELECT 1 FROM notice n
          WHERE n."userId" = o."id" AND n."status" = ANY(${[...REACHED_STATUSES]}::text[])
      )) AS "reached",
      (SELECT COUNT(*) FROM owed o
        WHERE NOT EXISTS (
          SELECT 1 FROM notice n
           WHERE n."userId" = o."id" AND n."status" = ANY(${[...REACHED_STATUSES]}::text[]))
          AND EXISTS (
          SELECT 1 FROM notice n
           WHERE n."userId" = o."id" AND n."status" = ANY(${[...UNREACHED_STATUSES]}::text[]))
      ) AS "unreachable",
      (SELECT COUNT(*) FROM owed o WHERE NOT EXISTS (
         SELECT 1 FROM notice n
          WHERE n."userId" = o."id" AND n."status" = ANY(${ATTEMPTED}::text[])
      )) AS "notAttempted",
      (SELECT MIN(n."sentAt") FROM notice n
        WHERE n."status" = ANY(${[...REACHED_STATUSES]}::text[])) AS "firstSentAt"
  `;

  return {
    templateKey,
    classification: definition.classification,
    purpose: definition.purpose ?? null,
    owed: Number(row?.owed ?? 0),
    reached: Number(row?.reached ?? 0),
    unreachable: Number(row?.unreachable ?? 0),
    notAttempted: Number(row?.notAttempted ?? 0),
    firstSentAt: row?.firstSentAt ?? null,
  };
};

/** Why this amendment is not published, or an empty list when it is. */
export async function emailPolicyPublicationProblems(
  now: Date = new Date()
): Promise<PublicationProblem[]> {
  const documents = documentFacts();
  return publicationProblems({
    documents,
    notice: await noticeFactsFor(CHANGE_NOTICE_TEMPLATE_KEY, effectiveDateOf(documents), now),
    now,
  });
}

/**
 * The answer, remembered briefly.
 *
 * Asked once per recipient by the verdict, so an uncached answer would be a
 * statement over the user and delivery tables for every message in a fan-out.
 * A pass is remembered for five minutes and a failure for one -- not a pass for
 * the life of the process, as the first version had it: nothing should make a
 * pass revert, but "nothing should" is not a reason to stop looking.
 */
const PASS_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 60_000;
let cached: { published: boolean; at: number } | null = null;

export async function isEmailPolicyPublished(now: Date = new Date()): Promise<boolean> {
  if (cached) {
    const ttl = cached.published ? PASS_TTL_MS : FAILURE_TTL_MS;
    const age = now.getTime() - cached.at;
    if (age >= 0 && age < ttl) return cached.published;
  }
  const published = (await emailPolicyPublicationProblems(now)).length === 0;
  cached = { published, at: now.getTime() };
  return published;
}

/**
 * Whether release notes may be sent at all: the operator's switch, and the
 * amendment the switch may not run ahead of.
 *
 * The one reader for every caller -- both enqueue paths and the send verdict.
 */
export async function isEmailReleaseNotesLive(): Promise<boolean> {
  if (!(await isEmailReleaseNotesEnabled())) return false;
  return isEmailPolicyPublished();
}
