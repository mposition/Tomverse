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

export const chatUserMaxInputTokens = (
  environment: Record<string, string | undefined> = process.env
) => {
  const parsed = Number(environment.CHAT_USER_MAX_INPUT_TOKENS);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : CHAT_USER_MAX_INPUT_TOKENS_DEFAULT;
};
