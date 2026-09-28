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
 * out while the pages still promised marketing mail only on request, and nothing
 * about the send path would look wrong.
 *
 * ## "Told" is a set question, answered in SQL
 *
 * The first version compared two sizes -- accounts owed the notice against
 * accounts with a `sent` delivery -- and was wrong in both directions. `sent` is
 * not where a successful message ends: the delivery webhook moves it on to
 * `delivered`, so thirty days after a campaign that reached everyone the count
 * was zero and the gate stayed shut for ever. And a size comparison lets one
 * account's extra delivery stand in for another account's missing one.
 *
 * So the question is asked the way it is meant: **how many owed accounts have
 * no attempt at all**. An attempt is any terminal outcome -- reached (`sent`,
 * `delivered`) or not (`bounced`, `complained`, `suppressed`, `failed`,
 * `abandoned`). A dead mailbox is reported, not blocking: section 3.1's fifth
 * type asks that a legal notice be sent and its non-delivery tracked, not that
 * one unreachable address hold every later product hostage.
 *
 * ## Who is owed
 *
 * Every account with an address that existed **before the effective date**. An
 * account that signs up during the notice period signed up under whatever the
 * pages said that day, which is not something this gate can see, so it is owed a
 * notice like everybody else -- the operator sends a later wave. Anchoring the
 * population at the first send instead, as the first version did, let those
 * accounts reach the effective date without ever being told.
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
   * A digest typed into a table by hand is a claim about the page, not evidence
   * of it: the gate would treat whatever was typed as what the page shows. Only
   * a digest some test checks against the rendered source counts.
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
  /** Owed accounts with a delivery that reached them. */
  reached: number;
  /** Owed accounts attempted and not reached -- reported, not blocking. */
  unreachable: number;
  /** Owed accounts with no attempt at all. This is what blocks. */
  notAttempted: number;
  /** The earliest successful notice inside the notice window, or null. */
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
  /** The effective date has not arrived. */
  "effective_date_not_reached",
  /** The notice went out too close to the effective date. */
  "notice_period_too_short",
  /** No notice has reached anybody inside the notice window. */
  "change_notice_not_sent",
  /** Some owed accounts have no attempt at all. */
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

/** How long before the effective date the first notice has to have gone. */
export const CHANGE_NOTICE_PERIOD_DAYS = 30;

/**
 * How far before the effective date a delivery can be and still be this notice.
 *
 * A bound, because the notice is identified by its template. A key pointed by
 * mistake at a template that has been sending for a year would otherwise supply
 * a `firstSentAt` from last year and a delivery to nearly everyone -- a notice
 * condition that is true with no notice ever sent.
 */
export const CHANGE_NOTICE_WINDOW_DAYS = 120;

/** Delivery states that mean an attempt was made and finished. */
export const REACHED_STATUSES = ["sent", "delivered"] as const;
export const UNREACHED_STATUSES = [
  "bounced",
  "complained",
  "suppressed",
  "failed",
  "abandoned",
] as const;

const DAY_MS = 86_400_000;

/** A UTC calendar day, or null where the string is not one. */
export const utcDayStart = (value: string | null): Date | null => {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // `2026-02-31` parses and rolls over; a date the page shows must be one that
  // exists.
  return parsed.toISOString().slice(0, 10) === value ? parsed : null;
};

/**
 * The effective date the notice population is anchored on: the latest any
 * document shows, because an account is owed a notice about every document that
 * changes after it joined. Null while any document shows no usable date.
 */
export const effectiveDateOf = (documents: readonly AmendedDocument[]): Date | null => {
  let latest: Date | null = null;
  for (const document of documents) {
    const day = utcDayStart(document.effectiveFrom);
    if (day === null) return null;
    if (latest === null || day > latest) latest = day;
  }
  return latest;
};

/** Every reason this amendment does not count as published. All of them. */
export const publicationProblems = (input: {
  documents: readonly AmendedDocument[];
  notice: ChangeNoticeFacts;
  now: Date;
}): PublicationProblem[] => {
  const problems: PublicationProblem[] = [];

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
    if (effective.getTime() > input.now.getTime()) {
      problems.push({
        refusal: "effective_date_not_reached",
        subject: document.path,
        detail: `The amendment takes effect on ${document.effectiveFrom}, which has not arrived.`,
      });
    }
    if (input.notice.firstSentAt !== null) {
      const gapDays = (effective.getTime() - input.notice.firstSentAt.getTime()) / DAY_MS;
      if (gapDays < CHANGE_NOTICE_PERIOD_DAYS) {
        problems.push({
          refusal: "notice_period_too_short",
          subject: document.path,
          detail: `The first notice went out ${Math.floor(gapDays)} day(s) before the effective date; ${CHANGE_NOTICE_PERIOD_DAYS} are owed.`,
        });
      }
    }
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
  // purpose, which a person can turn off, and `transactional` is the class of
  // login codes and receipts -- a key pointing at one of those would count mail
  // that says nothing about the amendment.
  if (notice.classification !== "legal" || notice.purpose !== null) {
    problems.push({
      refusal: "change_notice_not_legal",
      subject: notice.templateKey,
      detail: `The notice is classified "${notice.classification ?? "unknown"}"${
        notice.purpose !== null ? ` under the "${notice.purpose}" purpose` : ""
      }; only a legal notice reaches the people who turned mail off, and they are the ones the amendment is most about.`,
    });
  }

  if (notice.firstSentAt === null || notice.reached === 0) {
    problems.push({
      refusal: "change_notice_not_sent",
      subject: notice.templateKey,
      detail: `No amendment notice has reached anybody within ${CHANGE_NOTICE_WINDOW_DAYS} days before the effective date.`,
    });
    return problems;
  }

  if (notice.notAttempted > 0) {
    problems.push({
      refusal: "change_notice_incomplete",
      subject: notice.templateKey,
      detail: `${notice.notAttempted} of ${notice.owed} account(s) owed the notice have no attempt at all.`,
    });
  }

  return problems;
};
