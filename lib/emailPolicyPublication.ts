import "server-only";

import { prisma } from "@/lib/prisma";
import { isEmailReleaseNotesEnabled } from "@/lib/appSettings";
import { SITEMAP_CONTENT_EVIDENCE } from "@/lib/sitemapContentDates";
import { emailTemplateDefinition, EMAIL_TEMPLATE_KEYS } from "@/lib/emailTemplateDefinitions";
import {
  CHANGE_NOTICE_WINDOW_DAYS,
  HANDED_OVER_STATUSES,
  effectiveDateOf,
  noticeDeadline,
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
 * So `isEmailReleaseNotesLive()` is the reader every caller asks.
 *
 * ## Recorded digests, and only verified ones
 *
 * Nothing is hashed at runtime: a production build does not promise the source
 * files are on disk. Both sides of the comparison are constants, and a current
 * digest counts only where a test recomputes it from what is rendered and
 * compares it with the recorded value (`DIGEST_VERIFIED_BY`;
 * `tests/emailPolicyPublication.test.mjs` checks each named test actually hashes
 * and compares, not merely mentions the path).
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
 * The current state of each amended document that is not a sitemap page.
 *
 * `SITEMAP_CONTENT_EVIDENCE` only holds URLs the sitemap lists, and its own test
 * insists on that, so the signup consent copy and the login consent sentence --
 * which are not pages -- could never have been recorded there. They are recorded
 * here, when the amendment is written, beside a test that recomputes them.
 * Checked first; a sitemap entry answers for the pages.
 */
export const AMENDED_DOCUMENT_EVIDENCE: Readonly<
  Record<string, { date: string; contentSha256: string }>
> = {};

/**
 * The test that recomputes each document's current digest from the rendered
 * source and compares it with the recorded one.
 */
export const DIGEST_VERIFIED_BY: Readonly<Record<string, string>> = {
  "/privacy": "tests/sitemapLastModified.test.mjs",
};

/**
 * Section 10's table: the two pages, and the two pieces of product copy that
 * carry the same promise. None but `/privacy` has a recorded state yet, so each
 * of the other three is `document_state_unrecorded` -- which is true.
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
 * It must be a `legal` template made for this amendment. Null until the approved
 * wording is written, which is `change_notice_unidentified`.
 */
export const CHANGE_NOTICE_TEMPLATE_KEY: string | null = null;

export const documentFacts = (): AmendedDocument[] =>
  AMENDED_DOCUMENTS.map((path) => {
    const evidence =
      AMENDED_DOCUMENT_EVIDENCE[path] ??
      (
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
  told: 0,
  late: 0,
  unreachable: 0,
  untold: 0,
  firstSentAt: null,
};

const DAY_MS = 86_400_000;

/** A JS instant as the naive-UTC `TIMESTAMP(3)` the columns hold. */
const utc = (value: Date) => value.toISOString();

/**
 * Every owed account classified as told, late, unreachable or untold, in one
 * statement.
 *
 * One SELECT so the counts come from one snapshot. Every instant is converted
 * with `AT TIME ZONE 'UTC'`, the way this repository's other raw SQL compares
 * these naive `TIMESTAMP(3)` columns: a bare JS `Date` parameter is interpreted
 * in the session's time zone, and the owed cut and the window would move by that
 * offset.
 *
 * Takes the template key as an argument so it can be exercised against a
 * database before any notice exists
 * (tests/integration/email-policy-publication.db.test.ts).
 */
export const noticeFactsFor = async (
  templateKey: string | null,
  effective: Date | null,
  now: Date
): Promise<ChangeNoticeFacts> => {
  if (
    templateKey === null ||
    !EMAIL_TEMPLATE_KEYS.includes(templateKey as (typeof EMAIL_TEMPLATE_KEYS)[number])
  ) {
    return UNIDENTIFIED;
  }
  const definition = emailTemplateDefinition(templateKey);
  // Before the documents agree on a date there is no anchor; the gate is closed
  // on the documents anyway, and counting against "now" still reports progress.
  const anchor = effective ?? now;
  const deadline = noticeDeadline(anchor);
  const windowStart = new Date(anchor.getTime() - CHANGE_NOTICE_WINDOW_DAYS * DAY_MS);

  const [row] = await prisma.$queryRaw<
    {
      owed: bigint;
      told: bigint;
      late: bigint;
      unreachable: bigint;
      untold: bigint;
      firstSentAt: Date | null;
    }[]
  >`
    WITH params AS (
      SELECT (${utc(anchor)}::timestamptz AT TIME ZONE 'UTC')      AS "effective",
             (${utc(deadline)}::timestamptz AT TIME ZONE 'UTC')    AS "deadline",
             (${utc(windowStart)}::timestamptz AT TIME ZONE 'UTC') AS "windowStart"
    ),
    owed AS (
      SELECT u."id", u."email", u."createdAt"
        FROM "User" u, params p
       WHERE u."createdAt" IS NULL OR u."createdAt" < p."effective"
    ),
    notice AS (
      SELECT d."userId", d."status", d."sentAt"
        FROM "EmailDelivery" d
        JOIN "TemplateVersion" tv ON tv."id" = d."templateVersionId"
        JOIN "EmailTemplate" t ON t."id" = tv."templateId"
        CROSS JOIN params p
       WHERE t."key" = ${templateKey}
         AND d."userId" IS NOT NULL
         AND d."createdAt" >= p."windowStart"
    ),
    handed AS (
      SELECT n."userId", n."sentAt"
        FROM notice n, params p
       WHERE n."status" = ANY(${[...HANDED_OVER_STATUSES]}::text[])
         AND n."sentAt" IS NOT NULL
         AND n."sentAt" < p."effective"
    ),
    classified AS (
      SELECT CASE
               WHEN EXISTS (
                 SELECT 1 FROM handed h, params p
                  WHERE h."userId" = o."id"
                    AND (h."sentAt" < p."deadline"
                         OR (o."createdAt" IS NOT NULL AND o."createdAt" >= p."deadline"))
               ) THEN 'told'
               WHEN EXISTS (SELECT 1 FROM handed h WHERE h."userId" = o."id") THEN 'late'
               WHEN o."email" IS NULL
                 OR EXISTS (
                   SELECT 1 FROM notice n
                    WHERE n."userId" = o."id" AND n."status" = 'suppressed'
                 ) THEN 'unreachable'
               ELSE 'untold'
             END AS "state"
        FROM owed o
    )
    SELECT
      COUNT(*)                                        AS "owed",
      COUNT(*) FILTER (WHERE "state" = 'told')        AS "told",
      COUNT(*) FILTER (WHERE "state" = 'late')        AS "late",
      COUNT(*) FILTER (WHERE "state" = 'unreachable') AS "unreachable",
      COUNT(*) FILTER (WHERE "state" = 'untold')      AS "untold",
      (SELECT MIN("sentAt") FROM handed)              AS "firstSentAt"
      FROM classified
  `;

  return {
    templateKey,
    classification: definition.classification,
    purpose: definition.purpose ?? null,
    owed: Number(row?.owed ?? 0),
    told: Number(row?.told ?? 0),
    late: Number(row?.late ?? 0),
    unreachable: Number(row?.unreachable ?? 0),
    untold: Number(row?.untold ?? 0),
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
 * The answer, remembered for a minute, whichever it was.
 *
 * Asked once per recipient by the verdict. A pass is remembered no longer than a
 * failure: an account that gains an address after the notice went out is owed a
 * notice it has not had, and the gate should close within a minute of that
 * rather than five.
 *
 * A query that throws is remembered too -- as the error, rethrown, not as
 * "unpublished". The callers are send gates inside the verdict, whose `read()`
 * turns a throw into the retryable `VerdictUnavailableError` (invariant 11).
 * Answering "unpublished" instead would make every release note claimed during a
 * database hiccup a permanent `feature_disabled` skip. Remembering the error
 * stops a timing-out statement being re-run for every claimed message.
 */
const TTL_MS = 60_000;
let cached: { published: boolean; at: number } | { error: unknown; at: number } | null = null;

export async function isEmailPolicyPublished(now: Date = new Date()): Promise<boolean> {
  if (cached) {
    const age = now.getTime() - cached.at;
    if (age >= 0 && age < TTL_MS) {
      if ("error" in cached) throw cached.error;
      return cached.published;
    }
  }
  try {
    const published = (await emailPolicyPublicationProblems(now)).length === 0;
    cached = { published, at: now.getTime() };
    return published;
  } catch (error) {
    cached = { error, at: now.getTime() };
    throw error;
  }
}

/**
 * Whether release notes may be sent at all: the operator's switch, and the
 * amendment the switch may not run ahead of. The one reader for every caller.
 */
export async function isEmailReleaseNotesLive(): Promise<boolean> {
  if (!(await isEmailReleaseNotesEnabled())) return false;
  return isEmailPolicyPublished();
}
