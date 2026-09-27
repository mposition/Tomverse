/**
 * The statutory duties a country's release-notes rule carries, and whether each
 * one is settled.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md sections 7.7 and
 * 7.8; docs/policy/email-notifications.md section 5.1.1 for the rules these
 * hang off.
 *
 * ## This is not a switch for turning duties off
 *
 * An earlier design blocked the Korean rule if any duty was missing, and the
 * accident it guarded against was a duty nobody noticed had gone -- not an
 * owner deciding, in writing, not to do one. So a duty has three settled
 * states and every one of them has to carry its own evidence:
 *
 * - `implemented` names the readiness check that confirms it;
 * - `deferred` names the date it must exist by;
 * - `waived` names the `EmailSendApproval` that decided not to do it, whose
 *   approver, date, reason and review condition live in that ledger.
 *
 * **A duty with no state blocks its rule.** That is the whole mechanism: the
 * list of duties lives in code, the states live in rows, and a duty added here
 * stops every send under that rule until somebody settles it. Nothing about
 * that is Korea-specific -- Singapore's `<ADV>` label and the United States'
 * postal address are on the same list, both `implemented`.
 *
 * Pure: no database, no clock beyond the `now` a caller passes.
 */

import type { EmailSendApprovalType } from "@/lib/emailPermissionLedgerCore";

/** How a duty is settled. A fourth value would be a fourth kind of evidence. */
export const OBLIGATION_STATES = ["implemented", "deferred", "waived"] as const;

export type ObligationState = (typeof OBLIGATION_STATES)[number];

/**
 * Every duty this build knows about, per country.
 *
 * Written here rather than read from the rows, because the rows are what an
 * operator settles and this is what the law asks for. A duty in this list with
 * no row is unsettled; a row for a duty not in this list is a leftover the
 * verdict reports rather than obeys -- it cannot be silently honoured, because
 * nothing in this build knows what it would mean.
 *
 * The sources are section 7.7's table for Korea, and the country records the
 * jurisdiction review wrote for the other two.
 */
export const RELEASE_NOTES_OBLIGATIONS: Record<string, readonly string[]> = {
  KR: [
    // 시행령 별표 6: the sender's name, address, email and telephone number.
    "body_disclosures",
    // 별표 6 again: the unsubscribe notice in Korean and English, and a simple
    // technical means of acting on it.
    "bilingual_unsubscribe_notice",
    // The Korean guidance: unsubscribing may not require a login.
    "no_login_for_unsubscribe",
    // 제50조제7항 and 시행령 제62조의2: tell the person the outcome within 14 days.
    "consent_result_notice_14_days",
    // 제50조제8항 and 시행령 제62조의3: every two years, state the consent held.
    "biennial_consent_notice",
    // 제50조제4항 and 별표 6: the `(광고)` subject prefix.
    "advertising_subject_label",
  ],
  SG: [
    // The Spam Control Act's `<ADV>` subject label and its unsubscribe
    // requirements.
    "adv_subject_label",
  ],
  US: [
    // CAN-SPAM: a valid physical postal address in every message.
    "postal_address",
  ],
};

/** The duties a country's rule carries, or none. */
export const obligationsFor = (countryCode: string): readonly string[] =>
  RELEASE_NOTES_OBLIGATIONS[countryCode] ?? [];

/** A stored duty state, as much of it as the verdict reads. */
export type StoredObligation = {
  obligationKey: string;
  state: ObligationState;
  /** The readiness check that confirms an `implemented` duty. */
  readinessCheck: string | null;
  /** When a `deferred` duty must exist by. */
  dueBy: Date | null;
  /** How long before `dueBy` the report starts warning. */
  warnDaysBefore: number | null;
  /** The approval that waived it. */
  waiverApprovalId: string | null;
};

/**
 * The approval a waived duty names, as the ledger holds it. The verdict
 * compares its scope rather than trusting the link, because a link says which
 * row and not what that row decided.
 */
export type WaiverApproval = {
  id: string;
  approvalType: EmailSendApprovalType;
  sealedAt: Date | null;
  revoked: boolean;
  policyVersionId: string | null;
  ruleKey: string | null;
  ruleVersion: number | null;
  country: string | null;
  obligationKey: string | null;
};

/** Why a duty does not settle. Closed, so a verdict carries no prose. */
export const OBLIGATION_REFUSALS = [
  "no_state",
  "readiness_check_failing",
  "readiness_check_unknown",
  "deferral_overdue",
  "waiver_missing",
  "waiver_not_sealed",
  "waiver_revoked",
  "waiver_wrong_type",
  "waiver_scope_mismatch",
  "unknown_obligation",
] as const;

