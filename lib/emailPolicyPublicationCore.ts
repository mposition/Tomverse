/**
 * S10: what has to be published, and told to whom, before release notes may go
 * live.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 10 (the
 * documents), section 11 approval E (the amendment and the notice), section 12
 * S10, and docs/policy/email-notifications.md section 3.1 type 5 (a legal notice
 * reaches people who unsubscribed).
 *
 * ## Why this is a gate and not a checklist
 *
 * Section 10 lists four documents and a procedure. A checklist in a runbook is a
 * list somebody ticks; this is the list the release-notes switch is read
 * through. The failure it prevents is silent: release notes could start going
 * out while the pages still promised marketing mail only on request.
 *
 * ## "Told in time" is decided per account
 *
 * Two earlier versions answered it in aggregate and were wrong both times. The
 * first counted `sent` rows and compared sizes; the second asked "any attempt
 * per account" but measured the notice period from the single earliest send,
 * counted rows the lane refused before any provider call as attempts, and
 * compared naive timestamps against a session-dependent clock.
 *
 * Now each owed account is classified on its own, in one statement:
 *
 * - **told** -- a notice was handed to the provider (`sent`, `delivered`,
 *   `bounced`, `complained`: every state that exists only after the provider
 *   accepted the message) before the account's deadline. The deadline is the
 *   end of the day thirty days before the effective date for an account that
 *   existed then; an account that joined inside the notice period has until the
 *   effective date, because thirty days were never available to it.
 * - **late** -- handed over, but only after its deadline. Blocking: a notice
 *   that arrives with less notice than owed is not the notice.
 * - **unreachable** -- never handed over, and the system cannot hand it over:
 *   the account has no address, or the lane refused the notice for a suppression
 *   on the address. Reported, not blocking -- section 3.1's fifth type asks that
 *   a legal notice be sent and non-delivery tracked, and a gate waiting on mail
 *   the lane will never send never opens.
 * - **untold** -- everything else, including a notice that `failed` or was
 *   `abandoned`: those are our failures, not facts about the mailbox. Blocking.
 *
 * ## Who is owed
 *
 * Every account created before the effective date, and every account whose
 * creation time is unknown (`User.createdAt` is nullable, and an account whose
 * age nobody recorded is not one this gate may assume joined late).
 *
 * ## What this does not decide
 *
 * The wording. Section 10 has the legal copy drafted and approved before it is
 * implemented; this knows that a recorded digest moved, not that the new text
 * says the right thing.
 */

/** A document section 10 names, and what is known about its publication. */
export type AmendedDocument = {
  /** A route, or a named piece of product copy. */
  path: string;
  /** The digest recorded before the amendment, or null where nobody recorded one. */
  digestBeforeAmendment: string | null;
  /** The digest of what the product renders now, or null where nothing records it. */
  publishedDigest: string | null;
  /** The effective date the document shows, as a UTC calendar day. */
  effectiveFrom: string | null;
  /**
   * Whether a test recomputes `publishedDigest` from what is actually rendered.
   *
   * A digest typed into a table is a claim about the page, not evidence of it.
   */
  verified: boolean;
};

/** The change notice, as the gate reads it. */
export type ChangeNoticeFacts = {
  templateKey: string | null;
  /** From `emailTemplateDefinition()`. */
  classification: string | null;
  purpose: string | null;
  /** Accounts owed the notice. */
  owed: number;
  /** Handed to the provider before their deadline. */
  told: number;
  /** Handed over, but after their deadline. Blocking. */
  late: number;
  /** Not handed over, and the system cannot hand it over. Reported. */
  unreachable: number;
  /** Not handed over for any other reason. Blocking. */
  untold: number;
  /** The earliest hand-over, for the report. */
  firstSentAt: Date | null;
};

export const PUBLICATION_REFUSALS = [
  /** A document section 10 names has no recorded before-and-after state. */
  "document_state_unrecorded",
  /** Its current digest is recorded but no test checks it against the source. */
  "document_state_unverified",
  /** It still renders what it rendered before the amendment. */
  "document_not_amended",
  /** It shows no effective date. */
  "effective_date_missing",
  /** The documents show different effective dates. */
  "effective_dates_differ",
  /** The effective date has not arrived. */
  "effective_date_not_reached",
  /** Some owed accounts were told with less notice than owed. */
  "notice_period_too_short",
  /** Nobody has been told. */
  "change_notice_not_sent",
  /** Some owed accounts were not told at all. */
  "change_notice_incomplete",
  /** The notice is not a legal notice, so an unsubscribed person may not get it. */
  "change_notice_not_legal",
  /** No notice template is named. */
  "change_notice_unidentified",
] as const;

export type PublicationRefusal = (typeof PUBLICATION_REFUSALS)[number];

export type PublicationProblem = {
  refusal: PublicationRefusal;
  /** A document path, or the notice. */
  subject: string;
  detail: string;
};

/** Calendar days of notice owed before the effective date. */
export const CHANGE_NOTICE_PERIOD_DAYS = 30;

/**
 * How far before the effective date a delivery can be and still be this notice.
 *
 * The notice is identified by its template, and a key pointed by mistake at a
 * template that has been sending for a year would otherwise supply last year's
 * deliveries as the amendment notice.
 */
export const CHANGE_NOTICE_WINDOW_DAYS = 120;

