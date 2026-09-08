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
 * on an invoice -- that is `costObservation`, and it is `null` until the paid
 * verification in §6.1.2 has actually run. A register that could not tell
 * those apart would let a list price stand in for a measurement.
 *
 * ## What the list price turned out not to answer
 *
 * On 2026-09-08 the first invoice was read (§6.1.3) and the published `Input`
 * column was the wrong number: it is the *text* rate, while a transcription's
 * only input is audio, billed higher and not published at all. So the two
 * input rates are separate fields here, and the audio one is nullable --
 * "unknown" is a state this register has to be able to hold, because for one
 * of the two models it is the true one.
 *
 * ## Why the deadline is enforced rather than advisory
 *
 * A price nobody has re-read is a price that used to be true. The check turns
 * from warning to failure at `reverifyBy` so the register cannot quietly
 * become a record of what was true a year ago.
 */

/**
 * The register's unit.
 *
 * Four numbers rather than the pricing table's three, because the table's
 * `Input` column turned out to be two different rates wearing one heading
 * (docs/policy/voice-input.md §6.1.3).
 */
export type VoiceModelListPrice = {
  /**
   * USD per 1M *audio* input tokens -- the rate a transcription actually pays.
   *
   * This is a separate field from the text rate because the provider bills
   * them separately and publishes only one of them. The pricing table's
   * `Input` column is the *text* rate; a transcription's only input is audio,
   * and on 2026-09-08 the invoice showed it billed at US$3.00/1M for
   * `gpt-4o-mini-transcribe` against a published `Input` of US$1.25/1M
   * (docs/policy/voice-input.md §6.1.3). Reading the published column
   * correctly still under-costs transcription by 2.4x on the input side.
   *
   * `null` where no invoice has shown it and the provider publishes no audio
   * rate: **unknown**, which is neither zero nor the text rate. A model whose
   * audio rate is unknown cannot have its cost stated, and the audit says so
   * rather than substituting the number that happens to be printed.
   */
  audioInputPerMillionTokensUsd: number | null;
  /**
   * USD per 1M *text* input tokens -- the pricing table's `Input` column.
   *
   * Recorded because it is what the page says, and kept away from the audio
   * rate so that nothing can quietly cost audio with it again.
   */
  textInputPerMillionTokensUsd: number;
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
   * The invoice this entry's rates were checked against, or `null`.
   *
   * `null` means only the published list price is known. The paid
   * verification that fills this in needs its own approval (§6.1.2), so this
   * field is the register's record of the difference between "we read it" and
   * "we were charged it".
   *
   * ## Why this is evidence and not a boolean
   *
   * It used to be `costObserved: boolean`, and a boolean is one keystroke
   * away from claiming work that nobody did -- the failure this register was
   * built to prevent, reintroduced by the field meant to record its absence.
   * An observation cannot be asserted without writing down the charge and the
   * tokens it covers, and `auditVoicePriceRegister` recomputes the rates from
   * those numbers. Correcting a rate without a fresh observation fails the
   * audit instead of passing quietly.
   */
  costObservation: VoiceCostObservation | null;
};

/**
 * A charge the provider actually made, and what it covers.
 *
 * Deliberately narrow: it records one daily cost bucket for one model, on the
 * only terms under which a bucket can be attributed at all. The Costs API
 * buckets by day over project, line item and key (§6.1.1), so a charge is
 * never per-request and `isolation` has to say how these requests were
 * separated from everything else the account did.
 */
export type VoiceCostObservation = {
  /** UTC day whose cost bucket carries the charge, `YYYY-MM-DD`. */
  billedOn: string;
  /** What the provider charged, USD, for exactly the requests below. */
  totalUsd: number;
  /** How many requests that charge covers. */
  requests: number;
  /** Audio input tokens those requests reported. */
  audioInputTokens: number;
  /** Output tokens those requests reported. */
  outputTokens: number;
  /**
   * How the charge was separated from the account's other traffic.
   *
   * Prose, because the reader has to judge it: an aggregate compared against
   * an aggregate is only evidence if nothing else landed in the same bucket,
   * and no field can assert that on the reader's behalf.
   */
  isolation: string;
  /** Where the figures were read, precisely enough to read them again. */
  source: string;
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
      // Observed on the invoice, not published. See the field's comment.
      audioInputPerMillionTokensUsd: 3.0,
      textInputPerMillionTokensUsd: 1.25,
      outputPerMillionTokensUsd: 5.0,
      estimatedCostPerMinuteUsd: 0.003,
    },
    verifiedAt: "2026-09-02",
    owner: "@mposition",
    ticket: "#1247",
    reverifyBy: "2026-12-01",
    costObservation: {
      billedOn: "2026-09-02",
      totalUsd: 0.001616,
      requests: 3,
      audioInputTokens: 352,
      outputTokens: 112,
      isolation:
        "num_model_requests was 3 for this model that day -- exactly the three " +
        "calls -- and the aggregate token counts equal the per-request counts " +
        "recorded in #1247 (352/112), which extra traffic could not net to. " +
        "Across 30 days a transcribe line item appears on 2026-09-02 only. " +
        "Key key_X8plaVKnXzfMjbCA, project proj_gvGv5Ftkw4UtzUh45jpfHMWY.",
      source:
        "GET /organization/costs, bucket_width=1d, group_by=line_item, " +
        "bucket 2026-09-02: audio input 0.001056 + text input 0.0 + text " +
        "output 0.00056 USD. Read 2026-09-08.",
    },
  },
  {
    modelId: "gpt-4o-transcribe",
    price: {
      // Never called, so never invoiced. The published `Input` column for this
      // model is US$2.50, and that is the *text* rate -- the same column that
      // turned out to be the wrong one for the model above. Assuming the same
      // confusion is the safe reading; deriving a number from the mini model's
      // observed US$3.00 would be arithmetic dressed as a measurement, which
      // is the thing this register exists to refuse.
      audioInputPerMillionTokensUsd: null,
      textInputPerMillionTokensUsd: 2.5,
      outputPerMillionTokensUsd: 10.0,
      estimatedCostPerMinuteUsd: 0.006,
    },
    verifiedAt: "2026-09-02",
    owner: "@mposition",
    ticket: "#1247",
    reverifyBy: "2026-12-01",
    costObservation: null,
  },
];

