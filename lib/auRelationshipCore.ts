/**
 * The Australian relationship an inferred consent rests on, judged from stored
 * facts.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 4.4, with
 * the owner's R4 decision of 2026-09-29 (a relationship lasts while the last
 * sign-in is within 24 months; an address chosen through OAuth counts as one
 * the person entered).
 *
 * Section 4.4 asks for a model that stores events, not a function that infers a
 * relationship from whatever the account looks like today. So a relationship
 * exists only where a `relationship_started` event was written at signup, and
 * this decides only whether that recorded relationship still stands.
 *
 * Pure: no database, no clock.
 */

import {
  EMAIL_RELATIONSHIP_DORMANCY_MONTHS,
  addUtcMonths,
  relationshipEndedSourceEventKey,
  relationshipStartedSourceEventKey,
} from "./emailPreferenceCore";

export { addUtcMonths, relationshipEndedSourceEventKey, relationshipStartedSourceEventKey };

/** R4: the relationship ends when the last sign-in is older than this. */
export const AU_RELATIONSHIP_DORMANCY_MONTHS = EMAIL_RELATIONSHIP_DORMANCY_MONTHS;

/**
 * Sign-up notice copy versions whose wording tells the person that product
 * updates may be sent without their asking.
 *
 * Empty, and that is the point. Every approved sign-up notice says "if you turn
 * this on, Tomverse sends product updates", which a person reads as "and not
 * otherwise" -- the promise the owner kept on 2026-09-29 (decision B). A
 * relationship started under that screen would contradict what the screen said,
 * so none is recorded. A version is added here only once its wording is
 * approved as disclosing the relationship; until then no account acquires an
 * inferred consent, whatever the country rule says.
 */
export const RELATIONSHIP_DISCLOSING_SIGNUP_COPY_VERSIONS: readonly string[] = Object.freeze([]);

export const relationshipDisclosedBy = (copyVersion: string): boolean =>
  RELATIONSHIP_DISCLOSING_SIGNUP_COPY_VERSIONS.includes(copyVersion);

export type AuRelationshipFacts = {
  /** The account's `relationship_started` event, if one was written. */
  started: { id: string; emailAddress: string; occurredAt: Date } | null;
  /** Whether a `relationship_ended` event for that start exists. */
  ended: boolean;
  /** The address this message would go to, normalised the way events store it. */
  deliveryAddress: string;
  lastLoginAt: Date | null;
  accountDeletionRequestedAt: Date | null;
  /** The latest consent record for this purpose is a withdrawal. */
  consentWithdrawn: boolean;
  /** The amendment (E) is published and in force. */
  amendmentInForce: boolean;
  now: Date;
};

export type AuRelationshipRefusal =
  | "no_relationship"
  | "amendment_not_in_force"
  | "relationship_ended"
  | "address_changed"
  | "deletion_requested"
  | "dormant"
  | "consent_withdrawn";

export type AuRelationshipStanding =
  | { active: true; eventId: string }
  | { active: false; reason: AuRelationshipRefusal };

/**
 * Whether the recorded relationship stands for this message.
 *
 * Every end is final. An account restored from a deletion request, or a person
 * signing in again after 24 months, does not restart a relationship: the start
 * event is what the notice at signup covered, and nothing later re-shows it.
 * Dormancy is judged here from `lastLoginAt` until the next sign-in, and that
 * sign-in records it as an end (`endDormantEmailRelationshipAtSignIn()` in
 * lib/emailPreferences.ts) before `lastLoginAt` moves, in one transaction.
 */
export const auRelationshipStanding = (facts: AuRelationshipFacts): AuRelationshipStanding => {
  if (!facts.started) return { active: false, reason: "no_relationship" };
  if (!facts.amendmentInForce) return { active: false, reason: "amendment_not_in_force" };
  if (facts.ended) return { active: false, reason: "relationship_ended" };
  if (facts.accountDeletionRequestedAt !== null) {
    return { active: false, reason: "deletion_requested" };
  }
  // The relationship is with the mailbox the person gave at signup. A later
  // address was never covered by the notice they saw.
  if (facts.started.emailAddress.toLowerCase() !== facts.deliveryAddress.toLowerCase()) {
    return { active: false, reason: "address_changed" };
  }
  if (facts.consentWithdrawn) return { active: false, reason: "consent_withdrawn" };
  // No recorded sign-in is dormant, not "active since signup": the signup
  // itself sets `lastLoginAt`, so an account without one is not one we saw.
  const lastSeen = facts.lastLoginAt;
  if (lastSeen === null) return { active: false, reason: "dormant" };
  if (facts.now >= addUtcMonths(lastSeen, AU_RELATIONSHIP_DORMANCY_MONTHS)) {
    return { active: false, reason: "dormant" };
  }
  // A relationship cannot rest on a start the clock has not reached.
  if (facts.started.occurredAt > facts.now) return { active: false, reason: "no_relationship" };
  return { active: true, eventId: facts.started.id };
};
