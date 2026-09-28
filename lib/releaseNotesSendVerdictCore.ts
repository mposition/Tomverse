/**
 * Whether one release-notes message may be sent to one recipient, and why not.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.6, whose
 * signature this follows; sections 5.3, 5.6, 7.7 and 7.8 for the parts it
 * composes; docs/policy/email-notifications.md section 5.1.1 for the rules.
 *
 * ## One function, four callers
 *
 * Section 7.6 asks for one verdict shared by the audience estimate, the
 * audience expansion, the writer and the drain. Four readings of the same rules
 * is how an estimate comes to disagree with what is sent, and the disagreement
 * is only ever found by somebody counting the difference afterwards.
 *
 * ## The three things that are not each other
 *
 * - **`legalAllowed`** is what the authorities say: the recipient's country
 *   rule and the Australian sender authority, every one of them allowing
 *   (`releaseNotesAuthorityVerdict()`).
 * - **`overrideApplied`** is a decision recorded above that, never a change to
 *   it. Section 5.6 rule 2: the refusal stays in the record and the override
 *   sits beside it.
 * - **`blockers`** are what neither can cross -- a suppression, an objection,
 *   an undecided duty, a flag that is off, a display contract that cannot be
 *   met. Section 5.6's table says the override does not pass these, and that is
 *   the whole reason they are a separate list rather than part of the authority
 *   verdict.
 *
 * `allowed` is `decisionAllowed()`, which the database also computes as a
 * CHECK. Both exist because they fail differently.
 *
 * ## Pure, and deliberately ignorant
 *
 * No database, no clock, no environment. Every fact arrives as an input,
 * because this is the function four callers share and the only way they can
 * share it is if it reads nothing for itself. What reads the rows is S9's
 * server half; what decides is here.
 */

import {
  approvalScopeRefusal,
  cohortRefusal,
  decisionAllowed,
  type ApprovalScopeInput,
} from "@/lib/emailPermissionLedgerCore";
import {
  releaseNotesAuthorityVerdict,
  type ReleaseNotesAuthorityVerdict,
  type ReleaseNotesConsentInput,
  type ReleaseNotesRuleBasis,
  type ReleaseNotesRuleForVerdict,
} from "@/lib/releaseNotesCountryRuleCore";
import {
  obligationsVerdict,
  type ObligationsVerdict,
  type StoredObligation,
  type WaiverApproval,
} from "@/lib/releaseNotesObligationCore";

/**
 * Why a send is held back, whatever the authorities or an override say.
 *
 * Closed, because a blocker is what a caller reports and a reader acts on: an
 * open string here would be a reason nobody can look up, in the one field that
 * exists to be looked up.
 */
export const SEND_BLOCKERS = [
  /** A cause at any scope covering this purpose (draft section 7.4). */
  "suppressed",
  /** The person refused, on the signup form or the in-product notice. */
  "objected",
  /** No country at all, or two that disagree (section 5.3). */
  "country_undetermined",
  /** A statutory duty of some candidate country is unsettled (section 7.8). */
  "obligation_undecided",
  /** The release-notes feature, or marketing as a whole, is off. */
  "feature_disabled",
  /** The pinned display metadata no longer meets what the duties require (C16). */
  "display_contract_changed",
  /** The candidate countries' display obligations cannot be composed (section 5.3). */
  "display_unsatisfiable",
  /**
   * An override was needed and does not apply (section 5.6).
   *
   * The name section 5.6 gives it, which is about the cohort, and it covers the
   * scope too: both are "the approval this send was going to rest on does not
   * cover it". `overrideRefusal` carries which of the ten reasons it was, in the
   * ledger's own words (`approvalScopeRefusal()`, `cohortRefusal()`), so an
   * operator reads the same word here as on the approval and this list stays one
   * a reader can hold in their head.
   */
  "approval_member_mismatch",
] as const;

export type SendBlocker = (typeof SEND_BLOCKERS)[number];

/** What the caller knows about the person's own answers. */
export type RecipientState = {
  /** A live suppression cause covering this purpose, at any scope. */
  suppressed: boolean;
  /** An `objected` permission event for this address. */
  objected: boolean;
  consent: ReleaseNotesConsentInput;
};

/** The flags this send is behind, resolved server-side and passed in. */
export type SendFlags = {
  marketingEnabled: boolean;
  releaseNotesEnabled: boolean;
};

/**
 * The display contract, hashed at enqueue and recomputed at send.
 *
 * `null` for `required` means the obligations could not be composed into one
 * contract at all, which is `display_unsatisfiable` rather than a mismatch --
 * a different fact, and one a reader would otherwise have to guess at from a
 * hash that is simply absent.
 */
