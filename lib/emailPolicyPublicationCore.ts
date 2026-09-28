/**
 * S10: what has to be published, and told to whom, before a release-notes rule
 * set may become the active one.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 10 (the
 * documents), section 11 approval E (the amendment and the notice), section 12
 * S10, and docs/policy/email-notifications.md section 3.1 type 5 (a
 * service/legal notice reaches people who unsubscribed).
 *
 * ## Why this is a gate and not a checklist
 *
 * Section 10's table lists four documents and a procedure. A checklist in a
 * runbook is a list somebody ticks; this is the list `activatePolicyVersion()`
 * refuses on. The difference matters because the failure mode is silent: a
 * policy version can be activated while the pages still say what they said
 * before, and nothing about the send path would look wrong. The country rules
 * would simply start authorising mail under a promise the site was still
 * making in the opposite direction -- which is the Gateway Learning shape
 * section 5.5 already names, and the reason approval E exists.
 *
 * ## The notice is not marketing
 *
 * A policy amendment is section 3.1's fifth type: service or legal, owed to
 * everybody, including the people who turned marketing off. Classifying the
 * change notice as marketing would mean the people most affected by the change
 * -- the ones who already said no -- are the only ones not told, and that the
 * notice itself is gated by the consent the amendment is about. So the
 * classification is a refusal here rather than a convention.
 *
 * ## What this does not decide
 *
 * The wording. Section 10 is explicit that the legal copy is drafted and
 * approved before it is implemented, and a module that generated the amendment
 * text would be writing rather than publishing. What this knows is that the
 * published digest is no longer the one recorded before the amendment -- not
 * that the new text says the right thing.
 */

/** A document section 10 names, and what is known about its publication. */
export type AmendedDocument = {
  /** The route, as `SITEMAP_CONTENT_EVIDENCE` keys it. */
  path: string;
  /**
   * The digest recorded before the amendment.
   *
   * Null where nothing recorded one, which is not a pass: a document whose
   * previous state nobody wrote down cannot be shown to have changed.
   */
  digestBeforeAmendment: string | null;
  /** The digest of what the site renders now. */
  publishedDigest: string | null;
  /** The effective date the page itself shows, as a UTC calendar day. */
  effectiveFrom: string | null;
};

/** The change notice, as the gate reads it. */
export type ChangeNoticeFacts = {
  /** The template that carries the amendment notice. */
  templateKey: string | null;
  /** Its classification, from `emailTemplateDefinition()`. */
  classification: string | null;
  /** Whether a purpose gates it. A service/legal notice has none. */
  purpose: string | null;
  /** Accounts that should have received it. */
  owed: number;
  /** Accounts a delivery reached a terminal success for. */
  delivered: number;
  /** When the first notice went out, or null where none has. */
  firstSentAt: Date | null;
};

export const PUBLICATION_REFUSALS = [
  /** A document section 10 names has no recorded state to compare against. */
  "document_state_unrecorded",
  /** A document still renders what it rendered before the amendment. */
  "document_not_amended",
  /** A document shows no effective date. */
  "effective_date_missing",
  /** The effective date has not arrived. */
  "effective_date_not_reached",
  /** The notice went out too close to the effective date. */
  "notice_period_too_short",
  /** No notice has been sent at all. */
  "change_notice_not_sent",
  /** Some accounts owed the notice have not received one. */
  "change_notice_incomplete",
  /** The notice is classified so that an unsubscribed person would not get it. */
  "change_notice_is_marketing",
  /** The notice names no template, so nothing can be shown to have been sent. */
  "change_notice_unidentified",
] as const;

export type PublicationRefusal = (typeof PUBLICATION_REFUSALS)[number];

export type PublicationProblem = {
  refusal: PublicationRefusal;
  /** What it is about -- a document path, or the notice. */
  subject: string;
  detail: string;
};

/**
 * How long before the effective date the notice has to have gone.
 *
 * Thirty days, which is the interval the amendment notice itself is written
 * against rather than a figure derived here. It lives as a constant so a
 * shorter one is a visible edit rather than an argument passed at one call
 * site.
 */
export const CHANGE_NOTICE_PERIOD_DAYS = 30;

const DAY_MS = 86_400_000;

/** A UTC calendar day, or null where the string is not one. */
const dayStart = (value: string | null): Date | null => {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/**
 * Everything that stops this amendment counting as published.
 *
 * All of them, not the first: an operator asking why activation was refused is
 * asking what is left to do, and being told one thing at a time turns a day's
 * work into a week of attempts.
 */
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
          "Nothing recorded what this page said before the amendment, so it cannot be shown to have changed.",
      });
      continue;
    }
    if (document.digestBeforeAmendment === document.publishedDigest) {
      problems.push({
        refusal: "document_not_amended",
        subject: document.path,
        detail: "The page still renders exactly what it rendered before the amendment.",
      });
    }
    const effective = dayStart(document.effectiveFrom);
    if (effective === null) {
      problems.push({
        refusal: "effective_date_missing",
        subject: document.path,
        detail: "The page shows no effective date, so nothing says when the amendment applies.",
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
          detail: `The notice went out ${Math.floor(gapDays)} day(s) before the effective date; ${CHANGE_NOTICE_PERIOD_DAYS} are owed.`,
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

  // The fifth type of section 3.1: owed to everybody, including the people who
  // turned marketing off. A marketing classification would gate the notice
  // behind the consent the amendment is about, so the people most affected are
  // the only ones not told.
  if (notice.classification === "marketing" || notice.purpose !== null) {
    problems.push({
      refusal: "change_notice_is_marketing",
      subject: notice.templateKey,
      detail:
        notice.purpose !== null
          ? `The notice is gated by the "${notice.purpose}" purpose, so anyone who turned it off is not told about the change to it.`
          : "The notice is classified as marketing, so anyone who unsubscribed is not told about the change.",
    });
  }

  if (notice.firstSentAt === null || notice.delivered === 0) {
    problems.push({
      refusal: "change_notice_not_sent",
      subject: notice.templateKey,
      detail: "No amendment notice has reached anybody.",
    });
    return problems;
  }

  if (notice.delivered < notice.owed) {
    problems.push({
      refusal: "change_notice_incomplete",
      subject: notice.templateKey,
      detail: `${notice.owed - notice.delivered} of ${notice.owed} account(s) owed the notice have not received one.`,
    });
  }

  return problems;
};

/** The documents section 10's table names. */
export const AMENDED_DOCUMENT_PATHS = ["/privacy", "/terms"] as const;
