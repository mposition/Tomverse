/**
 * The display contract: what every candidate country's duties require a message
 * to show, as one value with one hash.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.6 (C16,
 * C33) and section 5.3; section 7.7 for which duties are display duties.
 *
 * ## Why a hash at all
 *
 * Rendering is fixed at enqueue and authority is decided again at send. The gap
 * is C16: the duties can change while a message sits in the queue, and the old
 * footer would then pass a check that only looked at the authorities. So the
 * contract the message was rendered to is pinned on the delivery, recomputed at
 * send, and a difference is `display_contract_changed` -- skip, and re-enqueue
 * under the current one.
 *
 * A hash rather than the value, on the delivery row, because the comparison is
 * equality and the value is long. The value is what the snapshot keeps.
 *
 * ## Composition, and when it fails
 *
 * A message has one subject and one footer, and section 5.3 says every candidate
 * country's rule has to be satisfied -- so the contract is the union, and where
 * two countries ask for things that cannot both be true of one message there is
 * no contract to render and the send is refused (`display_unsatisfiable`).
 *
 * The one that genuinely cannot compose is the subject prefix: two statutes each
 * requiring their own token at the front of the subject cannot both have it
 * there. Korea's `(광고)` and Singapore's `<ADV>` are exactly that pair, and the
 * honest answer is to refuse rather than to pick one and record that both were
 * satisfied. Footer blocks are a union and always compose. An unsubscribe notice
 * takes the strictest of each part: the shortest deadline, and every language any
 * candidate asks for.
 *
 * ## Pure
 *
 * No database, no clock. The rows arrive as inputs, the same way
 * `releaseNotesSendVerdict()` takes its facts, because the same value has to be
 * computable at enqueue from the profile being pinned and at send from the
 * profile as it is now.
 */

import { createHash } from "node:crypto";

/** What one country's duties require a message to show. */
export type CountryDisplayRequirement = {
  countryCode: string;
  /**
   * The jurisdiction profile the requirement was read from, which is the profile
   * the message has to be rendered with.
   *
   * In the contract because the send renders from the profile the *row* pins,
   * and the hash is the only thing compared at send. Without it a recipient who
   * moved from one country to another between enqueue and send got a replacement
   * that carried the new country's hash and the old country's profile: the next
   * drain found the hashes equal, recorded the new contract as satisfied, and
   * printed the old footer. With it, equal hashes mean the pinned profile is the
   * one the contract was composed from.
   */
  profileKey: string;
  ruleKey: string;
  ruleVersion: number;
  /** The subject token this country requires at the front, or null. */
  subjectPrefix: string | null;
  /** The footer block ids this country's rule requires. */
  footerBlocks: readonly string[];
  /** Business days this country allows an unsubscribe to take effect in. */
  unsubscribeSlaBusinessDays: number;
  /** The languages this country requires the unsubscribe notice in. */
  unsubscribeLanguages: readonly string[];
  /**
   * The display duties of this country and what settled each one, as
   * `obligationsVerdict()` reports them.
   *
   * In the contract because a duty settled by a waiver and a duty settled by a
   * readiness check are different contracts, even where they produce the same
   * footer: the waiver can be withdrawn, and then the message in the queue was
   * rendered under an authority that no longer exists.
   */
  displayObligations: ReadonlyArray<{
    obligationKey: string;
    state: "implemented" | "deferred" | "waived";
    /** The approval that waived it, where one did. */
    waiverApprovalId: string | null;
  }>;
};

/** Why the candidates' requirements cannot be composed into one message. */
export type DisplayCompositionRefusal = {
  reason: "conflicting_subject_prefix";
  detail: string;
};

/** The composed contract, in the shape that is hashed. */
export type DisplayContract = {
  /** The profiles the requirements were read from, sorted. See `profileKey`. */
  profileKeys: string[];
  /** Every candidate's rule version, sorted, so a rule change moves the hash. */
  ruleVersions: Array<{ ruleKey: string; ruleVersion: number }>;
  /** Per display duty, what state settled it and under whose approval. */
  displayObligations: Array<{
    countryCode: string;
    obligationKey: string;
    state: string;
    waiverApprovalId: string | null;
  }>;
  /** Every waiver this contract rests on, sorted. */
  waiverApprovalIds: string[];
  subjectPrefix: string | null;
  footerBlocks: string[];
  unsubscribeSlaBusinessDays: number | null;
  unsubscribeLanguages: string[];
  templateVersionId: string;
};

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The contract every candidate's requirements compose into, or why they do not.
 *
 * `templateVersionId` is part of it because the same obligations rendered by a
 * different template are a different message; section 7.6 names it in the list.
 */
