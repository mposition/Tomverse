import { SEND_BLOCKERS, type SendVerdict, type SendBlocker } from "@/lib/releaseNotesSendVerdictCore";

/**
 * Which word a refused release-notes send is recorded under.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.6, which
 * names `permission_revoked` and `consent_withdrawn` for a send the verdict
 * refuses, and the `EmailDelivery_skip_reason_check` CHECK, which is the closed
 * list of words the column accepts.
 *
 * ## Why a table rather than a default
 *
 * The blockers are a closed list and the skip reasons are a closed list, and the
 * only thing that makes a row readable afterwards is that the mapping between
 * them was decided rather than fallen into. A `?? "permission_revoked"` would
 * compile for a blocker nobody had thought about, write a word that was not
 * true, and an operator reading the queue would be told a person had revoked
 * something they had never been asked about.
 *
 * `tests/releaseNotesSkipReason.test.mjs` fails when `SEND_BLOCKERS` gains an
 * entry this table does not name.
 *
 * ## The refusal with no blocker
 *
 * A send that needs an override and has none is refused with `blockers` empty:
 * `legalAllowed` is false and nothing was found that could have lifted it, and
 * section 5.6 is deliberate that an absent override is not the same event as one
 * that does not cover this person. So the legal refusal has its own answer here
 * rather than borrowing a blocker's, and `NO_BASIS_SKIP_REASON` is the word for
 * it: there is no consent and no other basis, which is what `no_consent` says.
 */

/** Every skip reason the column accepts that this module may write. */
export const RELEASE_NOTES_SKIP_REASONS = [
  "no_consent",
  "consent_withdrawn",
  "permission_revoked",
  "obligation_undecided",
  "display_contract_changed",
  "display_unsatisfiable",
  "jurisdiction_unconfirmed",
  "marketing_disabled",
] as const;

export type ReleaseNotesSkipReason = (typeof RELEASE_NOTES_SKIP_REASONS)[number];

/** What a send with no basis at all is recorded as. */
export const NO_BASIS_SKIP_REASON: ReleaseNotesSkipReason = "no_consent";

/**
 * One word per blocker, in the order a reader should be told about them.
 *
 * The order is the array's, not the blockers': a message blocked both because
 * the person objected and because a duty is unsettled is recorded as the
 * objection, because that is the fact that would still stop it after every duty
 * was settled. A record naming the duty would read as though settling it were
 * the way to reach this person.
 */
const BLOCKER_SKIP_REASON: Record<SendBlocker, ReleaseNotesSkipReason> = {
  // The mailbox asked to stop. Both of these are the person's own act, which is
  // why they come first and why neither is `no_consent` -- there was consent,
  // and it was taken back.
  objected: "permission_revoked",
  suppressed: "consent_withdrawn",
  // The approval this send was going to rest on does not cover it. Not the
  // person's act, but it is about who this message may go to, so it is read
  // before anything about the message's contents.
  approval_member_mismatch: "permission_revoked",
  // No country, or two that disagree. Nothing about the message is decidable
  // until this is, because every rule below is a country's.
  country_undetermined: "jurisdiction_unconfirmed",
  // The product, or marketing as a whole, is switched off. Above the duties
  // because an operator who turned it off is not waiting for a duty.
  feature_disabled: "marketing_disabled",
  // A statutory duty of some candidate country is unsettled.
  obligation_undecided: "obligation_undecided",
  // The duties cannot be composed into one message at all.
  display_unsatisfiable: "display_unsatisfiable",
  // The contract moved. Last, because it is the only one that produces a
  // replacement rather than an ending, and `reenqueueIsRight()` requires it to
  // be the *only* blocker -- so where it shares the list with any other, that
  // other one is the reason the message stops.
  display_contract_changed: "display_contract_changed",
};

/** The order refusals are reported in, most decisive first. */
const REPORTING_ORDER: readonly SendBlocker[] = [
  "objected",
  "suppressed",
  "approval_member_mismatch",
  "country_undetermined",
  "feature_disabled",
  "obligation_undecided",
  "display_unsatisfiable",
  "display_contract_changed",
];

/** The blockers this table does not name, which is what the test asserts is empty. */
export const unmappedBlockers = (): string[] =>
  SEND_BLOCKERS.filter(
    (blocker) => !(blocker in BLOCKER_SKIP_REASON) || !REPORTING_ORDER.includes(blocker)
  );

/**
 * The word to record a refused send under, or null where it was not refused.
 *
 * Null rather than a reason for an allowed verdict: a caller that asked for a
 * reason and got one would be able to skip a message the verdict allowed.
 */
export const releaseNotesSkipReason = (
  verdict: Pick<SendVerdict, "allowed" | "blockers">
): ReleaseNotesSkipReason | null => {
  if (verdict.allowed) return null;
  const present = new Set<string>(verdict.blockers);
  for (const blocker of REPORTING_ORDER) {
    if (present.has(blocker)) return BLOCKER_SKIP_REASON[blocker];
  }
  // Refused with nothing in the list: the legal refusal itself. See the module
  // comment.
  return NO_BASIS_SKIP_REASON;
};
