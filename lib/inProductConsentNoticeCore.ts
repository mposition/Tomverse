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
 * What the row's single `jurisdiction` column says, given what the resolver
 * answered.
 *
 * This function does **not** decide the jurisdiction. It takes the answer
 * `resolveEmailJurisdiction()` already produced and says how to write it into
 * two columns that have no room for a confidence.
 *
 * It used to decide, and it was wrong twice. The first version counted
 * candidates, so two signals agreeing on `AU` came out undetermined. The
 * second counted countries against a hand-written list of "determinative"
 * signals, and that list disagreed with the approved contract in four places.
 * There is one jurisdiction rule in this codebase and it is not here.
 *
 * ## One guard, and it is about confidence rather than about the country
 *
 * A resolution below `high` is written as `ZZ`. An inference does not settle
 * a jurisdiction (approved contract sections 6.2 and 6.3), this row has no
 * confidence column to record that it was only a guess, and it is append-only.
 * The same condition gates `marketingJurisdictionVerdict()`, so the ledger and
 * the send agree about what counts as settled.
 *
 * ## The guard this function used to have, and why it was removed
 *
 * It also erased a country whose `profileForCountry()` is `ZZ` -- a
 * self-declared `JP` was written down as `unresolved`. That was wrong twice
 * over. Section 6.3's "no reviewed profile" row means *hold marketing for that
 * country*, not *treat it as a country we never learned*; section 6.4 gives
 * this column the resolution as it stood, and append-only means a profile
 * added next year cannot restore the `JP` that was thrown away. The
 * candidates could not stand in for it either -- they record which rules were
 * rendered, not what was resolved.
 *
 * And it did not close the hole it named. Refusing an override for a country
 * with no display duties is `overrideBlockers()`'s job, which checked the
 * literal string `ZZ` and let `JP` through however this column was written.
 * That check is in that function now, where a send actually passes.
 */
export type NoticeJurisdiction = {
  country: string;
  source: string;
};

export const noticeJurisdictionColumns = (resolved: {
  countryCode: string;
  profileKey: string;
  confidence: string;
  source: string;
}): NoticeJurisdiction =>
  resolved.confidence === "high" && resolved.countryCode !== "ZZ"
    ? { country: resolved.countryCode, source: resolved.source }
    : {
        country: "ZZ",
        // `conflict` is the resolver's word for two high-confidence signals
        // disagreeing, and it keeps that meaning. Everything else that failed
        // to settle is `unresolved`, which is a different fact.
        source: resolved.confidence === "conflict" ? "conflict" : "unresolved",
      };

/**
 * The bytes two recorded facts are compared by.
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
 *
 * It compares whole facts rather than candidate lists, and the rename followed
 * the widening: comparing the candidates alone let a retry that carried a
 * different resolution, or different words on the screen, come back as success
 * with the first write's values standing.
 */
export const canonicalJson = (value: unknown): string => {
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

/**
 * The signals a rendered candidate may name.
 *
 * The same six `ResolvedJurisdiction.source` uses, because a candidate says
 * which signal put that country's rule on the screen and there is no other
 * place a signal could come from.
 *
 * Closed because the evidence is append-only. `signal` was checked for being
 * non-empty, so `"self-declared"` with a hyphen went in and stayed, and a
 * later reader counting by signal would simply not see it.
 */
export const NOTICE_CANDIDATE_SIGNALS: ReadonlySet<string> = new Set([
  "billing",
  "self_declared",
  "consent",
  "inferred",
  "conflict",
  "unresolved",
]);

/**
 * The sources that can carry `high` confidence.
 *
 * The approved contract's sections 6.1 to 6.3: what the person said, the
 * billing country, and the jurisdiction recorded at their last consent. An
 * inference is `low` by construction, so `high` plus `inferred` is a pair
 * `resolveEmailJurisdiction()` never produces -- and one that would have
 * settled the column on a guess, with `profileForCountry()` finding a real
 * profile so the override's `country_undetermined` would not have stopped it
 * either.
 */
export const DETERMINATIVE_JURISDICTION_SOURCES: ReadonlySet<string> = new Set([
  "billing",
  "self_declared",
  "consent",
]);