export const composeDisplayContract = (input: {
  requirements: readonly CountryDisplayRequirement[];
  templateVersionId: string;
}): { contract: DisplayContract } | { refusal: DisplayCompositionRefusal } => {
  const prefixes = [
    ...new Set(
      input.requirements
        .map((requirement) => requirement.subjectPrefix)
        .filter((prefix): prefix is string => prefix !== null && prefix.length > 0)
    ),
  ].sort(byString);
  if (prefixes.length > 1) {
    return {
      refusal: {
        reason: "conflicting_subject_prefix",
        detail:
          `Two candidate countries require different subject prefixes (${prefixes.join(", ")}), ` +
          "and a subject has one front. Sending with one of them would record both as satisfied.",
      },
    };
  }

  const slas = input.requirements.map((requirement) => requirement.unsubscribeSlaBusinessDays);

  return {
    contract: {
      profileKeys: [
        ...new Set(input.requirements.map((requirement) => requirement.profileKey)),
      ].sort(byString),
      ruleVersions: input.requirements
        .map(({ ruleKey, ruleVersion }) => ({ ruleKey, ruleVersion }))
        .sort((a, b) => byString(a.ruleKey, b.ruleKey) || a.ruleVersion - b.ruleVersion),
      displayObligations: input.requirements
        .flatMap((requirement) =>
          requirement.displayObligations.map((duty) => ({
            countryCode: requirement.countryCode,
            obligationKey: duty.obligationKey,
            state: duty.state,
            waiverApprovalId: duty.waiverApprovalId,
          }))
        )
        .sort(
          (a, b) =>
            byString(a.countryCode, b.countryCode) || byString(a.obligationKey, b.obligationKey)
        ),
      waiverApprovalIds: [
        ...new Set(
          input.requirements.flatMap((requirement) =>
            requirement.displayObligations
              .map((duty) => duty.waiverApprovalId)
              .filter((id): id is string => id !== null)
          )
        ),
      ].sort(byString),
      subjectPrefix: prefixes[0] ?? null,
      footerBlocks: [
        ...new Set(input.requirements.flatMap((requirement) => [...requirement.footerBlocks])),
      ].sort(byString),
      // The shortest deadline any candidate allows, because a message that meets
      // the longest does not meet the shortest. Null with no candidate at all.
      unsubscribeSlaBusinessDays: slas.length === 0 ? null : Math.min(...slas),
      unsubscribeLanguages: [
        ...new Set(input.requirements.flatMap((requirement) => [...requirement.unsubscribeLanguages])),
      ].sort(byString),
      templateVersionId: input.templateVersionId,
    },
  };
};

/**
 * Canonical JSON: object keys sorted at every depth, arrays left in their order.
 *
 * The arrays are sorted where they are built, so their order is part of the
 * contract rather than an accident of the query -- a hash that changed with the
 * order rows came back in would report `display_contract_changed` for two
 * identical contracts, and the remedy for that blocker is to re-enqueue.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => byString(a, b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
};

/** The hash pinned on the delivery and recomputed at send. */
export const displayContractHash = (contract: DisplayContract): string =>
  createHash("sha256").update(canonicalJson(contract)).digest("hex");

/**
 * The provider idempotency key, which section 7.6 fixes exactly.
 *
 * `rootDeliveryId:g<generation>:<first 16 of the hash>`. Deterministic, so a
 * crash between submitting and recording does not produce a second message, and
 * inside the provider's 256-character limit. The generation is in it because a
 * re-enqueued replacement is a different message with the same root.
 */
export const displayIdempotencyKey = (input: {
  rootDeliveryId: string;
  generation: number;
  displayContractHash: string;
}): string =>
  `${input.rootDeliveryId}:g${input.generation}:${input.displayContractHash.slice(0, 16)}`;
