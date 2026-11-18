/**
 * The largest prompt this deployment accepts, read the way the runtime reads it.
 *
 * One parser, because two were worse than none. The chat budget resolves
 * `CHAT_USER_MAX_INPUT_TOKENS` with `Number` and `Number.isSafeInteger`, and
 * the adoption routes had written their own with `Number.parseInt`. The two
 * agree on `200000` and disagree on `1e6`: the runtime accepts a million-token
 * prompt and `parseInt` reads the same string as `1`. The credit floor would
 * then price a one-token turn and pass a class that covers 1/30th of the real
 * worst case.
 *
 * Pure, and takes its environment, so the floor can be tested at any limit.
 */
export const CHAT_USER_MAX_INPUT_TOKENS_DEFAULT = 128_000;

type Environment = Record<string, string | undefined>;

export const chatUserMaxInputTokens = (
  environment: Environment = process.env
) => {
  const parsed = Number(environment.CHAT_USER_MAX_INPUT_TOKENS);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : CHAT_USER_MAX_INPUT_TOKENS_DEFAULT;
};

/**
 * Long context: a signed-in account may send up to the model's own context
 * window instead of the flat `CHAT_USER_MAX_INPUT_TOKENS`.
 *
 * On unless `CHAT_LONG_CONTEXT_ENABLED=0` (operator decision 2026-11-18). The
 * flat limit stays the threshold that matters for pricing:
 * everything up to it is charged by the flat credit weights exactly as before,
 * and a turn above it is charged at least its own provider cost, converted at
 * `CHAT_LONG_CONTEXT_MICRO_USD_PER_CREDIT`. The input multiplier stops at 3x
 * above 100k, so without that a 1M-token turn would pay what a 128k one pays
 * while costing eight times as much.
 *
 * Guests are untouched: their limit is `CHAT_GUEST_MAX_INPUT_TOKENS`.
 */
export const chatLongContextEnabled = (environment: Environment = process.env) =>
  environment.CHAT_LONG_CONTEXT_ENABLED !== "0";

/**
 * What one credit is taken to be worth for a turn above the flat limit.
 *
 * US$0.0025: the lowest a paid credit sells for today (Max, about US$0.00253
 * at A$1 = US$0.65; Pro is about US$0.00433), so a long turn is not sold below
 * its provider cost on any paid plan.
 */
export const CHAT_LONG_CONTEXT_MICRO_USD_PER_CREDIT_DEFAULT = 2_500;

export const chatLongContextMicroUsdPerCredit = (
  environment: Environment = process.env
) => {
  const parsed = Number(environment.CHAT_LONG_CONTEXT_MICRO_USD_PER_CREDIT);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : CHAT_LONG_CONTEXT_MICRO_USD_PER_CREDIT_DEFAULT;
};

/**
 * The input limit for a signed-in account's turn on this model.
 *
 * With long context off, or a model that declares no window larger than the
 * flat limit, this is the flat limit. Otherwise it is the model's window, held
 * below `flatPriceMaxPromptTokens` when the price this turn will be charged at
 * is only valid up to there (a flat registry price over a tiered profile).
 */
export const chatAccountMaxInputTokens = (
  input: {
    contextWindowTokens?: number | null;
    flatPriceMaxPromptTokens?: number | null;
  },
  environment: Environment = process.env
) => {
  const flat = chatUserMaxInputTokens(environment);
  if (!chatLongContextEnabled(environment)) return flat;
  const window = input.contextWindowTokens;
  if (!Number.isSafeInteger(window) || !window || window <= flat) return flat;
  const priced = input.flatPriceMaxPromptTokens;
  const ceiling =
    Number.isSafeInteger(priced) && priced && priced > 0
      ? Math.min(window, priced)
      : window;
  return Math.max(flat, ceiling);
};

/**
 * How large a `/api/chat` body may be: room for the largest context window any
 * compiled model declares, so the body size never refuses a request the model
 * could hold (operator decision 2026-11-18; it was a fixed 2 MiB).
 *
 * Still a finite bound, because the body is read into memory before anything
 * else, guests included. Eight bytes a token covers UTF-8 Korean and JSON
 * escaping with room; the envelope is everything the request carries besides
 * message text. Next.js's proxy buffers a body only to `proxyClientMaxBodySize`
 * (10 MB by default); `tests/chatRequestLimits.test.mjs` fails if this passes it.
 */
export const CHAT_BODY_BYTES_PER_CONTEXT_TOKEN = 8;
export const CHAT_REQUEST_ENVELOPE_BYTES = 256 * 1024;
export const CHAT_REQUEST_MIN_BODY_BYTES = 2 * 1024 * 1024;

export const chatRequestMaxBodyBytes = (
  contextWindows: readonly (number | null | undefined)[]
) => {
  let largest = 0;
  for (const window of contextWindows) {
    if (Number.isSafeInteger(window) && window && window > largest) largest = window;
  }
  return Math.max(
    CHAT_REQUEST_MIN_BODY_BYTES,
    largest * CHAT_BODY_BYTES_PER_CONTEXT_TOKEN + CHAT_REQUEST_ENVELOPE_BYTES
  );
};

/**
 * Credits a turn above the flat limit is charged, at least.
 *
 * Zero at or below the flat limit, so a turn the flat weights already price is
 * charged exactly what it was. Above it, the turn's reserved provider cost
 * divided by the credit value, rounded up. The caller takes the larger of this
 * and the flat-weighted credits.
 */
export const chatLongContextCostCredits = (
  input: { estimatedInputTokens: number; reservedCostMicroUsd: number },
  environment: Environment = process.env
) => {
  if (!chatLongContextEnabled(environment)) return 0;
  if (input.estimatedInputTokens <= chatUserMaxInputTokens(environment)) return 0;
  const cost = Math.max(0, input.reservedCostMicroUsd);
  return Math.ceil(cost / chatLongContextMicroUsdPerCredit(environment));
};