export type ObligationRefusal = (typeof OBLIGATION_REFUSALS)[number];

export type ObligationVerdict = {
  obligationKey: string;
  /** Null where the duty has no row at all. */
  state: ObligationState | null;
  settled: boolean;
  reason: ObligationRefusal | null;
  /** Set for a deferral whose date is near but not passed. */
  warning: "deferral_due_soon" | null;
};

export type ObligationsVerdict = {
  obligations: ObligationVerdict[];
  /** Every duty settled. A rule does not send otherwise. */
  allSettled: boolean;
  /** The duties that blocked, in the order the list declares them. */
  blockers: string[];
  /** Duties a row claims that this build does not know. Reported, never obeyed. */
  unknown: string[];
  warnings: string[];
};

const DAY_MS = 86_400_000;

/**
 * Whether every duty of one country's rule is settled, and what is missing.
 *
 * `readiness` answers, per check name, whether that check currently passes.
 * A name it does not know is `readiness_check_unknown` rather than a pass:
 * a duty confirmed by a check nobody runs is a duty nobody is confirming, and
 * the same reasoning that makes an absent state block makes an absent check
 * block (invariant 9).
 */
export const obligationsVerdict = (input: {
  countryCode: string;
  ruleKey: string;
  ruleVersion: number;
  policyVersionId: string;
  stored: readonly StoredObligation[];
  readiness: Readonly<Record<string, boolean>>;
  waivers: readonly WaiverApproval[];
  now: Date;
}): ObligationsVerdict => {
  const declared = obligationsFor(input.countryCode);
  const byKey = new Map(input.stored.map((row) => [row.obligationKey, row]));
  const approvals = new Map(input.waivers.map((row) => [row.id, row]));

  const obligations = declared.map((obligationKey): ObligationVerdict => {
    const row = byKey.get(obligationKey);
    if (!row) {
      return { obligationKey, state: null, settled: false, reason: "no_state", warning: null };
    }
    const settled = (warning: ObligationVerdict["warning"] = null): ObligationVerdict => ({
      obligationKey,
      state: row.state,
      settled: true,
      reason: null,
      warning,
    });
    const refused = (reason: ObligationRefusal): ObligationVerdict => ({
      obligationKey,
      state: row.state,
      settled: false,
      reason,
      warning: null,
    });

    if (row.state === "implemented") {
      // The CHECK holds a readiness check name here, so a null is a schema that
      // moved ahead of this build rather than a duty with no check.
      if (row.readinessCheck === null) return refused("readiness_check_unknown");
      const passing = input.readiness[row.readinessCheck];
      if (passing === undefined) return refused("readiness_check_unknown");
      return passing ? settled() : refused("readiness_check_failing");
    }

    if (row.state === "deferred") {
      if (row.dueBy === null) return refused("deferral_overdue");
      if (row.dueBy.getTime() <= input.now.getTime()) return refused("deferral_overdue");
      const warnFrom =
        row.warnDaysBefore === null
          ? null
          : row.dueBy.getTime() - row.warnDaysBefore * DAY_MS;
      return settled(
        warnFrom !== null && input.now.getTime() >= warnFrom ? "deferral_due_soon" : null
      );
    }

    // Waived. The link is not the decision: the approval's own scope has to be
    // this rule version, this country and this duty, or the waiver covers
    // something else and the duty is as unsettled as if nobody had decided.
    if (row.waiverApprovalId === null) return refused("waiver_missing");
    const approval = approvals.get(row.waiverApprovalId);
    if (!approval) return refused("waiver_missing");
    if (approval.approvalType !== "obligation_waiver") return refused("waiver_wrong_type");
    if (approval.sealedAt === null) return refused("waiver_not_sealed");
    if (approval.revoked) return refused("waiver_revoked");
    if (
      approval.policyVersionId !== input.policyVersionId ||
      approval.ruleKey !== input.ruleKey ||
      approval.ruleVersion !== input.ruleVersion ||
      approval.country !== input.countryCode ||
      approval.obligationKey !== obligationKey
    ) {
      return refused("waiver_scope_mismatch");
    }
    return settled();
  });

  const known = new Set(declared);
  const unknown = input.stored
    .map((row) => row.obligationKey)
    .filter((key) => !known.has(key))
    .sort();

  return {
    obligations,
    allSettled: obligations.every((entry) => entry.settled),
    blockers: obligations.filter((entry) => !entry.settled).map((entry) => entry.obligationKey),
    unknown,
    warnings: obligations
      .filter((entry) => entry.warning !== null)
      .map((entry) => entry.obligationKey),
  };
};