/**
 * Whether a deployment configured to call `modelId` knows what that costs.
 *
 * Separate from `auditVoicePriceRegister` because the two answer different
 * questions at different times. The audit asks "is this register well-formed",
 * runs in CI over every entry, and treats an expired reading as a failure. This
 * asks "may this deployment send audio to this model right now", runs against
 * one model in `/api/ready`, and deliberately ignores expiry: a stale reading
 * is a process fact, and failing readiness on a calendar date would take a
 * running production down with no deploy and no code change
 * (docs/policy/voice-input.md §6.1.4).
 *
 * `null` means the model may be called.
 */
export const voiceModelPriceRefusal = (input: {
  modelId: string;
  register?: readonly VoiceModelPriceEntry[];
}): { code: VoiceModelPriceRefusalCode; detail: string } | null => {
  const register = input.register ?? VOICE_MODEL_PRICE_REGISTER;
  const entry = register.find(
    (candidate) => candidate.modelId === input.modelId
  );

  // An unrecognised name is a refusal, not an unknown. A typo must not be a
  // route to a model whose cost nothing in this repository can state.
  if (!entry) {
    return {
      code: "model_not_in_register",
      detail:
        "the configured transcription model has no entry in the price " +
        "register, so what its calls cost is unknown",
    };
  }
  if (entry.price.audioInputPerMillionTokensUsd === null) {
    return {
      code: "audio_input_rate_unknown",
      detail:
        "the configured transcription model has no known audio input rate; " +
        "the provider publishes none and no invoice has shown one",
    };
  }
  if (entry.costObservation === null) {
    return {
      code: "cost_never_observed",
      detail:
        "the configured transcription model's price has only been read, " +
        "never seen on an invoice (docs/policy/voice-input.md §6.1-3)",
    };
  }
  return null;
};

export type VoiceModelPriceRefusalCode =
  | "model_not_in_register"
  | "audio_input_rate_unknown"
  | "cost_never_observed";

export type VoicePriceRegisterProblem = {
  modelId: string;
  code:
    | "missing_entry"
    | "expired"
    | "reverify_window_too_long"
    | "owner_missing"
    | "ticket_missing"
    | "audio_input_rate_unknown"
    | "observation_does_not_reconcile";
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
 * waiting three months for it to be true. `register` is injected for the same
 * reason: the rules that refuse a bad entry can only be shown to work against
 * a bad entry, and the real register is not allowed to contain one.
 */
export const auditVoicePriceRegister = (input: {
  modelIds: readonly string[];
  now: Date;
  register?: readonly VoiceModelPriceEntry[];
}): VoicePriceRegisterProblem[] => {
  const register = input.register ?? VOICE_MODEL_PRICE_REGISTER;
  const problems: VoicePriceRegisterProblem[] = [];
  for (const modelId of input.modelIds) {
    const entry = register.find((candidate) => candidate.modelId === modelId);
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

    const { audioInputPerMillionTokensUsd: audioRate } = entry.price;
    if (audioRate === null) {
      problems.push({
        modelId,
        code: "audio_input_rate_unknown",
        detail:
          "no audio input rate: the provider does not publish one and no " +
          "invoice has shown it, so what a transcription costs on this model " +
          "is unknown. The published `Input` column is the text rate and is " +
          "not a substitute (docs/policy/voice-input.md §6.1.3)",
      });
    }

    // An observation has to reproduce the rates recorded beside it. This is
    // what stops the rates and the evidence from drifting apart: change one
    // without the other and the arithmetic stops closing. It also means a
    // corrected rate cannot be asserted on the strength of an old invoice.
    const observation = entry.costObservation;
    if (observation) {
      if (audioRate === null) {
        problems.push({
          modelId,
          code: "observation_does_not_reconcile",
          detail:
            "an invoice is recorded but no audio input rate is, so the charge " +
            "cannot be attributed to any rate at all",
        });
      } else {
        const implied =
          (observation.audioInputTokens * audioRate) / 1_000_000 +
          (observation.outputTokens * entry.price.outputPerMillionTokensUsd) /
            1_000_000;
        // Half a micro-dollar. The recorded rates must reproduce the observed
        // charge, not merely land near it -- these are exact token counts
        // against an exact billed amount, so anything looser would let a
        // wrong rate through.
        if (Math.abs(implied - observation.totalUsd) > 5e-7) {
          problems.push({
            modelId,
            code: "observation_does_not_reconcile",
            detail:
              `the recorded rates imply US$${implied.toFixed(6)} for ` +
              `${observation.audioInputTokens} audio input and ` +
              `${observation.outputTokens} output tokens, but the observation ` +
              `records a charge of US$${observation.totalUsd.toFixed(6)} on ` +
              `${observation.billedOn}`,
          });
        }
      }
    }
  }
  return problems;
};
