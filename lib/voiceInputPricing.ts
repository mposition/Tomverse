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
 * Four numbers rather than the pricing table's three, because on the input
 * side the published rate and the rate this account is actually charged are
 * not the same number, and the register has to hold both
 * (docs/policy/voice-input.md §6.1.3).
 */
export type VoiceModelListPrice = {
  /**
   * USD per 1M audio input tokens as **this account is actually charged**,
   * derived from an invoice rather than from the pricing page.
   *
   * ## Why this is not the published number
   *
   * On both models observed so far, the charge divided by the audio tokens
   * the API itself reported comes to exactly **2.4x** the published audio
   * input price:
   *
   * | model | published | effective | output (published = observed) |
   * |---|---|---|---|
   * | `gpt-4o-mini-transcribe` | US$1.25/1M | US$3.00/1M | US$5.00/1M |
   * | `gpt-4o-transcribe` | US$2.50/1M | US$6.00/1M | US$10.00/1M |
   *
   * Output matches the published price exactly on both. Only the input side
   * diverges, by the same factor, on two independently measured models.
   *
   * ## It is a price difference, not a counting difference
   *
   * The obvious alternative was that the provider bills a different number of
   * units than the response reports -- 228 units at the published US$2.50/1M
   * reaches the same US$0.00057 as 95 at US$6.00/1M, and nothing about the
   * amount alone separates those. The Costs API answers it directly: with
   * `group_by=line_item` each result carries `quantity` and `quantity_unit`,
   * and on both observations the billed quantity is **exactly the token count
   * the response reported**, in `tokens` (95 and 352). Recorded per
   * observation as `billedAudioInputQuantity`, so the question does not have
   * to be re-argued from the amount.
   *
   * So the same unit is billed at 2.4x the published price. **Why is still
   * unestablished** -- an account- or snapshot-specific rate, a provider
   * documentation error and a billing error all remain open, and one of the
   * two line items even names a dated snapshot
   * (`gpt-4o-mini-transcribe-2025-12-15`) where the other names the bare
   * model. This field therefore records the rate this account is charged --
   * the conservative one, and the only one that reproduces a real invoice --
   * and `publishedAudioInputPerMillionTokensUsd` records what the page says,
   * so the gap stays visible instead of being resolved by whichever number
   * was written down first.
   *
   * `null` means no invoice has shown it: **unknown**, which is not the same
   * as the published price. A model whose effective rate is unknown cannot
   * have its cost stated, and the audit says so rather than substituting the
   * number that happens to be printed.
   */
  audioInputPerMillionTokensUsd: number | null;
  /**
   * USD per 1M audio input tokens **as the provider's page publishes it**.
   *
   * Kept beside the effective rate rather than replaced by it. The two have
   * disagreed by 2.4x on every model measured, and a register that held only
   * one of them could not show that -- it would read as either "the page is
   * right" or "the page does not matter", and neither is established.
   *
   * This field was called `textInputPerMillionTokensUsd` until 2026-09-10, on
   * the belief that the published `Input` column was a text rate that
   * transcription never pays. The provider's model pages label it
   * "Audio tokens - Input" and publish no text row at all, so that reading was
   * wrong; the discrepancy it was invented to explain is real, is a price
   * difference on an identically counted unit, and remains unexplained.
   */
  publishedAudioInputPerMillionTokensUsd: number;
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
   * The quantity the provider actually billed on the audio input line, and
   * the unit it billed in, from the same bucket as `totalUsd`.
   *
   * Recorded because what the response reports and what the invoice charges
   * for are different facts, and an amount alone cannot tell them apart: a
   * charge is a rate times a quantity, so half the equation is missing until
   * the quantity is written down. Both readings so far agree with the
   * response exactly, which is what makes "US$6.00 per million *tokens*" a
   * statement about a rate rather than about a counting convention. If a
   * future reading disagrees, `audioInputPerMillionTokensUsd` stops meaning
   * per response token and has to be renamed for the unit it is really per;
   * `auditVoicePriceRegister` reports the divergence rather than absorbing
   * it.
   */
  billedAudioInputQuantity: number;
  /** The quantity billed on the output line, same bucket. */
  billedOutputQuantity: number;
  /**
   * `quantity_unit` as the provider reported it, per line item.
   *
   * Two fields rather than one because the provider reports it per line item
   * -- a single field would assert about the output line something only the
   * input line was read for, which is the shape of claim this register exists
   * to avoid making. Both are `tokens` on both observations so far, so the
   * split changes no recorded fact; it stops one reading from standing in for
   * a measurement nobody took.
   *
   * A per-million-token rate cannot be reconciled against any other unit, and
   * the audit refuses rather than guessing a conversion.
   */
  billedAudioInputQuantityUnit: string;
  /** `quantity_unit` on the output line. See the field above. */
  billedOutputQuantityUnit: string;
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
      // What the invoice charges per audio token: 2.4x the published
      // US$1.25 below, on a quantity the provider counted exactly as the
      // response did. A price difference, for a reason nobody has
      // established. See the field's comment.
      audioInputPerMillionTokensUsd: 3.0,
      publishedAudioInputPerMillionTokensUsd: 1.25,
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
      billedAudioInputQuantity: 352,
      billedOutputQuantity: 112,
      billedAudioInputQuantityUnit: "tokens",
      billedOutputQuantityUnit: "tokens",
      isolation:
        "num_model_requests was 3 for this model that day -- exactly the three " +
        "calls -- and the aggregate token counts equal the per-request counts " +
        "recorded in #1247 (352/112), which extra traffic could not net to. " +
        "Across 30 days a transcribe line item appears on 2026-09-02 only. " +
        // Digests, not the identifiers. Whoever holds the operations record can
        // confirm these name the key and project the calls were made on;
        // nobody else learns which account this is. See the policy note in
        // §6.1.3-4 for why an isolation string does not carry them in full.
        "Key sha256:67ad26189fa0, project sha256:35539b590847 (originals in " +
        "the private operations record).",
      source:
        "GET /organization/costs, bucket_width=1d, group_by=line_item, " +
        "bucket 2026-09-02: audio input 0.001056 + text input 0.0 + text " +
        "output 0.00056 USD, with quantity 352 / 0 / 112 and quantity_unit " +
        "`tokens` on all three lines. Read 2026-09-08; quantities re-read " +
        "2026-09-10 from the same bucket, no new request.",
    },
  },
  {
    modelId: "gpt-4o-transcribe",
    price: {
      // What the invoice charges per audio token, and neither number a guess
      // would have picked was right. The published audio input price is
      // US$2.50; the mini model's observed US$3.00 was the other tempting
      // answer. The charge came to US$6.00/1M over 95 billed tokens -- the
      // same 95 the response reported, so 2.4x the published price on an
      // identically counted unit, the same factor the mini model shows, and
      // unexplained on both.
      audioInputPerMillionTokensUsd: 6.0,
      publishedAudioInputPerMillionTokensUsd: 2.5,
      outputPerMillionTokensUsd: 10.0,
      estimatedCostPerMinuteUsd: 0.006,
    },
    verifiedAt: "2026-09-02",
    owner: "@mposition",
    ticket: "#1247",
    reverifyBy: "2026-12-01",
    costObservation: {
      billedOn: "2026-09-09",
      totalUsd: 0.00083,
      requests: 1,
      audioInputTokens: 95,
      outputTokens: 26,
      billedAudioInputQuantity: 95,
      billedOutputQuantity: 26,
      billedAudioInputQuantityUnit: "tokens",
      billedOutputQuantityUnit: "tokens",
      isolation:
        "One approved call, and the aggregates agree it was one: " +
        "num_model_requests was 1 for this model that day, with 95 input and " +
        "26 output tokens -- the exact counts the response itself reported " +
        "(request req_9101ef5cfb4544d2be264e08513ed92f). No other traffic on " +
        "this model exists in the window, so no netting is possible. " +
        // Digests, not the identifiers, for the same reason as the entry
        // above: whoever holds the operations record can confirm which
        // credential this was; nobody else learns the account. Written as a
        // fingerprint rather than as a key-prefixed digest, because the
        // secret scanner reads that phrasing as a generic API key and fails
        // the gate on a string that is deliberately not one.
        "Credential fingerprint (SHA-256 prefix): 1c9f4b0e7a63, original in " +
        "the private operations record. The dedicated " +
        "VOICE_TRANSCRIPTION_API_KEY does not exist yet, which is B-5's " +
        "subject and is not answered by this reading.",
      source:
        "GET /organization/costs, bucket_width=1d, group_by=line_item, " +
        "bucket 2026-09-09: audio input 0.00057 + text input 0.0 + text " +
        "output 0.00026 USD, with quantity 95 / 0 / 26 and quantity_unit " +
        "`tokens` on all three lines. Read 2026-09-10. It is absent from the console's " +
        "own view because US$0.00083 rounds to US$0.00 at the two decimals it " +
        "displays -- the API carries the full precision and the console does " +
        "not.",
    },
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
    | "observation_does_not_reconcile"
    // The provider billed a unit the recorded rates are not per. Both say the
    // register's *names* are wrong, which is why they are not folded into
    // `observation_does_not_reconcile` -- that code means the arithmetic does
    // not close, and here it may close perfectly while meaning something else.
    | "billed_unit_is_not_tokens"
    | "billing_basis_diverged";
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
/**
 * How far ahead of a deadline the register starts saying so.
 *
 * Separate from `VOICE_PRICE_REVERIFY_MAX_DAYS`, which bounds how long a
 * reading may claim to be current. This one bounds how long somebody has to
 * act before it stops being current, and the two answer different questions.
 */
export const VOICE_PRICE_REVERIFY_WARNING_WINDOW_DAYS = 30;

/**
 * The days-remaining marks a notice is sent at.
 *
 * Descending, and read from the tight end: the mark a deadline is *at* is the
 * smallest one it has already reached, so 14 days out is the 14-day mark and
 * not the 30-day one it also satisfies.
 *
 * Missing a day therefore does not skip a notice -- every later day inside the
 * same span resolves to the same mark, and the sender's own de-duplication
 * decides whether it has already gone out.
 */
export const VOICE_PRICE_REVERIFY_NOTICE_DAYS = [30, 14, 7] as const;

export type VoicePriceReverificationNotice = {
  modelId: string;
  owner: string;
  ticket: string;
  reverifyBy: string;
  /** Whole days from today (UTC) to the deadline. */
  daysRemaining: number;
  /** The tightest mark in `VOICE_PRICE_REVERIFY_NOTICE_DAYS` this has reached. */
  thresholdDays: number;
};

/**
 * Deadlines close enough to warn about, and how close.
 *
 * Deliberately NOT part of `auditVoicePriceRegister`. That function answers
 * "may this build ship", and everything it returns fails the PR gate; a
 * warning folded into it would either fail the gate a month early or teach
 * the gate to ignore some of its own findings. Keeping them apart makes
 * "a warning cannot block" structural rather than a rule somebody has to
 * remember.
 *
 * The deadline day and anything past it are not here. Those are the audit's
 * `expired` problem, which blocks -- and a check that reported the same fact
 * twice, once as a warning, would be describing a failure as a heads-up. The
 * window is 30 days out to the day before, and stops there.
 *
 * Days are whole UTC days from the start of today, so a daily run sees each
 * mark exactly once and the answer does not depend on the hour it runs at.
 */
export const voicePriceReverificationNotices = (input: {
  modelIds: readonly string[];
  now: Date;
  register?: readonly VoiceModelPriceEntry[];
}): VoicePriceReverificationNotice[] => {
  const register = input.register ?? VOICE_MODEL_PRICE_REGISTER;
  const today = Date.UTC(
    input.now.getUTCFullYear(),
    input.now.getUTCMonth(),
    input.now.getUTCDate()
  );
  const notices: VoicePriceReverificationNotice[] = [];
  for (const modelId of input.modelIds) {
    const entry = register.find((candidate) => candidate.modelId === modelId);
    if (!entry) continue;
    const reverifyBy = parseDay(entry.reverifyBy);
    if (reverifyBy === null) continue;
    const daysRemaining = Math.floor((reverifyBy - today) / dayMs);
    // The deadline day itself is the audit's, not this function's. `< 0` let
    // it through, so on 2026-12-01 both layers would have spoken at once --
    // `expired` failing the gate while a notice called the same fact a
    // heads-up. The warning window ends the day before the deadline, which is
    // what the table in docs/policy/voice-input.md §6.1.5 says it does.
    if (daysRemaining <= 0) continue;
    if (daysRemaining > VOICE_PRICE_REVERIFY_WARNING_WINDOW_DAYS) continue;
    // The last match, not the first: the marks descend, and every mark wider
    // than the deadline's distance also satisfies the comparison. Taking the
    // first one reported 14 days out as the 30-day mark, which would have
    // suppressed the 14- and 7-day notices entirely -- the thread already
    // carried a 30-day marker.
    const reached = VOICE_PRICE_REVERIFY_NOTICE_DAYS.filter(
      (mark) => daysRemaining <= mark
    );
    const thresholdDays = reached.at(-1);
    if (thresholdDays === undefined) continue;
    notices.push({
      modelId: entry.modelId,
      owner: entry.owner,
      ticket: entry.ticket,
      reverifyBy: entry.reverifyBy,
      daysRemaining,
      thresholdDays,
    });
  }
  return notices;
};

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
          "no invoice has shown what this account is charged for audio " +
          "input on this model, so what a transcription costs here is " +
          "unknown. The published audio input price is not a substitute: on " +
          "both models where an invoice has been read, the charge came to " +
          "2.4x it (docs/policy/voice-input.md §6.1.3)",
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
      } else if (
        observation.billedAudioInputQuantityUnit !== "tokens" ||
        observation.billedOutputQuantityUnit !== "tokens"
      ) {
        // A per-million-token rate has nothing to say about a charge billed
        // in seconds or characters. Converting here would invent the very
        // relationship the register exists to record having measured. Both
        // lines are checked because the provider reports the unit per line
        // item: an output line billed in seconds is as unreconcilable as an
        // input line, and checking one would let the other through.
        const offending = [
          observation.billedAudioInputQuantityUnit !== "tokens"
            ? `audio input in \`${observation.billedAudioInputQuantityUnit}\``
            : null,
          observation.billedOutputQuantityUnit !== "tokens"
            ? `output in \`${observation.billedOutputQuantityUnit}\``
            : null,
        ].filter((line) => line !== null);
        problems.push({
          modelId,
          code: "billed_unit_is_not_tokens",
          detail:
            `the charge was billed ${offending.join(" and ")}, which a ` +
            "per-million-token rate cannot be reconciled against; the rate " +
            "fields have to be renamed for the unit actually billed",
        });
      } else {
        // Reconcile against what the provider billed for, not against what
        // the response said it used. They have been equal on every reading
        // so far, and that equality is the reason these rates can be stated
        // per token at all -- but it is an observation, so the arithmetic
        // uses the billed quantity and the divergence is reported below
        // rather than being hidden by using the response count for both.
        const implied =
          (observation.billedAudioInputQuantity * audioRate) / 1_000_000 +
          (observation.billedOutputQuantity *
            entry.price.outputPerMillionTokensUsd) /
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
              `${observation.billedAudioInputQuantity} billed audio input and ` +
              `${observation.billedOutputQuantity} billed output tokens, but ` +
              `the observation records a charge of ` +
              `US$${observation.totalUsd.toFixed(6)} on ${observation.billedOn}`,
          });
        }

        // The rate fields are named "per million tokens" and the register
        // quotes them against token counts taken from responses. That is only
        // meaningful while the provider bills the same count. When it stops,
        // the name is wrong before the number is, and saying so is the point
        // of recording the billed quantity at all.
        //
        // Both sides are checked. Checking only the input line would pass an
        // observation whose output quantity diverged while its arithmetic
        // still closed -- the charge reconciles against the billed quantity
        // by construction, so a closing sum is no evidence the two bases
        // agree, and `outputPerMillionTokensUsd` would go on claiming to be
        // per response token with nothing left to contradict it.
        const divergences = [
          observation.billedAudioInputQuantity !== observation.audioInputTokens
            ? `${observation.audioInputTokens} audio input tokens but the ` +
              `provider billed for ${observation.billedAudioInputQuantity}`
            : null,
          observation.billedOutputQuantity !== observation.outputTokens
            ? `${observation.outputTokens} output tokens but the provider ` +
              `billed for ${observation.billedOutputQuantity}`
            : null,
        ].filter((line) => line !== null);
        if (divergences.length > 0) {
          problems.push({
            modelId,
            code: "billing_basis_diverged",
            detail:
              `the responses reported ${divergences.join(", and ")}, so the ` +
              "rate fields are no longer rates per response token and have " +
              "to be renamed for the unit they are per " +
              "(docs/policy/voice-input.md §6.1.3)",
          });
        }
      }
    }
  }
  return problems;
};