/**
 * What the seed says each duty's state is, for the countries that have any.
 *
 * Section 7.7 decided Korea's six, one by one; the other two countries' single
 * duties were already being done when their country records were written. The
 * rows are written with a policy draft, like the rules themselves, so a version
 * is activated with the duty states it was reviewed with.
 *
 * `waived` carries no approval id here: an approval is a person's act, recorded
 * in the ledger by that person, and a seed that invented one would be inventing
 * the decision. The `(광고)` exemption section 7.7 records is exactly that case
 * -- the owner decided it, and the row that says so is written when the
 * approval exists. Until then the duty is unsettled and Korea does not send,
 * which is what an undecided duty is supposed to do.
 */
export type ObligationSeed = {
  countryCode: string;
  obligationKey: string;
  state: ObligationState;
  readinessCheck: string | null;
  dueByIso: string | null;
  warnDaysBefore: number | null;
  notes: string;
};

const DRAFT = "docs/policy/email-product-news-redesign-draft.md";

export const releaseNotesObligationSeed = (): readonly ObligationSeed[] => [
  {
    countryCode: "KR",
    obligationKey: "body_disclosures",
    state: "implemented",
    readinessCheck: "emailBusinessIdentity",
    dueByIso: null,
    warnDaysBefore: null,
    notes: `${DRAFT} section 7.7: name, address, email and telephone number (시행령 별표 6). The KR profile names contact_phone and the renderer drops a footer whose named block has no value, so readiness confirming the identity values is what confirms this.`,
  },
  {
    countryCode: "KR",
    obligationKey: "bilingual_unsubscribe_notice",
    state: "implemented",
    readinessCheck: "emailUnsubscribeKeyring",
    dueByIso: null,
    warnDaysBefore: null,
    notes: `${DRAFT} section 7.7: the unsubscribe notice in both languages and a simple means of acting on it. The footer prints both, and one-click already exists; the keyring check is what confirms the link can be produced at all.`,
  },
  {
    countryCode: "KR",
    obligationKey: "no_login_for_unsubscribe",
    state: "implemented",
    readinessCheck: "emailUnsubscribeKeyring",
    dueByIso: null,
    warnDaysBefore: null,
    notes: `${DRAFT} section 7.7: unsubscribing may not require a login. The token path is what makes that true, so the keyring check confirms it.`,
  },
  {
    countryCode: "SG",
    obligationKey: "adv_subject_label",
    state: "implemented",
    readinessCheck: "emailSubjectLabels",
    dueByIso: null,
    warnDaysBefore: null,
    notes: "The Spam Control Act's <ADV> label, carried by the SG profile's subject prefix.",
  },
  {
    countryCode: "US",
    obligationKey: "postal_address",
    state: "implemented",
    readinessCheck: "emailBusinessIdentity",
    dueByIso: null,
    warnDaysBefore: null,
    notes: "CAN-SPAM: a valid physical postal address in every message. It is in the common footer of every profile.",
  },
];

/** What is wrong with the obligation seed, in the terms the migration's CHECKs use. */
export const releaseNotesObligationSeedProblems = (): string[] => {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of releaseNotesObligationSeed()) {
    const key = `${row.countryCode}:${row.obligationKey}`;
    if (seen.has(key)) problems.push(`${key}: declared twice`);
    seen.add(key);
    if (!obligationsFor(row.countryCode).includes(row.obligationKey)) {
      problems.push(`${key}: not a duty this build knows`);
    }
    if (row.state === "implemented" && !row.readinessCheck) {
      problems.push(`${key}: implemented needs the check that confirms it`);
    }
    if (row.state !== "implemented" && row.readinessCheck) {
      problems.push(`${key}: only implemented names a readiness check`);
    }
    if (row.state === "deferred" && !row.dueByIso) {
      problems.push(`${key}: deferred needs a date it must exist by`);
    }
    if (row.state !== "deferred" && (row.dueByIso || row.warnDaysBefore !== null)) {
      problems.push(`${key}: only deferred carries a deadline`);
    }
    // A seed cannot waive anything: an approval is a person's act.
    if (row.state === "waived") {
      problems.push(`${key}: a seed cannot waive a duty, only an approval can`);
    }
    if (!row.notes.trim()) problems.push(`${key}: has no source`);
  }
  return problems;
};
