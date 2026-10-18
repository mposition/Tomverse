/**
 * Readable AMUX card numbers: `AMUX-<PREFIX>-<NNN>` (docs/policy/amux-card-display-key.md).
 *
 * The Task ID stays the canonical identifier for every API, link, log and
 * recovery record. The display key is a name people read, say and search for,
 * and once written it never changes. Pure: no database, no clock.
 *
 * The same rules live in the migration
 * (prisma/migrations/20261014100000_amux_card_display_key) as CHECK
 * constraints and triggers; tests/amuxCardDisplayKeyCore.test.mjs compares the
 * two so neither moves alone.
 */

/** Policy §2-2: a short uppercase code of 2 to 16 characters, A-Z and 0-9 only. */
export const AMUX_CARD_DISPLAY_PREFIX_PATTERN = "^[A-Z0-9]{2,16}$";

/**
 * Policy §3: at least three digits, zero padded below 1000, never a leading
 * zero above it, from 1 to nine digits.
 */
export const AMUX_CARD_DISPLAY_KEY_PATTERN =
  "^AMUX-[A-Z0-9]{2,16}-(00[1-9]|0[1-9][0-9]|[1-9][0-9]{2,8})$";

export const AMUX_CARD_DISPLAY_MAX_NUMBER = 999_999_999;

/**
 * Policy §4: the fixed prefixes of cards without a Feature. Reserved, so no
 * Feature may take one of them.
 */
export const AMUX_CARD_DISPLAY_RESERVED_PREFIXES = [
  "WORKBOARD",
  "INTAKE",
  "LOCAL",
  "ENG",
  "IDEA",
  "SYNC",
  "LEGACY",
] as const;

export type AmuxCardDisplayReservedPrefix = (typeof AMUX_CARD_DISPLAY_RESERVED_PREFIXES)[number];

/**
 * Policy §4, by registration path. Each card-creating path names its own
 * entry here rather than spelling the prefix, so the table in the policy and
 * the writers cannot drift apart unnoticed.
 */
export const AMUX_CARD_DISPLAY_PATH_PREFIX = {
  /** tomverse_private_workboard import */
  workboardImport: "WORKBOARD",
  /** codex-conversation intake */
  conversationIntake: "INTAKE",
  /** local-agent-intake */
  localIntake: "LOCAL",
  /** engineering agent registration sources */
  engineeringAgent: "ENG",
  /** admin-idea-v4 card with no Feature */
  ideaWithoutFeature: "IDEA",
  /** AMUX snapshot sync, no source */
  snapshotSync: "SYNC",
  /** backfill of a card with neither source nor Feature */
  legacy: "LEGACY",
} as const satisfies Record<string, AmuxCardDisplayReservedPrefix>;

const PREFIX = new RegExp(AMUX_CARD_DISPLAY_PREFIX_PATTERN);
const DISPLAY_KEY = new RegExp(AMUX_CARD_DISPLAY_KEY_PATTERN);

export const isAmuxCardDisplayPrefix = (value: unknown): value is string =>
  typeof value === "string" && PREFIX.test(value);

export const isAmuxCardDisplayReservedPrefix = (value: unknown): value is AmuxCardDisplayReservedPrefix =>
  typeof value === "string" &&
  (AMUX_CARD_DISPLAY_RESERVED_PREFIXES as readonly string[]).includes(value);

/** A prefix a Feature may hold: well formed and not one of the reserved path prefixes. */
export const isAmuxFeatureDisplayPrefix = (value: unknown): value is string =>
  isAmuxCardDisplayPrefix(value) && !isAmuxCardDisplayReservedPrefix(value);

/**
 * docs/policy/amux-intake.md v17 item 3: the prefixes a new Feature may take, in order. The
 * proposal first, then `<PREFIX>2` .. `<PREFIX>99`, each cut from the front
 * to fit 16 characters. Empty when the proposal is not a Feature prefix.
 */
export function amuxFeatureDisplayPrefixCandidates(proposed: unknown): string[] {
  if (!isAmuxFeatureDisplayPrefix(proposed)) return [];
  const candidates = [proposed];
  for (let suffix = 2; suffix <= 99; suffix += 1) {
    const tail = String(suffix);
    candidates.push(proposed.slice(0, 16 - tail.length) + tail);
  }
  return [...new Set(candidates.filter(isAmuxFeatureDisplayPrefix))];
}

/** The first candidate no Feature holds yet, or null when every one is taken. */
export function pickAmuxFeatureDisplayPrefix(
  candidates: readonly string[], taken: ReadonlySet<string>,
): string | null {
  return candidates.find((candidate) => !taken.has(candidate)) ?? null;
}

export const isAmuxCardDisplayKey = (value: unknown): value is string =>
  typeof value === "string" && DISPLAY_KEY.test(value);

export function formatAmuxCardDisplayKey(prefix: string, number: number): string {
  if (!isAmuxCardDisplayPrefix(prefix)) {
    throw new Error("AMUX card display prefix is invalid");
  }
  if (!Number.isSafeInteger(number) || number < 1 || number > AMUX_CARD_DISPLAY_MAX_NUMBER) {
    throw new Error("AMUX card display number is out of range");
  }
  return `AMUX-${prefix}-${String(number).padStart(3, "0")}`;
}

export function parseAmuxCardDisplayKey(value: unknown): { prefix: string; number: number } | null {
  if (!isAmuxCardDisplayKey(value)) return null;
  const separator = value.lastIndexOf("-");
  return { prefix: value.slice("AMUX-".length, separator), number: Number(value.slice(separator + 1)) };
}
