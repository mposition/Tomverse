/**
 * What a server "Read aloud" costs *us*, and who has to look at that number
 * again.
 *
 * Contract: docs/policy/voice-input.md §6.4 (server read-aloud). The same rule
 * as the transcription register in lib/voiceInputPricing.ts, kept as its own
 * register because the unit differs: speech is billed per text input token and
 * per audio *output* token, transcription per audio input token.
 *
 * ## Fail-closed, in the same three steps as `voiceModelPriceRefusal`
 *
 * A model with no entry is refused (a typo must not be a route to a model
 * whose cost nothing here can state). A model whose price has only been read,
 * never seen on an invoice, is refused too: the transcription invoice came to
 * 2.4x the published audio rate on both models measured
 * (docs/policy/voice-input.md §6.1.3), and running on a list price nobody has
 * reconciled is a separate human approval (§6.1-3), not something this file
 * may decide. So until `costObservation` is filled in from one approved paid
 * check, the server voice stays off and "Read aloud" uses the browser's own.
 */

/** USD per 1M tokens, as the provider's pricing page publishes them. */
export type ReadoutModelListPrice = {
  textInputPerMillionTokensUsd: number;
  audioOutputPerMillionTokensUsd: number;
};

/**
 * A charge the provider actually made for read-aloud requests, and what it
 * covers. The same shape of evidence as `VoiceCostObservation`: an amount, the
 * billed quantities and their units, and how the requests were isolated.
 */
export type ReadoutCostObservation = {
  billedOn: string;
  totalUsd: number;
  requests: number;
  billedTextInputQuantity: number;
  billedAudioOutputQuantity: number;
  billedTextInputQuantityUnit: string;
  billedAudioOutputQuantityUnit: string;
  isolation: string;
  source: string;
};

export type ReadoutModelPriceEntry = {
  modelId: string;
  price: ReadoutModelListPrice;
  /** The most characters one request may carry, from the API reference. */
  maxInputCharacters: number;
  /** The date the figures above were read. */
  verifiedAt: string;
  /** Who did the reading. Recorded as it happened, including automation. */
  readBy: string;
  /** The person accountable for re-reading it. Never automation. */
  owner: string;
  /** The pages the figures were read from, precisely enough to read again. */
  sources: readonly string[];
  /** After this date the register check fails. At most 90 days out. */
  reverifyBy: string;
  /** `null` until an approved paid check has been reconciled against an invoice. */
  costObservation: ReadoutCostObservation | null;
};

export const READOUT_PRICE_REVERIFY_MAX_DAYS = 90;

/**
 * The speech models this deployment may call.
 *
 * Read on 2026-11-28. The provider's deprecations page lists every
 * `/v1/audio/speech` model (`tts-1`, `tts-1-hd`, `gpt-4o-mini-tts` and its
 * snapshots) as deprecated since 2026-10-01 with a shutdown on 2027-01-06, and
 * names `gpt-realtime-2.1-mini` -- a Realtime model, not a speech endpoint --
 * as the replacement. `reverifyBy` is therefore the day before the shutdown:
 * whoever re-reads it has to decide the successor, and after the shutdown the
 * provider refuses the call, which this feature already answers with the
 * browser voice.
 */
export const READOUT_MODEL_PRICE_REGISTER: readonly ReadoutModelPriceEntry[] = [
  {
    modelId: "gpt-4o-mini-tts",
    price: {
      textInputPerMillionTokensUsd: 0.6,
      audioOutputPerMillionTokensUsd: 12.0,
    },
    maxInputCharacters: 4096,
    verifiedAt: "2026-11-28",
    readBy: "coding agent session, 2026-11-28; not yet re-read by a person",
    owner: "@mposition",
    sources: [
      "https://developers.openai.com/api/docs/pricing",
      "https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create",
      "https://developers.openai.com/api/docs/deprecations",
    ],
    reverifyBy: "2027-01-05",
    costObservation: null,
  },
];

export type ReadoutModelPriceRefusalCode =
  | "model_not_in_register"
  | "cost_never_observed";