export type DisplayContract = {
  pinnedDisplayContractHash: string | null;
  requiredDisplayContractHash: string | null;
};

/**
 * The `risk_accepted` approval a send would rest on, as it is stored.
 *
 * The rows, not a caller's summary of them. An earlier draft took two booleans
 * -- the scope matches, the cohort matches -- and that is the shape in which a
 * caller decides the thing this function exists to decide: four callers, four
 * readings, and no way for the verdict to disagree with any of them. Sealing,
 * revocation, scope and cohort are judged here, by the ledger's own functions.
 */
export type OverrideInput = {
  approvalId: string;
  approval: ApprovalScopeInput;
  /** The cohort row for this account, or null where there is none. */
  member: {
    userId: string;
    addressDigest: string;
    addressNormalizationVersion: string;
  } | null;
  userId: string | null;
  /** The address pinned on the delivery at enqueue, and the account's address now. */
  deliveryAddressDigest: string | null;
  currentAddressDigest: string | null;
  /**
   * The rule that produced the two digests above.
   *
   * Carried rather than assumed, because `cohortMismatchReason()` refuses a
   * member whose digests were computed under a different rule. Two
   * normalization rules produce two different digests of the same mailbox, so
   * comparing across them answers "not this person" for the person -- or, if a
   * later rule collapsed a distinction an earlier one kept, "this person" for
   * somebody else.
   */
  addressNormalizationVersion: string;
};

export type SendVerdictInput = {
  purpose: string;
  policyVersionId: string;
  /** The persisted candidate countries (section 5.3). Empty means `ZZ`. */
  countries: readonly string[];
  /** The rules of `policyVersionId`, one per country at most. */
  rules: readonly ReleaseNotesRuleForVerdict[];
  /** The duty states of every candidate country's rule version. */
  obligations: Readonly<Record<string, readonly StoredObligation[]>>;
  /** Per readiness check name, whether it passes. */
  readiness: Readonly<Record<string, boolean>>;
  waivers: readonly WaiverApproval[];
  recipient: RecipientState;
  flags: SendFlags;
  display: DisplayContract;
  /** The override, or null where there is none to apply. */
  override: OverrideInput | null;
  phase: "enqueue" | "send";
  now: Date;
};

export type SendVerdict = {
  authorities: ReleaseNotesAuthorityVerdict[];
  legalAllowed: boolean;
  /** One basis satisfied every authority, where one did. */
  sharedBasis: ReleaseNotesRuleBasis | null;
  overrideApplied: { approvalId: string; type: "risk_accepted" } | null;
  /**
   * Why the override did not apply, where one was needed and did not.
   *
   * Null both when none was needed and when one applied: `overrideApplied` says
   * which of those it was, and a reason for a send that was never resting on an
   * override would read as though it had been.
   */
  overrideRefusal: string | null;
  blockers: SendBlocker[];
  /**
   * The countries this verdict was taken over, whatever it found about them.
   *
   * Carried because the snapshot has to record what was considered, and the
   * obvious substitute -- the keys of `obligations` -- silently drops any
   * candidate with no country rule. A record that named only the countries that
   * had rules would say nothing was asked about the one that refused the send.
   */
  countries: string[];
  /** Per country, the duty verdict, for the record and for the operator. */
  obligations: Record<string, ObligationsVerdict>;
  displayContract: {
    pinnedDisplayContractHash: string | null;
    requiredDisplayContractHash: string | null;
    satisfied: boolean;
  };
  allowed: boolean;
  ruleVersions: { ruleKey: string; ruleVersion: number }[];
  policyVersionId: string;
  phase: "enqueue" | "send";
  evaluatedAt: Date;
};

/**
 * The verdict.
 *
 * The order below is not a precedence: every part is computed, because the
 * record has to say everything that was true and not only the first thing that
 * stopped it. An operator asking why somebody was skipped is asking for all of
 * it.
 */
