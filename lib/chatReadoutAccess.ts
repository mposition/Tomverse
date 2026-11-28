import { readoutModelPriceRefusal, type ReadoutModelPriceEntry } from "@/lib/chatReadoutPricing";

/**
 * Whether this deployment reads Chat answers aloud with a provider voice, and
 * under which limits.
 *
 * Contract: docs/policy/voice-input.md §6.4. Pure: the route and the page shell
 * pass `process.env` in, and the tests pass a plain object.
 *
 * Every refusal here means the same thing to the user: "Read aloud" uses the
 * browser's own voice, as it did before this existed. Nothing here charges the
 * user -- like voice input (§6.1-1) there is no credit price -- so the limits
 * below are operational guardrails on what leaves this deployment, never an
 * entitlement.
 */

/** The speech model and voice every server read-aloud uses. */
export const READOUT_MODEL_ID = "gpt-4o-mini-tts";
export const READOUT_VOICE = "marin";
export const READOUT_RESPONSE_FORMAT = "mp3";

/**
 * One request's text. Under the provider's 4,096-character input limit, and
 * small enough that the first piece starts playing within a few seconds.
 */
export const READOUT_CHUNK_MAX_CHARACTERS = 1_500;

/** One answer is read for at most this many pieces (12,000 characters); the rest is not read. */
export const READOUT_MAX_CHUNKS = 8;

export const READOUT_ENV = {
  enabled: "CHAT_SERVER_READOUT_ENABLED",
  killSwitch: "CHAT_SERVER_READOUT_KILL_SWITCH",
  apiKey: "CHAT_SERVER_READOUT_API_KEY",
  accountCharactersPerDay: "CHAT_READOUT_CHARACTERS_PER_ACCOUNT_DAY",
  providerCharactersPerDay: "CHAT_READOUT_PROVIDER_CHARACTERS_PER_DAY",
  providerCharactersPerMonth: "CHAT_READOUT_PROVIDER_CHARACTERS_PER_MONTH",
} as const;

export type ReadoutLimits = {
  accountCharactersPerDay: number;
  providerCharactersPerDay: number;
  providerCharactersPerMonth: number;
};

type Env = Record<string, string | undefined>;

const positiveInteger = (raw: string | undefined): number | null => {
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

/**
 * The three ceilings, or null when any of them is absent or unusable.
 *
 * There is no default in any environment. A default would be a spending
 * ceiling nobody chose; an unset one keeps the server voice off, which is the
 * direction that cannot cost anything.
 */
export const resolveReadoutLimits = (env: Env): ReadoutLimits | null => {
  const accountCharactersPerDay = positiveInteger(env[READOUT_ENV.accountCharactersPerDay]);
  const providerCharactersPerDay = positiveInteger(env[READOUT_ENV.providerCharactersPerDay]);
  const providerCharactersPerMonth = positiveInteger(env[READOUT_ENV.providerCharactersPerMonth]);
  if (!accountCharactersPerDay || !providerCharactersPerDay || !providerCharactersPerMonth) return null;
  if (providerCharactersPerMonth < providerCharactersPerDay) return null;
  return { accountCharactersPerDay, providerCharactersPerDay, providerCharactersPerMonth };
};

export type ReadoutRefusal =
  | "switch_off"
  | "kill_switch"
  | "price_not_verified"
  | "limits_not_configured"
  | "provider_key_missing";

/**
 * Why the server voice is unavailable here, or null when it may be used.
 *
 * The switch reads exactly "true" and nothing else; the kill switch reads any
 * non-empty value as "stop", for the asymmetry voice input explains (§2): an
 * operator who typed something meant something.
 */
export const readoutRefusal = (input: {
  env: Env;
  hasProviderKey: boolean;
  /** Injected by tests only; production always reads the real register. */
  register?: readonly ReadoutModelPriceEntry[];
}): ReadoutRefusal | null => {
  if (input.env[READOUT_ENV.killSwitch]?.trim()) return "kill_switch";
  if (input.env[READOUT_ENV.enabled] !== "true") return "switch_off";
  if (readoutModelPriceRefusal({ modelId: READOUT_MODEL_ID, register: input.register })) return "price_not_verified";
  if (!resolveReadoutLimits(input.env)) return "limits_not_configured";
  if (!input.hasProviderKey) return "provider_key_missing";
  return null;
};