/** `null` means the model may be called. Deliberately ignores `reverifyBy`, like the voice one. */
export const readoutModelPriceRefusal = (input: {
  modelId: string;
  register?: readonly ReadoutModelPriceEntry[];
}): { code: ReadoutModelPriceRefusalCode; detail: string } | null => {
  const register = input.register ?? READOUT_MODEL_PRICE_REGISTER;
  const entry = register.find((candidate) => candidate.modelId === input.modelId);
  if (!entry) {
    return {
      code: "model_not_in_register",
      detail: "the configured speech model has no entry in the price register",
    };
  }
  if (entry.costObservation === null) {
    return {
      code: "cost_never_observed",
      detail:
        "the configured speech model's price has only been read, never seen " +
        "on an invoice (docs/policy/voice-input.md §6.1-3, §6.4)",
    };
  }
  return null;
};

export type ReadoutPriceRegisterProblem = {
  modelId: string;
  code:
    | "missing_entry"
    | "expired"
    | "reverify_window_too_long"
    | "owner_missing"
    | "source_missing"
    | "billed_unit_is_not_tokens"
    | "observation_does_not_reconcile";
  detail: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const parseDay = (value: string) => {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
};

/** The CI check over every reachable model (`npm run check:voice-price-register`). */
export const auditReadoutPriceRegister = (input: {
  modelIds: readonly string[];
  now: Date;
  register?: readonly ReadoutModelPriceEntry[];
}): ReadoutPriceRegisterProblem[] => {
  const register = input.register ?? READOUT_MODEL_PRICE_REGISTER;
  const problems: ReadoutPriceRegisterProblem[] = [];
  for (const modelId of input.modelIds) {
    const entry = register.find((candidate) => candidate.modelId === modelId);
    if (!entry) {
      problems.push({ modelId, code: "missing_entry", detail: "a reachable speech model has no recorded price" });
      continue;
    }
    if (!entry.owner.trim()) {
      problems.push({ modelId, code: "owner_missing", detail: "a price with no owner is a price nobody has to re-read" });
    }
    if (entry.sources.length === 0 || entry.sources.some((source) => !/^https:\/\/\S+$/.test(source))) {
      problems.push({ modelId, code: "source_missing", detail: "every figure has to name the page it was read from" });
    }
    const verifiedAt = parseDay(entry.verifiedAt);
    const reverifyBy = parseDay(entry.reverifyBy);
    if (verifiedAt === null || reverifyBy === null) {
      problems.push({ modelId, code: "expired", detail: "verifiedAt or reverifyBy is not a YYYY-MM-DD date" });
      continue;
    }
    if (reverifyBy - verifiedAt > READOUT_PRICE_REVERIFY_MAX_DAYS * DAY_MS) {
      problems.push({
        modelId,
        code: "reverify_window_too_long",
        detail: `more than ${READOUT_PRICE_REVERIFY_MAX_DAYS} days between the reading and its deadline`,
      });
    }
    if (input.now.getTime() > reverifyBy) {
      problems.push({
        modelId,
        code: "expired",
        detail: `read on ${entry.verifiedAt}, due for re-reading by ${entry.reverifyBy}`,
      });
    }
    const observation = entry.costObservation;
    if (!observation) continue;
    if (observation.billedTextInputQuantityUnit !== "tokens" || observation.billedAudioOutputQuantityUnit !== "tokens") {
      problems.push({
        modelId,
        code: "billed_unit_is_not_tokens",
        detail: "a per-million-token rate cannot be reconciled against a charge billed in another unit",
      });
      continue;
    }
    const implied =
      (observation.billedTextInputQuantity * entry.price.textInputPerMillionTokensUsd +
        observation.billedAudioOutputQuantity * entry.price.audioOutputPerMillionTokensUsd) /
      1_000_000;
    if (Math.abs(implied - observation.totalUsd) > 5e-7) {
      problems.push({
        modelId,
        code: "observation_does_not_reconcile",
        detail: `the recorded rates imply US$${implied.toFixed(6)} but the invoice shows US$${observation.totalUsd.toFixed(6)} on ${observation.billedOn}`,
      });
    }
  }
  return problems;
};
