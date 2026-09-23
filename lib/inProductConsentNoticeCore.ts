/**
 * The one-time in-product notice that asks an existing account for consent.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, sections 5.4,
 * 5.5 and 9.
 *
 * ## Why this exists at all
 *
 * Every account that predates the marketing work has **no basis in any
 * jurisdiction** (section 5.5). Our policy promised we would send only to
 * people who asked, so Australia's "reasonable expectation" is contradicted by
 * our own document, and relaxing a privacy promise retroactively is the FTC
 * Section 5 risk that Gateway Learning is about. A policy-change notice does
 * not create a permission somebody did not give.
 *
 * What those accounts do have is that they sign in and use the product. So
 * consent can be asked for without contacting them at all: once, on screen,
 * the next time they are here. That is not an email, so ePrivacy Article 13
 * does not reach it -- which matters, because "an email asking for consent" is
 * itself direct marketing in the EEA and could not be sent. Korea's guidance
 * does not call it a transmission either (section 9).
 *
 * ## Three states, and none of them implies another
 *
 * This is the whole design, and section 5.1 states it as a rule rather than a
 * preference. An unchecked box is not a refusal. A dismissed notice is not a
 * refusal either -- it is somebody closing a thing on their way to what they
 * came for. And an objection is not merely the absence of consent: it is a
 * decision that has to survive a later prompt.
 *
 *   expressOptInRequested   they ticked the box. Consent, and it leads to the
 *                           double opt-in like any other.
 *   noticeShown             the notice was rendered to them. Neither consent
 *                           nor refusal, and it is what stops it reappearing.
 *   objected                they used the refusal control. A decision.
 *
 * Reading any of these off another is the failure the rule exists to prevent,
 * so they are three separate facts in `EmailPermissionEvent` and this module
 * never derives one from another.
 *
 * ## What is not here
 *
 * The wording. Section 5.4's copy is S2's, it is approved by the owner rather
 * than written by an implementer, and it has to exist in seven languages
 * before anything renders. This module decides *who is asked and what is
 * recorded*; a surface that shows it needs copy that does not exist yet.
 *
 * Pure and dependency-free: no Prisma, no server-only import, no clock of its
 * own.
 */

import {
  CONSENT_REQUIRED_PURPOSES,
  isEmailPurpose,
  type EmailPurpose,
} from "./emailPreferenceCore";

/**
 * Which purposes the notice can ask about.
 *
 * The marketing ones that require consent, which is the same set the signup
 * checkbox covers. Derived rather than listed: a purpose that becomes
 * consent-based later is one this notice should ask about too, and a second
 * list would have to be remembered.
 */
export const noticePurposes = (): EmailPurpose[] =>
  [...CONSENT_REQUIRED_PURPOSES].filter(isEmailPurpose).sort();

/** The three facts, spelled as the ledger spells them. */
export const NOTICE_EVENT_KINDS = {
  shown: "notice_shown",
  objected: "objected",
} as const;

export type NoticeState = {
  /** They ticked the box at some point. Read from ConsentRecord, not from here. */
  hasExpressConsent: boolean;
  /** The notice has already been rendered to them. */
  noticeAlreadyShown: boolean;
  /** They used the refusal control. */
  hasObjected: boolean;
  /** The address is suppressed, for any reason and at any scope. */
  suppressed: boolean;
};

export type NoticeRefusal =
  | "already_consented"
  | "already_shown"
  | "objected"
  | "suppressed"
  | "no_address";

export type NoticeOffer =
  | { offered: true; purposes: EmailPurpose[] }
  | { offered: false; refusal: NoticeRefusal };

/**
 * Whether this account is asked, and why not when it is not.
 *
 * The order is not a precedence so much as a statement of which fact answers
 * first when several are true. `objected` is checked before `already_shown`
 * deliberately: both stop the notice, and a reader looking at why wants the
 * decision rather than the render.
 */
export const inProductNoticeOffer = (
  input: NoticeState & { emailAddress: string | null }
): NoticeOffer => {
  if (!input.emailAddress || input.emailAddress.trim().length === 0) {
    return { offered: false, refusal: "no_address" };
  }
  if (input.hasObjected) return { offered: false, refusal: "objected" };
  if (input.hasExpressConsent) {
    return { offered: false, refusal: "already_consented" };
  }
  if (input.suppressed) return { offered: false, refusal: "suppressed" };
  // Last, because it is the weakest reason: it says only that we asked.
  if (input.noticeAlreadyShown) return { offered: false, refusal: "already_shown" };

  return { offered: true, purposes: noticePurposes() };
};

export type NoticeAction = "shown" | "opt_in" | "object";

export type NoticeRecord =
  | { kind: "notice_shown"; scopeKey: string }
  | { kind: "objected"; scopeKey: string }
  | { kind: "consent"; purposes: EmailPurpose[] };

