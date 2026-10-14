/**
 * The backfill plan for readable card numbers (docs/policy/amux-card-display-key.md §5).
 *
 * Pure: the service reads the rows, this decides, and the same function runs
 * again inside the apply transaction so the owner's approval binds to exactly
 * what is written. Nothing here reads a clock, a database or a key.
 */

import {
  AMUX_CARD_DISPLAY_MAX_NUMBER,
  AMUX_CARD_DISPLAY_PATH_PREFIX,
  amuxFeatureDisplayPrefixCandidates,
  formatAmuxCardDisplayKey,
  isAmuxFeatureDisplayPrefix,
} from "./cardDisplayKeyCore.ts";

export const AMUX_CARD_DISPLAY_BACKFILL_PLAN_VERSION = 1 as const;

/**
 * Policy §4: the path prefix of a card without a Feature, by its source
 * system. A card with no source system is LEGACY (§4, last row).
 */
export const AMUX_CARD_DISPLAY_SOURCE_SYSTEM_PATH = {
  tomverse_private_workboard: "workboardImport",
  "codex-conversation": "conversationIntake",
  "local-agent-intake": "localIntake",
  "engineering-product-backlog": "engineeringAgent",
  "engineering-develop-ci": "engineeringAgent",
  "engineering-dependabot-ci": "engineeringAgent",
  "admin-idea-v4": "ideaWithoutFeature",
} as const satisfies Record<string, keyof typeof AMUX_CARD_DISPLAY_PATH_PREFIX>;

/** Prefixes for a Feature whose title yields none (operator decision 2026-10-14). */
const FALLBACK_PREFIXES = Array.from({ length: 999 }, (_, index) => `FEAT${index + 1}`);

export type AmuxBackfillFeature = {
  id: string;
  /** The decrypted, digest-verified title; null when unreadable or purged. */
  title: string | null;
  displayPrefix: string | null;
  createdAt: string;
};

export type AmuxBackfillCard = {
  id: string;
  displayKey: string | null;
  sourceSystem: string | null;
  parentFeatureNodeId: string | null;
  createdAt: string;
};

export type AmuxBackfillPlan = {
  version: typeof AMUX_CARD_DISPLAY_BACKFILL_PLAN_VERSION;
  /** Features that get a prefix now, in assignment order. */
  features: Array<{ id: string; title: string | null; prefix: string; from: "title" | "fallback" }>;
  /** Unnumbered cards and the key each would get, in allocation order. */
  cards: Array<{ id: string; prefix: string; displayKey: string }>;
  /** Cards this plan cannot number, and why. Nothing is written for them. */
  unresolved: Array<{ id: string; reason: "unknown_source" | "feature_missing" | "feature_without_prefix" | "number_exhausted" }>;
};

/**
 * The prefix a title suggests: its first run of ASCII letters and digits that
 * is 2 to 16 characters long (cut to 16) and not a reserved path prefix.
 * "GitHub integration" gives GITHUB; a title with no such run gives null.
 */
export function deriveAmuxFeatureDisplayPrefix(title: string | null): string | null {
  if (title === null) return null;
  const words = title.normalize("NFKD").toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  for (const word of words) {
    const candidate = word.slice(0, 16);
    if (isAmuxFeatureDisplayPrefix(candidate)) return candidate;
  }
  return null;
}

const byCreation = <T extends { id: string; createdAt: string }>(left: T, right: T) =>
  left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 :
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

export function planAmuxCardDisplayKeyBackfill(input: {
  features: readonly AmuxBackfillFeature[];
  cards: readonly AmuxBackfillCard[];
  /** The counter's last number per prefix; a prefix not listed starts at 1. */
  counters: Readonly<Record<string, number>>;
  /** Prefixes already held by any Portfolio node. */
  takenPrefixes: readonly string[];
}): AmuxBackfillPlan {
  const taken = new Set(input.takenPrefixes);
  const featurePrefix = new Map<string, string>();
  for (const feature of input.features) {
    if (feature.displayPrefix !== null) featurePrefix.set(feature.id, feature.displayPrefix);
  }

  const features: AmuxBackfillPlan["features"] = [];
  for (const feature of [...input.features].sort(byCreation)) {
    if (feature.displayPrefix !== null) continue;
    const derived = deriveAmuxFeatureDisplayPrefix(feature.title);
    const candidates = derived === null ? FALLBACK_PREFIXES : amuxFeatureDisplayPrefixCandidates(derived);
    const prefix = candidates.find((candidate) => !taken.has(candidate)) ??
      FALLBACK_PREFIXES.find((candidate) => !taken.has(candidate));
    // Deliberate: with every variant and FEAT1..FEAT999 taken the Feature gets
    // no prefix here, and its cards are reported as feature_without_prefix.
    if (prefix === undefined) continue;
    taken.add(prefix);
    featurePrefix.set(feature.id, prefix);
    features.push({ id: feature.id, title: feature.title, prefix,
      from: derived !== null && candidates.includes(prefix) ? "title" : "fallback" });
  }

  const known = new Set(input.features.map((feature) => feature.id));
  const next = new Map<string, number>();
  const cards: AmuxBackfillPlan["cards"] = [];
  const unresolved: AmuxBackfillPlan["unresolved"] = [];
  for (const card of [...input.cards].sort(byCreation)) {
    if (card.displayKey !== null) continue;
    let prefix: string;
    if (card.parentFeatureNodeId !== null) {
      if (!known.has(card.parentFeatureNodeId)) { unresolved.push({ id: card.id, reason: "feature_missing" }); continue; }
      const held = featurePrefix.get(card.parentFeatureNodeId);
      if (held === undefined) { unresolved.push({ id: card.id, reason: "feature_without_prefix" }); continue; }
      prefix = held;
    } else if (card.sourceSystem === null) {
      prefix = AMUX_CARD_DISPLAY_PATH_PREFIX.legacy;
    } else if (Object.hasOwn(AMUX_CARD_DISPLAY_SOURCE_SYSTEM_PATH, card.sourceSystem)) {
      prefix = AMUX_CARD_DISPLAY_PATH_PREFIX[AMUX_CARD_DISPLAY_SOURCE_SYSTEM_PATH[
        card.sourceSystem as keyof typeof AMUX_CARD_DISPLAY_SOURCE_SYSTEM_PATH]];
    } else {
      unresolved.push({ id: card.id, reason: "unknown_source" });
      continue;
    }
    const number = (next.get(prefix) ?? (input.counters[prefix] ?? 0)) + 1;
    if (number > AMUX_CARD_DISPLAY_MAX_NUMBER) { unresolved.push({ id: card.id, reason: "number_exhausted" }); continue; }
    next.set(prefix, number);
    cards.push({ id: card.id, prefix, displayKey: formatAmuxCardDisplayKey(prefix, number) });
  }
  return { version: AMUX_CARD_DISPLAY_BACKFILL_PLAN_VERSION, features, cards, unresolved };
}

/**
 * What the owner's approval binds: every write and every refusal, without the
 * titles (they are shown, not written). The service digests this.
 */
export function amuxCardDisplayKeyBackfillBinding(plan: AmuxBackfillPlan) {
  return {
    version: plan.version,
    features: plan.features.map(({ id, prefix }) => ({ id, prefix })),
    cards: plan.cards.map(({ id, displayKey }) => ({ id, displayKey })),
    unresolved: plan.unresolved,
  };
}
