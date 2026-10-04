import "server-only";

import { prisma } from "@/lib/prisma";
import { isEmailReleaseNotesEnabled } from "@/lib/appSettings";
import { SITEMAP_CONTENT_EVIDENCE } from "@/lib/sitemapContentDates";
import {
  emailTemplateDefinition,
  EMAIL_TEMPLATE_KEYS,
  POLICY_CHANGE_NOTICE_TEMPLATE,
} from "@/lib/emailTemplateDefinitions";
import { suppressionCheck } from "@/lib/emailSuppression";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { POLICY_CHANGE_NOTICE_APPROVED_CONTENT_HASHES } from "@/lib/policyChangeNoticeEmail";
import {
  CHANGE_NOTICE_WINDOW_DAYS,
  TOLD_STATUSES,
  UNREACHABLE_REPORT_LIMIT,
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
 * (`DIGEST_VERIFIED_BY`; `tests/emailPolicyPublication.test.mjs` runs each
 * document's verifier in `tests/support/amendedDocumentVerifiers.mjs` and
 * compares its result with the record, so an entry here fails the build unless
 * the recomputed digest and the shown date actually match).
 */

/**
 * The digests of the versions of each document approved as carrying the
 * amendment approval E describes. Empty until the approved wording is published.
 *
 * Every later edit to an amended page -- for any reason -- has to be added here
 * before the gate counts it, because the gate cannot tell an edit that keeps the
 * amendment from one that removes it.
 */
export const APPROVED_AMENDED_DIGESTS: Readonly<Record<string, readonly string[]>> = {
  // docs/policy/email-policy-amendment-draft.md §2, §3 and §5, approved by
  // mposition on 2026-10-03: the email clause in seven languages, the terms
  // clause in en, ko and zh, both effective 2026-11-16.
  "/privacy": ["5052379184eb3c41f3c50986db4b4587a22d0b3814247852150a5539cd1307b7"],
  "/terms": ["5a2e6339c29b7b8892add806418f5d24b2681a58a426808531ff639e617a4709"],
};

/**
 * The current state of each amended document whose date the sitemap may not
 * publish.
 *
 * `SITEMAP_CONTENT_EVIDENCE` only holds pages whose shown date the sitemap may
 * publish. `/terms` is not one: its "Last updated" line did not move with every
 * edit (lib/sitemapContentDates.ts). `/privacy` is not one while its shown date
 * is a future effective date. So their state is recorded here, beside a
 * verifier that recomputes it. This table is read first; a sitemap entry would
 * answer only for a document not listed here.
 *
 * Both documents today: the S10 amendment as approved on 2026-10-03, effective
 * 2026-11-16. `/privacy` is here too, not in the sitemap table, while that
 * date is in the future: a sitemap lastmod may not be a day that has not come
 * (lib/sitemapContentDates.ts).
 */
export const AMENDED_DOCUMENT_EVIDENCE: Readonly<
  Record<string, { date: string; contentSha256: string }>
> = {
  // Here rather than in the sitemap's table while its effective date is in the
  // future (lib/sitemapContentDates.ts).
  "/privacy": {
    date: "2026-11-16",
    contentSha256: "5052379184eb3c41f3c50986db4b4587a22d0b3814247852150a5539cd1307b7",
  },
  "/terms": {
    date: "2026-11-16",
    contentSha256: "5a2e6339c29b7b8892add806418f5d24b2681a58a426808531ff639e617a4709",
  },
};

/**
 * The documents whose current digest and date a test recomputes from the
 * rendered source and compares with the record -- and *which record*.
 *
 * The verifiers live in `tests/support/amendedDocumentVerifiers.mjs` and are
 * run, not read: an earlier version only checked that a named test file
 * mentioned the right strings, so a file that read the tokens and hashed
 * anything at all would have made a hand-typed digest count as evidence.
 *
 * The record matters because a document's state is read from one of two tables
 * (`AMENDED_DOCUMENT_EVIDENCE` first, then the sitemap's). A verifier of the
 * sitemap entry says nothing about a value typed into the other table, and the
 * previous version called the document verified whichever one it read.
 */
export const DIGEST_VERIFIED_BY: Readonly<Record<string, { record: "sitemap" | "amended" }>> = {
  "/privacy": { record: "amended" },
  "/terms": { record: "amended" },
};

/**
 * The documents the amendment changes: the two pages.
 *
 * Section 10's table named two more, and the owner's decisions settled both
 * (2026-09-29):
 *
 * - **The login-screen sentence** stays as it is. The table's question was
 *   whether email would be bundled into it, and it is not: email consent is
 *   the separate opt-in device, which is what section 5.1 (L2) requires -- one
 *   control cannot mean both agreement to the terms and a marketing consent.
 *   A sentence that does not change is not an amended document.
 * - **The consent devices** keep the promise "not sent unless you ask". The
 *   owner chose option B on 2026-09-23 (consent copy draft section 9.1): that
 *   notice is shown only to people the override does not mail, so the promise
 *   stays true for everybody who reads it, and the copy is not amended. The
 *   gate briefly required a version without the promise, which was option C --
 *   the one not chosen -- and that condition is gone.
 */
export const AMENDED_DOCUMENTS = ["/privacy", "/terms"] as const;

/**
 * The template that carries the amendment notice, and the exact approved
 * wording of it.
 *
 * Both, because a key alone identifies a template and not a text. The key is
 * the notice's own (`policy_change_notice`); a key pointed at the account-deletion
 * notice, the other `legal` template, or at a retired draft, would have counted
 * mail that said nothing about the amendment. The hash list is empty until the
 * owner approves the wording (docs/policy/email-policy-amendment-draft.md). Deliveries count only when their template
 * version's `contentHash` is one listed here -- the versions whose wording was
 * approved as this notice. Null or empty is `change_notice_unidentified`.
 */
export const CHANGE_NOTICE_TEMPLATE_KEY: string | null = POLICY_CHANGE_NOTICE_TEMPLATE;
export const CHANGE_NOTICE_APPROVED_CONTENT_HASHES: readonly string[] =
  POLICY_CHANGE_NOTICE_APPROVED_CONTENT_HASHES;

export const documentFacts = (): AmendedDocument[] =>
  AMENDED_DOCUMENTS.map((path) => {
    const amended = AMENDED_DOCUMENT_EVIDENCE[path];
    const sitemap = (
      SITEMAP_CONTENT_EVIDENCE as Readonly<
        Record<string, { date: string; contentSha256: string } | undefined>
      >
    )[path];
    const record = amended ? "amended" : sitemap ? "sitemap" : null;
    const evidence = amended ?? sitemap;
    return {
      path,
      approvedDigests: APPROVED_AMENDED_DIGESTS[path] ?? [],
      publishedDigest: evidence?.contentSha256 ?? null,
      effectiveFrom: evidence?.date ?? null,
      verified: record !== null && DIGEST_VERIFIED_BY[path]?.record === record,
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
  unreachableAccounts: [],
  blockingAccounts: [],
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
 * "Unreachable" needs two facts, not one. A notice to the account was refused by
 * the lane or hard-bounced, **and** the lane would refuse this notice to that
 * address now. The second is asked of `suppressionCheck()` itself, with the
 * notice's own classification and purpose, rather than restated in SQL: a
 * restatement matched the cause's reason and not its scope, so a marketing-only
 * `privacy_request` or a purpose-scoped manual hold -- neither of which stops a
 * legal message -- excused an account the lane would in fact have mailed.
 *
 * Every bounce is nominated, soft or hard, and not by `lastErrorKind`: a later
 * delayed or soft-bounce event on the same row overwrites that column, so a hard
 * bounce could read as soft and escape the check while the lane still refused
 * the address. The check itself tells them apart -- a soft-bounce hold does not
 * stop a legal notice, so that account comes back untold.
 *
 * Any refused row, not the latest: a later attempt that fails before the
 * suppression check (a template mismatch, say) is not evidence the address
 * became reachable, and the live check already answers whether it did. A row
 * refused under a cause since released is untold, because the check now says
 * the notice would go. A soft bounce is neither told nor unreachable; it is a
 * full mailbox, and the account is untold until a retry lands.
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
  // A notice that reached the mailbox before this has had its full period,
  // measured from today as if today were the effective date: the same calendar
  // rule, so a late account is told on exactly the day thirty days of notice
  // have passed. The day, not the instant -- `noticeDeadline()` of a mid-day
  // "now" would move the cutoff every minute.
  const ownPeriodCutoff = noticeDeadline(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  );
  const windowStart = new Date(anchor.getTime() - CHANGE_NOTICE_WINDOW_DAYS * DAY_MS);

  const [row] = await prisma.$queryRaw<
    {
      owed: bigint;
      told: bigint;
      late: bigint;
      untold: bigint;
      firstSentAt: Date | null;
      /** Accounts that may be unreachable, for `suppressionCheck()` to decide. */
      candidates: { id: string; email: string | null; state: "no_address" | "refused" }[] | null;
      /** The first accounts holding the gate shut, with their latest notice's state. */
      blocking: { id: string; state: "late" | "untold"; latest: string | null }[] | null;
    }[]
  >`
    WITH params AS (
      SELECT (${utc(anchor)}::timestamptz AT TIME ZONE 'UTC')      AS "effective",
             (${utc(deadline)}::timestamptz AT TIME ZONE 'UTC')    AS "deadline",
             (${utc(ownPeriodCutoff)}::timestamptz AT TIME ZONE 'UTC') AS "ownPeriodCutoff",
             (${utc(windowStart)}::timestamptz AT TIME ZONE 'UTC') AS "windowStart",
             (${utc(now)}::timestamptz AT TIME ZONE 'UTC')         AS "now"
    ),
    owed AS (
      SELECT u."id", u."email", u."createdAt"
        FROM "User" u, params p
       WHERE u."createdAt" IS NULL OR u."createdAt" < p."effective"
    ),
    notice AS (
      SELECT d."userId", d."status", d."deliveredAt", d."createdAt"
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
      SELECT n."userId", n."deliveredAt" AS "arrivedAt"
        FROM notice n
       WHERE n."status" = ANY(${[...TOLD_STATUSES]}::text[])
         AND n."deliveredAt" IS NOT NULL
    ),
    latest AS (
      SELECT DISTINCT ON (n."userId") n."userId", n."status"
        FROM notice n
       ORDER BY n."userId", n."createdAt" DESC
    ),
    classified AS (
      SELECT CASE
               WHEN EXISTS (
                 SELECT 1 FROM told t, params p
                  WHERE t."userId" = o."id"
                    AND (t."arrivedAt" < p."deadline"
                         OR t."arrivedAt" < p."ownPeriodCutoff")
               ) THEN 'told'
               WHEN EXISTS (SELECT 1 FROM told t WHERE t."userId" = o."id") THEN 'late'
               WHEN o."email" IS NULL THEN 'no_address'
               WHEN EXISTS (
                 SELECT 1 FROM notice n
                  WHERE n."userId" = o."id"
                    AND n."status" IN ('suppressed', 'bounced')
               ) THEN 'refused'
               ELSE 'untold'
             END AS "state",
             o."id", o."email"
        FROM owed o
    )
    SELECT
      COUNT(*)                                        AS "owed",
      COUNT(*) FILTER (WHERE "state" = 'told')        AS "told",
      COUNT(*) FILTER (WHERE "state" = 'late')        AS "late",
      COUNT(*) FILTER (WHERE "state" = 'untold')      AS "untold",
      (SELECT MIN("arrivedAt") FROM told)             AS "firstSentAt",
      json_agg(json_build_object('id', "id", 'email', "email", 'state', "state")
               ORDER BY "id")
        FILTER (WHERE "state" IN ('no_address', 'refused')) AS "candidates",
      (SELECT json_agg(b ORDER BY b."id")
         FROM (SELECT c."id", c."state", l."status" AS "latest"
                 FROM classified c
                 LEFT JOIN latest l ON l."userId" = c."id"
                WHERE c."state" IN ('late', 'untold')
                ORDER BY c."id"
                LIMIT ${UNREACHABLE_REPORT_LIMIT}::int) b) AS "blocking"
      FROM classified
  `;

  // The lane's own answer for each refused account, asked now. Few rows: an
  // account is here only when a notice to it was refused or hard-bounced.
  let untold = Number(row?.untold ?? 0);
  const unreachableAccounts: { userId: string; reason: string }[] = [];
  // Why each named account holds the gate: late, or its latest notice's state
  // (`never_sent` where there is none). A full mailbox is the case this exists
  // for -- a soft-bounced legal notice is `bounced` for good, nothing retries it,
  // and without a name the operator could only see a count.
  const blockingAccounts: { userId: string; reason: string }[] = (row?.blocking ?? []).map(
    (account) => ({
      userId: account.id,
      reason: account.state === "late" ? "late" : (account.latest ?? "never_sent"),
    })
  );
  for (const candidate of row?.candidates ?? []) {
    if (candidate.state === "no_address" || candidate.email === null) {
      unreachableAccounts.push({ userId: candidate.id, reason: "no_address" });
      continue;
    }
    const verdict = await suppressionCheck({
      emailAddress: candidate.email,
      classification: definition.classification,
      ...(definition.purpose ? { purpose: definition.purpose } : {}),
      now,
    });
    if (verdict.allowed) {
      untold += 1;
      if (blockingAccounts.length < UNREACHABLE_REPORT_LIMIT) {
        blockingAccounts.push({ userId: candidate.id, reason: "refused_but_reachable" });
      }
    } else unreachableAccounts.push({ userId: candidate.id, reason: verdict.skipReason });
  }

  return {
    templateKey,
    classification: definition.classification,
    purpose: definition.purpose ?? null,
    owed: Number(row?.owed ?? 0),
    told: Number(row?.told ?? 0),
    late: Number(row?.late ?? 0),
    unreachable: unreachableAccounts.length,
    unreachableAccounts: unreachableAccounts.slice(0, UNREACHABLE_REPORT_LIMIT),
    blockingAccounts,
    untold,
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
  return {
    problems: publicationProblems({ documents, notice, now }),
    notice,
  };
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
 * A pass with unreachable accounts is reported, once per computation, so the
 * accounts the amendment never reached are on record the moment release notes
 * can go live: a structured event naming each account id and why (never an
 * address), and an operational incident so somebody is told rather than having
 * to search for it. Section 3.2 sends a hard-bounced account to another channel,
 * and that needs to know which account.
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
          accounts: report.notice.unreachableAccounts,
          accountsTruncated:
            report.notice.unreachableAccounts.length < report.notice.unreachable,
        })
      );
      await reportOperationalIncident({
        code: "EMAIL_POLICY_NOTICE_UNREACHABLE",
        title: "Release notes are live and some accounts were never told of the amendment",
        severity: "warning",
        error:
          `${report.notice.unreachable} of ${report.notice.owed} account(s) owed the amendment notice cannot be reached by email. ` +
          "The email_policy_published_with_unreachable event names them; section 3.2 needs another channel for them.",
        cooldownMs: 24 * 60 * 60 * 1_000,
        context: { component: "email-policy-publication" },
      });
    }
    // Closed on the notice, with a notice identified: name who is holding it.
    // Logged per computation, like the pass above -- once a minute per process
    // at most, and only while a notice is going out.
    if (!published && report.notice.blockingAccounts.length > 0) {
      console.warn(
        JSON.stringify({
          event: "email_policy_notice_blocking",
          at: now.toISOString(),
          owed: report.notice.owed,
          late: report.notice.late,
          untold: report.notice.untold,
          accounts: report.notice.blockingAccounts,
          accountsTruncated:
            report.notice.blockingAccounts.length < report.notice.late + report.notice.untold,
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
