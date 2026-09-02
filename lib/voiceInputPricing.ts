/**
 * What an audio second costs *us*, and who is accountable for that number
 * still being true.
 *
 * Contract: docs/policy/voice-input.md §6.1-3.
 *
 * ## Why this is not `PENDING_VERIFIED_PRICE_REGISTER`
 *
 * That register is the text models' layer, and audio is a third one for the
 * same reason images are a second: the unit differs. A text model is priced
 * per token and its price is knowable before the call; an audio model this
 * product uses is priced per token *after* the fact, with a per-minute figure
 * the provider itself labels an estimate. Sharing one register would mean one
 * expiry rule and one owner for two questions that are answered by different
 * evidence.
 *
 * ## What an entry claims, and what it does not
 *
 * An entry says: this model's list price was read from the provider's own
 * pricing page on `verifiedAt`, by `owner`, under `ticket`, and somebody has
 * to look again by `reverifyBy`. It does **not** claim the price was observed
 * on an invoice -- that is `costObserved`, and it is false until the paid
 * verification in §6.1.2 has actually run. A register that could not tell
 * those apart would let a list price stand in for a measurement.
 *
 * ## Why the deadline is enforced rather than advisory
 *
 * A price nobody has re-read is a price that used to be true. The check turns
 * from warning to failure at `reverifyBy` so the register cannot quietly
 * become a record of what was true a year ago.
 */

/** The register's unit. Audio prices are quoted two ways; both are recorded. */
export type VoiceModelListPrice = {
  /** USD per 1M input tokens, as the provider's pricing table states it. */
  inputPerMillionTokensUsd: number;
  /** USD per 1M output tokens. */
  outputPerMillionTokensUsd: number;
  /**
   * The provider's own per-minute figure.
   *
   * Recorded under the name the pricing table gives it -- "Estimated cost" --
   * and never promoted to a list price. The table does not state how it
   * relates to the token prices, so neither does this field's name.
   */
  estimatedCostPerMinuteUsd: number;
};

export type VoiceModelPriceEntry = {
  modelId: string;
  price: VoiceModelListPrice;
  /** The date the price above was read from the provider's pricing page. */
  verifiedAt: string;
  /** Who read it and is accountable for it. A person, never automation. */
  owner: string;
  /**
   * Where the reading and any re-reading is tracked.
   *
   * A real reference, not a string that looks like one: an invented ticket id
   * creates the appearance of traceability and none of the substance, because
   * nobody can open it to find out what was done. `#<issue number>` in this
   * repository, or a full URL.
   */
  ticket: string;
  /** After this date the check fails rather than warns. At most 90 days out. */
  reverifyBy: string;
  /**
   * Whether the price has been checked against a real invoice.
   *
   * False means only the published list price is known. The paid verification
   * that would make it true needs its own approval (§6.1.2), so this field is
   * the register's own record of the difference between "we read it" and "we
   * were charged it".
   */
  costObserved: boolean;
};

/** At most this many days between a reading and its deadline. */
export const VOICE_PRICE_REVERIFY_MAX_DAYS = 90;

/**
 * Every transcription model this deployment may use.
 *
 * Read from developers.openai.com `/api/docs/pricing` on 2026-09-02. The
 * per-minute column is headed "Estimated cost" there, which is why the field
 * is named for the estimate rather than for a rate.
 */
export const VOICE_MODEL_PRICE_REGISTER: readonly VoiceModelPriceEntry[] = [
  {
    modelId: "gpt-4o-mini-transcribe",
    price: {
      inputPerMillionTokensUsd: 1.25,
      outputPerMillionTokensUsd: 5.0,
      estimatedCostPerMinuteUsd: 0.003,
    },
    verifiedAt: "2026-09-02",
    owner: "@mposition",
    ticket: "#1247",
    reverifyBy: "2026-12-01",
    costObserved: false,
  },
  {
    modelId: "gpt-4o-transcribe",
    price: {
      inputPerMillionTokensUsd: 2.5,
      outputPerMillionTokensUsd: 10.0,
      estimatedCostPerMinuteUsd: 0.006,
    },
    verifiedAt: "2026-09-02",
    owner: "@mposition",
    ticket: "#1247",
    reverifyBy: "2026-12-01",
    costObserved: false,
  },
];

export type VoicePriceRegisterProblem = {
  modelId: string;
  code:
    | "missing_entry"
    | "expired"
    | "reverify_window_too_long"
    | "owner_missing"
    | "ticket_missing";
  detail: string;
};

const dayMs = 24 * 60 * 60 * 1000;

const parseDay = (value: string) => {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Audits the register against the models a deployment can actually reach.
 *
 * `now` is injected rather than read, so the expiry rule is testable without
 * waiting three months for it to be true.
 */
export const auditVoicePriceRegister = (input: {
  modelIds: readonly string[];
  now: Date;
}): VoicePriceRegisterProblem[] => {
  const problems: VoicePriceRegisterProblem[] = [];
  for (const modelId of input.modelIds) {
    const entry = VOICE_MODEL_PRICE_REGISTER.find(
      (candidate) => candidate.modelId === modelId
    );
    if (!entry) {
      problems.push({
        modelId,
        code: "missing_entry",
        detail:
          "a transcription model this deployment can reach has no recorded price",
      });
      continue;
    }
    if (!entry.owner.trim()) {
      problems.push({
        modelId,
        code: "owner_missing",
        detail: "a price with no owner is a price nobody has to re-read",
      });
    }
    // Shape, not existence: this cannot open GitHub. What it can refuse is a
    // free-form label that resembles a ticket without being one, which is how
    // the register nearly shipped -- `VOICE-PRICE-001` named nothing.
    if (!/^(#\d+|https?:\/\/\S+)$/.test(entry.ticket.trim())) {
      problems.push({
        modelId,
        code: "ticket_missing",
        detail:
          "the ticket must be a reference somebody can open: #<issue number> or a URL",
      });
    }
    const verifiedAt = parseDay(entry.verifiedAt);
    const reverifyBy = parseDay(entry.reverifyBy);
    if (verifiedAt === null || reverifyBy === null) {
      problems.push({
        modelId,
        code: "expired",
        detail: "verifiedAt or reverifyBy is not a YYYY-MM-DD date",
      });
      continue;
    }
    if (reverifyBy - verifiedAt > VOICE_PRICE_REVERIFY_MAX_DAYS * dayMs) {
      problems.push({
        modelId,
        code: "reverify_window_too_long",
        detail: `more than ${VOICE_PRICE_REVERIFY_MAX_DAYS} days between the reading and its deadline`,
      });
    }
    if (input.now.getTime() > reverifyBy) {
      problems.push({
        modelId,
        code: "expired",
        detail: `the price was last read on ${entry.verifiedAt} and was due for re-reading by ${entry.reverifyBy}`,
      });
    }
  }
  return problems;
};
