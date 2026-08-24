/**
 * What a campaign may do next, and whether what was approved is still what
 * would be sent.
 *
 * Contract: docs/policy/email-notifications.md §12.3,
 * .github/audits/model-lifecycle-email-2026-08-22.md §12.2, EM-01, EM-06.
 *
 * ## Why the content check exists (EM-06)
 *
 * A copy change mints a new `TemplateVersion` automatically, on the next send,
 * with nobody approving it. For transactional mail that is fine -- the change
 * went through code review. For a campaign it means an approval quietly comes
 * to cover text nobody approved, which is precisely what §12.3's `payloadHash`
 * rule exists to prevent.
 *
 * So approval pins a version per language, and the send compares the pinned
 * version's content hash against what the template would render now. Different
 * means refused, not re-approved: the point of an approval is that a person
 * saw the words.
 */

export const CAMPAIGN_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "running",
  "completed",
  "cancelled",
  "halted",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_CATEGORIES = [
  "model_launch",
  "model_upgrade",
  "model_retirement",
  "model_migration",
  "model_incident",
  "other",
] as const;
export type CampaignCategory = (typeof CAMPAIGN_CATEGORIES)[number];

export const WAVE_KINDS = [
  "launch",
  "notice",
  "reminder",
  "final_reminder",
  "completion",
] as const;
export type WaveKind = (typeof WAVE_KINDS)[number];

export const WAVE_STATUSES = [
  "pending",
  "expanding",
  "expanded",
  "sending",
  "done",
  "cancelled",
  "halted",
] as const;
export type WaveStatus = (typeof WAVE_STATUSES)[number];

/** Statuses from which a campaign may still start or continue a wave. */
const RUNNABLE: readonly CampaignStatus[] = ["approved", "running"];

export type CampaignRunRefusal =
  | "not_approved"
  | "cancelled"
  | "halted"
  | "already_completed"
  | "content_changed"
  | "locale_not_pinned"
  | "transition_unproven";

/** One language's pinned version and what that version's copy hashed to. */
export type PinnedVersion = {
  language: string;
  templateVersionId: string;
  contentHash: string;
};

export type CampaignRunRefusalDetail = {
  refusal: CampaignRunRefusal;
  /** Which languages caused it, for the two content refusals. */
  languages?: string[];
  message: string;
};

/**
 * Whether this campaign may send, given its state and its pinned copy.
 *
 * `currentHashes` is what the template renders to right now, per language. The
 * caller reads it; comparing is done here so the rule is testable without a
 * template registry.
 */
export const campaignRunRefusal = (input: {
  status: string;
  locales: readonly string[];
  pinned: readonly PinnedVersion[];
  currentHashes: Readonly<Record<string, string>>;
  /**
   * Whether this campaign's copy promises an automatic transition, and which of
   * section 13.3's twelve conditions are not met.
   *
   * Checked at send rather than only at approval because the facts move: a
   * replacement can be disabled, an owner can leave, and a copy edit takes the
   * `differences_stated` attestation with it. A gate asked once is a gate that
   * was true once.
   */
  transitionClaim?: { claimed: boolean; unmet: readonly string[] };
}): CampaignRunRefusalDetail | null => {
  if (input.status === "cancelled") {
    return { refusal: "cancelled", message: "This campaign was cancelled." };
  }
  if (input.status === "halted") {
    return {
      refusal: "halted",
      message: "This campaign was halted and has not been resumed.",
    };
  }
  if (input.status === "completed") {
    return {
      refusal: "already_completed",
      message: "This campaign has already finished sending.",
    };
  }
  if (!RUNNABLE.includes(input.status as CampaignStatus)) {
    return {
      refusal: "not_approved",
      message: `A campaign sends only once approved; this one is ${input.status}.`,
    };
  }

  if (
    input.transitionClaim?.claimed &&
    input.transitionClaim.unmet.length > 0
  ) {
    // Refused, not downgraded. Quietly sending the weaker sentence would be the
    // safe words with nobody having decided to use them, and the operator would
    // never learn that the promise they wrote was not made.
    return {
      refusal: "transition_unproven",
      languages: [...input.transitionClaim.unmet],
      message: `This campaign promises an automatic transition and ${input.transitionClaim.unmet.length} of the twelve conditions for that promise are unmet: ${input.transitionClaim.unmet.join(", ")}. Meet them, or turn the promise off and say the model is going away instead.`,
    };
  }

  const byLanguage = new Map(input.pinned.map((entry) => [entry.language, entry]));

  // Every language the campaign claims to send in needs a pin. A locale added
  // after approval would otherwise send unapproved copy while the languages
  // that were approved look fine.
  const unpinned = input.locales.filter((language) => !byLanguage.has(language));
  if (unpinned.length > 0) {
    return {
      refusal: "locale_not_pinned",
      languages: unpinned,
      message: `No approved copy is pinned for ${unpinned.join(", ")}. A locale added after approval sends text nobody approved.`,
    };
  }

  const changed = input.locales.filter((language) => {
    const pinned = byLanguage.get(language);
    const current = input.currentHashes[language];
    // An absent current hash means the template no longer renders that
    // language at all, which is a change in the direction that matters most.
    return !pinned || current === undefined || current !== pinned.contentHash;
  });
  if (changed.length > 0) {
    return {
      refusal: "content_changed",
      languages: changed,
      message: `The copy for ${changed.join(", ")} has changed since it was approved. Approve the new text rather than sending the old approval over it.`,
    };
  }

  return null;
};

/**
 * Reads the stored pin map, dropping anything it cannot use.
 *
 * A half-readable pin is treated as no pin for that language, which the refusal
 * above then reports as `locale_not_pinned`. Silently sending an unpinned
 * locale is the one outcome this must never produce.
 */
export const readPinnedVersions = (raw: unknown): PinnedVersion[] => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: PinnedVersion[] = [];
  for (const [language, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.templateVersionId !== "string" ||
      typeof entry.contentHash !== "string"
    ) {
      continue;
    }
    out.push({
      language,
      templateVersionId: entry.templateVersionId,
      contentHash: entry.contentHash,
    });
  }
  return out;
};

export const writePinnedVersions = (pinned: readonly PinnedVersion[]) =>
  Object.fromEntries(
    pinned.map((entry) => [
      entry.language,
      {
        templateVersionId: entry.templateVersionId,
        contentHash: entry.contentHash,
      },
    ])
  );

/** Locales, read defensively: an empty list is a campaign that sends nothing. */
export const readLocales = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === "string")
    : [];
