import "server-only";

import { prisma } from "@/lib/prisma";
import { isEmailReleaseNotesEnabled } from "@/lib/appSettings";
import { SITEMAP_CONTENT_EVIDENCE } from "@/lib/sitemapContentDates";
import { emailTemplateDefinition, EMAIL_TEMPLATE_KEYS } from "@/lib/emailTemplateDefinitions";
import {
  CHANGE_NOTICE_WINDOW_DAYS,
  TOLD_STATUSES,
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
 * digest and date count only where a test recomputes the digest from what is
 * rendered *and* checks the date against what the page shows
 * (`DIGEST_VERIFIED_BY`; `tests/emailPolicyPublication.test.mjs` checks each
 * named test does both, not merely mentions the path).
 */

/**
 * The digests of the versions of each document approved as carrying the
 * amendment approval E describes. Empty until the approved wording is published.
 *
 * Every later edit to an amended page -- for any reason -- has to be added here
 * before the gate counts it, because the gate cannot tell an edit that keeps the
 * amendment from one that removes it.
 */
export const APPROVED_AMENDED_DIGESTS: Readonly<Record<string, readonly string[]>> = {};

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
 * source, compares it with the recorded one, and checks the recorded date is
 * the one the document shows.
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
 * The template that carries the amendment notice, and the exact approved
 * wording of it.
 *
 * Both, because a key alone identifies a template and not a text. The only
 * registered `legal` template today is the account-deletion notice; a key
 * pointed at it, or at a new key's retired draft, would have counted mail that
 * said nothing about the amendment. Deliveries count only when their template
 * version's `contentHash` is one listed here -- the versions whose wording was
 * approved as this notice. Null or empty is `change_notice_unidentified`.
 */
export const CHANGE_NOTICE_TEMPLATE_KEY: string | null = null;
export const CHANGE_NOTICE_APPROVED_CONTENT_HASHES: readonly string[] = [];

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
      approvedDigests: APPROVED_AMENDED_DIGESTS[path] ?? [],
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
 * One SELECT so the counts come from one snapshot. Every instant goes through
 * `AT TIME ZONE 'UTC'`, the way this repository's other raw SQL compares these
 * naive `TIMESTAMP(3)` columns.
 *
 * "Unreachable" needs two facts, not one. The account's *latest* notice was
 * refused by the lane or hard-bounced, **and** a suppression still stands on its
 * address now. The third version took any `suppressed` row, ever, as permanent:
 * a suppression lifted since left the account counted as a dead mailbox and owed
 * nothing, and one refusal after the deadline hid every other row for that
 * account. A soft bounce is neither told nor unreachable; it is a full mailbox,
 * and the account is untold until a retry lands.
 *
 * Takes the key and hashes as arguments so it can be exercised against a
 * database before any notice exists
 * (tests/integration/email-policy-publication.db.test.ts).
 */
export const noticeFactsFor = async (
  templateKey: string | null,
  approvedContentHashes: readonly string[],
  effective: Date | null,
  now: Date
): Promise<ChangeNoticeFacts> => {
  if (
    templateKey === null ||
    approvedContentHashes.length === 0 ||
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
             (${utc(windowStart)}::timestamptz AT TIME ZONE 'UTC') AS "windowStart",
             (${utc(now)}::timestamptz AT TIME ZONE 'UTC')         AS "now"
    ),
    owed AS (
      SELECT u."id", u."email", u."createdAt"
        FROM "User" u, params p
       WHERE u."createdAt" IS NULL OR u."createdAt" < p."effective"
    ),
    notice AS (
      SELECT d."userId", d."status", d."sentAt", d."createdAt", d."lastErrorKind"
        FROM "EmailDelivery" d
        JOIN "TemplateVersion" tv ON tv."id" = d."templateVersionId"
        JOIN "EmailTemplate" t ON t."id" = tv."templateId"
        CROSS JOIN params p
       WHERE t."key" = ${templateKey}
         AND tv."contentHash" = ANY(${[...approvedContentHashes]}::text[])
         AND d."userId" IS NOT NULL
         AND d."createdAt" >= p."windowStart"
    ),
    told AS (
      SELECT n."userId", n."sentAt"
        FROM notice n, params p
       WHERE n."status" = ANY(${[...TOLD_STATUSES]}::text[])
         AND n."sentAt" IS NOT NULL
         AND n."sentAt" < p."effective"
    ),
    latest AS (
      SELECT DISTINCT ON (n."userId") n."userId", n."status", n."lastErrorKind"
        FROM notice n
       ORDER BY n."userId", n."createdAt" DESC
    ),
    classified AS (
      SELECT CASE
               WHEN EXISTS (
                 SELECT 1 FROM told t, params p
                  WHERE t."userId" = o."id"
                    AND (t."sentAt" < p."deadline"
                         OR (o."createdAt" IS NOT NULL AND o."createdAt" >= p."deadline"))
               ) THEN 'told'
               WHEN EXISTS (SELECT 1 FROM told t WHERE t."userId" = o."id") THEN 'late'
               WHEN o."email" IS NULL THEN 'unreachable'
               WHEN EXISTS (
                 SELECT 1 FROM latest l
                  WHERE l."userId" = o."id"
                    AND (l."status" = 'suppressed'
                         OR (l."status" = 'bounced'
                             AND l."lastErrorKind" IS DISTINCT FROM 'soft_bounce'))
               )
               AND EXISTS (
                 SELECT 1 FROM "SuppressionCause" sc, params p
                  WHERE sc."emailAddress" = lower(btrim(o."email"))
                    AND sc."releasedAt" IS NULL
                    AND (sc."expiresAt" IS NULL OR sc."expiresAt" > p."now")
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
      (SELECT MIN("sentAt") FROM told)                AS "firstSentAt"
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

export type PublicationReport = {
  problems: PublicationProblem[];
  notice: ChangeNoticeFacts;
};

/**
 * The gate's answer and the counts behind it.
 *
 * The counts are returned, not only the refusals, because `unreachable` never
 * becomes a refusal and would otherwise appear nowhere: those are accounts the
 * amendment was never delivered to, and somebody should be able to see how many.
 */
export async function publicationReport(now: Date = new Date()): Promise<PublicationReport> {
  const documents = documentFacts();
  const notice = await noticeFactsFor(
    CHANGE_NOTICE_TEMPLATE_KEY,
    CHANGE_NOTICE_APPROVED_CONTENT_HASHES,
    effectiveDateOf(documents),
    now
  );
  return { problems: publicationProblems({ documents, notice, now }), notice };
}

/** Why this amendment is not published, or an empty list when it is. */
export async function emailPolicyPublicationProblems(
  now: Date = new Date()
): Promise<PublicationProblem[]> {
  return (await publicationReport(now)).problems;
}

/**
 * The answer, remembered for a minute, whichever it was.
 *
 * Asked once per recipient by the verdict. A pass is remembered no longer than a
 * failure: an account that gains an address after the notice went out is owed a
 * notice it has not had, and the gate should close within a minute of that.
 *
 * A query that throws is remembered as the error and rethrown, not as
 * "unpublished". Inside the send verdict, `read()` turns a throw into the
 * retryable `VerdictUnavailableError` (invariant 11); answering "unpublished"
 * there would make every release note claimed during a database hiccup a
 * permanent `feature_disabled` skip.
 *
 * A pass with unreachable accounts is logged, once per computation, so the
 * accounts the amendment never reached are on record the moment release notes
 * can go live -- counts only, no addresses.
 */
const TTL_MS = 60_000;
let cached: { published: boolean; at: number } | { error: unknown; at: number } | null = null;

/**
 * Test-only: answer the publication question without the documents.
 *
 * The campaign suites exercise sends of `product_updates`, which is the
 * release-notes product, and this gate is closed until an amendment the
 * repository does not contain yet is published -- so without a seam every one
 * of those suites would test the refusal and nothing else. It throws unless
 * `NODE_ENV` is `test`, which is how the DB integration runner starts
 * (scripts/run-db-integration-tests.mjs) and never how the application does; a
 * call in any other environment is a bug, not a configuration.
 *
 * `null` restores the real answer. The gate's own suites never set it.
 */
let publishedForTests: boolean | null = null;

export function setEmailPolicyPublishedForTests(value: boolean | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setEmailPolicyPublishedForTests() is for tests only.");
  }
  publishedForTests = value;
  cached = null;
}

export async function isEmailPolicyPublished(now: Date = new Date()): Promise<boolean> {
  if (publishedForTests !== null && process.env.NODE_ENV === "test") return publishedForTests;
  if (cached) {
    const age = now.getTime() - cached.at;
    if (age >= 0 && age < TTL_MS) {
      if ("error" in cached) throw cached.error;
      return cached.published;
    }
  }
  try {
    const report = await publicationReport(now);
    const published = report.problems.length === 0;
    if (published && report.notice.unreachable > 0) {
      console.warn(
        JSON.stringify({
          event: "email_policy_published_with_unreachable",
          at: now.toISOString(),
          owed: report.notice.owed,
          told: report.notice.told,
          unreachable: report.notice.unreachable,
        })
      );
    }
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

/**
 * The same answer for a caller about to *write* rows rather than send them.
 *
 * At enqueue and at the start of a fan-out nothing has been written yet, so "we
 * could not tell" can safely be "not now": the caller refuses, writes nothing,
 * and running it again later is the retry. Throwing there instead ended a
 * fan-out on a raw database error. The send verdict does not use this -- a
 * claimed message must retry, not skip.
 */
export async function isEmailReleaseNotesLiveForEnqueue(): Promise<boolean> {
  try {
    return await isEmailReleaseNotesLive();
  } catch {
    return false;
  }
}