/**
 * States that exist only after the provider accepted the message.
 *
 * `suppressed`, `failed` and `abandoned` are not here: the lane writes each of
 * them without a provider ever seeing the message. The second version of this
 * gate counted them as attempts, which let rows the lane refused stand in for a
 * notice nobody sent.
 */
export const HANDED_OVER_STATUSES = ["sent", "delivered", "bounced", "complained"] as const;

const DAY_MS = 86_400_000;

/** A UTC calendar day, or null where the string is not one that exists. */
export const utcDayStart = (value: string | null): Date | null => {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // `2026-02-31` parses and rolls over; a date the page shows must exist.
  return parsed.toISOString().slice(0, 10) === value ? parsed : null;
};

/**
 * The single effective date every document shows, or null.
 *
 * One amendment, one date. Documents with different dates would need different
 * notice periods measured against different populations, and the second
 * version's attempt to serve several dates from one window left the earlier
 * document with no notice that could ever satisfy it.
 */
export const effectiveDateOf = (documents: readonly AmendedDocument[]): Date | null => {
  let date: Date | null = null;
  for (const document of documents) {
    const day = utcDayStart(document.effectiveFrom);
    if (day === null) return null;
    if (date !== null && day.getTime() !== date.getTime()) return null;
    date = day;
  }
  return date;
};

/**
 * The first instant an account that existed thirty days out is no longer told
 * in time: the start of the 29th day before the effective date.
 *
 * Calendar days, not milliseconds. With a 15 November effective date, a notice
 * any time on 16 October gives thirty days; the second version measured to the
 * millisecond from midnight, so a notice at 00:00:01 on 16 October was late and
 * stayed late for ever, since a recorded send time is never rewritten.
 */
export const noticeDeadline = (effective: Date): Date =>
  new Date(effective.getTime() - (CHANGE_NOTICE_PERIOD_DAYS - 1) * DAY_MS);

/** Every reason this amendment does not count as published. All of them. */
export const publicationProblems = (input: {
  documents: readonly AmendedDocument[];
  notice: ChangeNoticeFacts;
  now: Date;
}): PublicationProblem[] => {
  const problems: PublicationProblem[] = [];
  const dates = new Set<string>();

  for (const document of input.documents) {
    if (document.digestBeforeAmendment === null || document.publishedDigest === null) {
      problems.push({
        refusal: "document_state_unrecorded",
        subject: document.path,
        detail:
          "Nothing records what this said before the amendment and what it says now, so it cannot be shown to have changed.",
      });
      continue;
    }
    if (!document.verified) {
      problems.push({
        refusal: "document_state_unverified",
        subject: document.path,
        detail:
          "The current digest is recorded, but no test checks it against what is rendered, so it is a claim about the page rather than evidence of it.",
      });
      continue;
    }
    if (document.digestBeforeAmendment === document.publishedDigest) {
      problems.push({
        refusal: "document_not_amended",
        subject: document.path,
        detail: "It still renders exactly what it rendered before the amendment.",
      });
    }
    const effective = utcDayStart(document.effectiveFrom);
    if (effective === null) {
      problems.push({
        refusal: "effective_date_missing",
        subject: document.path,
        detail: "It shows no effective date, so nothing says when the amendment applies.",
      });
      continue;
    }
    dates.add(document.effectiveFrom as string);
    if (effective.getTime() > input.now.getTime()) {
      problems.push({
        refusal: "effective_date_not_reached",
        subject: document.path,
        detail: `The amendment takes effect on ${document.effectiveFrom}, which has not arrived.`,
      });
    }
  }
  if (dates.size > 1) {
    problems.push({
      refusal: "effective_dates_differ",
      subject: "documents",
      detail: `The documents show ${[...dates].sort().join(", ")}; one amendment has one effective date.`,
    });
  }

  const notice = input.notice;
  if (notice.templateKey === null) {
    problems.push({
      refusal: "change_notice_unidentified",
      subject: "change notice",
      detail: "No template is named as the amendment notice, so nothing can be shown to have been sent.",
    });
    return problems;
  }

  // Section 3.1's fifth type: owed to everybody, including people who turned
  // everything switchable off. Of the classifications a template may register,
  // only `legal` is both purpose-free and unsubscribe-free; `service` requires a
  // purpose, and a `transactional` key could point at login codes and count
  // them as the notice.
  if (notice.classification !== "legal" || notice.purpose !== null) {
    problems.push({
      refusal: "change_notice_not_legal",
      subject: notice.templateKey,
      detail: `The notice is classified "${notice.classification ?? "unknown"}"${
        notice.purpose !== null ? ` under the "${notice.purpose}" purpose` : ""
      }; only a legal notice reaches the people who turned mail off, and they are the ones the amendment is most about.`,
    });
  }

  if (notice.told === 0 && notice.late === 0) {
    problems.push({
      refusal: "change_notice_not_sent",
      subject: notice.templateKey,
      detail: "No amendment notice has been handed to the provider for anybody.",
    });
    return problems;
  }
  if (notice.late > 0) {
    problems.push({
      refusal: "notice_period_too_short",
      subject: notice.templateKey,
      detail: `${notice.late} account(s) were told with less than ${CHANGE_NOTICE_PERIOD_DAYS} days' notice.`,
    });
  }
  if (notice.untold > 0) {
    problems.push({
      refusal: "change_notice_incomplete",
      subject: notice.templateKey,
      detail: `${notice.untold} of ${notice.owed} account(s) owed the notice were not told.`,
    });
  }
  return problems;
};