export const releaseNotesSendVerdict = (input: SendVerdictInput): SendVerdict => {
  const authority = releaseNotesAuthorityVerdict({
    countries: input.countries,
    rules: input.rules,
    consent: input.recipient.consent,
  });

  // The duties of every candidate country, not only the first. Two candidates
  // both have to pass (section 5.3), and that includes their duties.
  const byCountry = new Map(input.rules.map((rule) => [rule.countryCode, rule]));
  const obligations: Record<string, ObligationsVerdict> = {};
  for (const countryCode of [...new Set(input.countries)].sort()) {
    const rule = byCountry.get(countryCode);
    if (!rule) continue; // Already refused as `no_country_rule` by the authority.
    obligations[countryCode] = obligationsVerdict({
      countryCode,
      ruleKey: rule.ruleKey,
      ruleVersion: rule.ruleVersion,
      policyVersionId: input.policyVersionId,
      stored: input.obligations[countryCode] ?? [],
      readiness: input.readiness,
      waivers: input.waivers,
      now: input.now,
    });
  }

  const blockers: SendBlocker[] = [];
  if (input.recipient.suppressed) blockers.push("suppressed");
  if (input.recipient.objected) blockers.push("objected");

  // An undetermined country is a blocker as well as an authority refusal, and
  // the two say different things: the authority says the law was not satisfied,
  // the blocker says an override cannot help. Section 5.6's table puts ZZ on the
  // side the override does not cross.
  const undetermined =
    input.countries.length === 0 || input.countries.some((country) => country === "ZZ");
  if (undetermined) blockers.push("country_undetermined");

  if (Object.values(obligations).some((verdict) => !verdict.allSettled)) {
    blockers.push("obligation_undecided");
  }

  if (!input.flags.marketingEnabled || !input.flags.releaseNotesEnabled) {
    blockers.push("feature_disabled");
  }

  // Three states, and they are not two. No required hash is a contract that
  // could not be composed; a required hash that differs from the pinned one is
  // a contract that moved; equal is satisfied. Only the middle one is a
  // re-enqueue (C16), which is why they cannot share a name.
  //
  // And the comparison is the send's, not the enqueue's. At enqueue the pinned
  // hash is the value about to be written, so there is nothing to compare it
  // with; comparing anyway made every first enqueue a
  // `display_contract_changed`, which is the blocker that means the opposite of
  // what had happened. At send a pin that is absent is also a mismatch: the
  // contract this message was pinned to cannot be confirmed to be the one the
  // duties now require, and that is the same refusal for the same reason.
  const composable = input.display.requiredDisplayContractHash !== null;
  const satisfied =
    composable &&
    (input.phase === "enqueue" ||
      input.display.pinnedDisplayContractHash ===
        input.display.requiredDisplayContractHash);
  if (!composable) {
    blockers.push("display_unsatisfiable");
  } else if (!satisfied) {
    blockers.push("display_contract_changed");
  }

  // The override applies only where it is needed, sealed and unrevoked for this
  // purpose and policy version, and naming this person. Where it is needed and
  // does not apply, that is its own blocker rather than a silent absence: the
  // send was going to rest on it, and "no override" and "an override that does
  // not cover you" are different things to read afterwards.
  //
  // Where it is not needed it is not consulted at all. Section 5.6 rule 2: an
  // override sits above a refusal, so applying one to a send the law already
  // allows would put an approval in the record as the reason for something it
  // was not the reason for.
  const overrideNeeded = !authority.legalAllowed;
  let overrideApplied: SendVerdict["overrideApplied"] = null;
  let overrideRefusal: string | null = null;
  if (overrideNeeded && input.override !== null) {
    overrideRefusal =
      approvalScopeRefusal(input.override.approval, {
        approvalType: "risk_accepted",
        policyVersionId: input.policyVersionId,
        purpose: input.purpose,
      }) ??
      cohortRefusal({
        member: input.override.member,
        userId: input.override.userId,
        deliveryAddressDigest: input.override.deliveryAddressDigest,
        currentAddressDigest: input.override.currentAddressDigest,
        addressNormalizationVersion: input.override.addressNormalizationVersion,
      });
    if (overrideRefusal === null) {
      overrideApplied = { approvalId: input.override.approvalId, type: "risk_accepted" };
    } else {
      blockers.push("approval_member_mismatch");
    }
  }

  return {
    authorities: authority.authorities,
    legalAllowed: authority.legalAllowed,
    sharedBasis: authority.sharedBasis,
    overrideApplied,
    overrideRefusal,
    blockers,
    countries: [...new Set(input.countries)].sort(),
    obligations,
    displayContract: {
      pinnedDisplayContractHash: input.display.pinnedDisplayContractHash,
      requiredDisplayContractHash: input.display.requiredDisplayContractHash,
      satisfied,
    },
    allowed: decisionAllowed({
      legalAllowed: authority.legalAllowed,
      overrideApplied: overrideApplied !== null,
      blockers,
    }),
    ruleVersions: authority.ruleVersions,
    policyVersionId: input.policyVersionId,
    phase: input.phase,
    evaluatedAt: input.now,
  };
};