/**
 * What an action records, and nothing more.
 *
 * Dismissing records that we asked. It does **not** record a refusal, and the
 * difference is the whole of section 5.4's last paragraph: somebody closing a
 * dialog on their way to what they came for has not decided anything, and a
 * ledger that wrote `objected` there would be inventing a decision in the same
 * way an inferred consent invents one -- just in the direction that looks
 * safe.
 *
 * Ticking the box records a consent, which goes to the double opt-in like any
 * other consent; this module does not write it, it says that it is one.
 */
export const noticeRecordFor = (action: NoticeAction): NoticeRecord => {
  switch (action) {
    case "shown":
      return { kind: "notice_shown", scopeKey: "marketing" };
    case "object":
      return { kind: "objected", scopeKey: "marketing" };
    case "opt_in":
      return { kind: "consent", purposes: noticePurposes() };
  }
};

/**
 * The idempotency key for a rendered notice.
 *
 * One per account. A re-render or a double-click adds nothing, and the account
 * id rather than the address because the notice is a thing that happened to a
 * person in a session: changing address later does not make it unhappen, and
 * keying on the address would show the notice again.
 */
export const noticeShownSourceEventKey = (userId: string): string =>
  `in-product-notice:shown:${userId}`;

/**
 * The idempotency key for a refusal.
 *
 * Account **and** address, which is the opposite of the rule above, because a
 * refusal is a different kind of fact: it attaches to the mailbox, the same
 * way a suppression does, and `objected` rows are looked up by address.
 *
 * Keying it by account alone was wrong and the failure was silent. Somebody
 * who refused at one address, changed address and refused again would collide
 * with their own earlier row; the write would return that row and report
 * success, and the new address would have no refusal on it at all. The screen
 * would show the notice again on the next load, with the refusal button
 * apparently working every time.
 *
 * The digest rather than the address: the address is already a column on the
 * row, so this adds nothing a reader could not see, and a key is a string that
 * gets copied into logs and error messages.
 */
export const noticeObjectionSourceEventKey = (
  userId: string,
  addressDigest: string
): string => `in-product-notice:objected:${userId}:${addressDigest}`;

/**
 * The signals that can settle which country's rule applied.
 *
 * The approved contract ranks them (docs/policy/email-notifications.md
 * sections 6.1 to 6.3): what the person said about themselves, then the
 * billing country, then the jurisdiction recorded at their last consent. An IP
 * or a browser language is **observational** -- it may not settle a
 * jurisdiction on its own, and a low-confidence resolution holds marketing
 * rather than releasing it.
 *
 * Draft section 5.3 says the same thing from the other end: `self_declared`
 * replaces the candidate list, and everything else stays a list.
 */
export const DETERMINATIVE_COUNTRY_SIGNALS: ReadonlySet<string> = new Set([
  "self_declared",
  "billing",
  "consent",
]);

export type NoticeJurisdiction = {
  country: string;
  source: string;
};

/**
 * What the row's single `jurisdiction` column says, given the candidates.
 *
 * Counting *countries* was the second version of this and it was still wrong.
 * Two inferences that happen to agree on `AU` are still two inferences, and
 * sealing `AU` off them makes the column claim a settled jurisdiction the
 * approved contract does not let an inference settle. The row has no
 * confidence field and is append-only, so that claim would be permanent -- and
 * it would let section 5.6's override run on an account whose display duties
 * were never actually worked out, which is the exact thing `ZZ` refuses.
 *
 * So: one determinative country settles it. Anything else is `ZZ`, and the
 * source says which kind of nothing it was -- signals that disagree are
 * `conflict`, signals that are merely not determinative are `unresolved`.
 * The candidates themselves persist in the evidence either way, which is where
 * section 5.3 says they follow the person to the send snapshot.
 */
export const noticeJurisdiction = (
  candidates: readonly { country: string; signal: string }[]
): NoticeJurisdiction => {
  const determinative = candidates.filter((candidate) =>
    DETERMINATIVE_COUNTRY_SIGNALS.has(candidate.signal)
  );
  const settled = new Set(determinative.map((candidate) => candidate.country));
  if (settled.size === 1) {
    return {
      country: determinative[0]!.country,
      source: determinative[0]!.signal,
    };
  }
  if (settled.size > 1) return { country: "ZZ", source: "conflict" };

  const observed = new Set(candidates.map((candidate) => candidate.country));
  return { country: "ZZ", source: observed.size > 1 ? "conflict" : "unresolved" };
};

/**
 * The bytes two candidate lists are compared by.
 *
 * Keys sorted, because the stored copy comes back from `jsonb` and PostgreSQL
 * does not keep object key order -- it stores short keys first. Comparing
 * `JSON.stringify` of the two therefore said "different" for an identical
 * retry, which is the opposite of what the comparison is for: a double click
 * or a replayed request threw instead of returning the row it had already
 * written, and `notice_shown` is one per account so every later retry threw
 * too.
 *
 * Array order is **not** sorted. `jsonb` preserves it, and two lists holding
 * the same candidates in a different order came from different screens.
 */
export const canonicalCandidates = (value: unknown): string => {
  const canonical = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(canonical);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, inner]) => [key, canonical(inner)])
      );
    }
    return node;
  };
  return JSON.stringify(canonical(value));
};
