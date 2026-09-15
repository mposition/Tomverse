/**
 * How a starter card's seed applies to composer state the person also owns.
 *
 * Contract: docs/ui-contracts/chat-starter-catalog.md section 4.
 *
 * ## The defect this exists for
 *
 * The first version wrote the draft text through an ownership rule -- replace
 * only an empty box or a sentence another card put there, never somebody's own
 * typing -- and then armed web search with a bare `if (seed.webSearch)
 * setWebSearchMode("always")`. Two rules for two halves of the same seed, and
 * only one of them thought about who owned the thing it was changing.
 *
 * Staging found both ends of that asymmetry on 2026-09-15:
 *
 *   * a card that turned search on never turned it back off, so picking the
 *     sourced-answer card and then changing your mind left the next send
 *     priced at 9 credits instead of 1; and
 *   * a card clicked while the person had their own sentence in the box left
 *     the sentence alone (correct) and armed search anyway (not), applying
 *     half a seed nobody asked for.
 *
 * So the seed is applied as a unit or not at all, and the toggle is owned on
 * the same terms as the text: we may put back what we put there, and we may
 * not touch what the person set.
 *
 * Pure, and separate from `ChatPageClient` on purpose -- the component is
 * seven thousand lines and this rule is four cases that each need a test.
 */

import type { WebSearchMode } from "@/lib/appDefaults";

/**
 * What a previous seed did to the composer's toggles, if anything.
 *
 * `restore` is the mode as it stood before the first seed of this run touched
 * it. `applied` is the mode that seed left behind. Comparing `applied` against
 * the live mode is what tells a toggle we own from one the person has since
 * changed -- the exact analogue of comparing the draft against the sentences
 * the cards can produce.
 */
export type StarterSeedToggleMemory = {
  restore: WebSearchMode;
  applied: WebSearchMode;
};

export type StarterSeedApplication =
  /** The box holds the person's own writing. The seed does not apply at all. */
  | { applies: false }
  | {
      applies: true;
      webSearchMode: WebSearchMode;
      memory: StarterSeedToggleMemory;
    };

/**
 * Whether the composer is free for a seed to write into.
 *
 * Empty, or still holding a sentence one of the cards produced. Anything else
 * is the person's work, and a starter card is an offer rather than an edit.
 */
export const starterSeedMayWrite = (input: {
  draft: string;
  seedTexts: ReadonlySet<string>;
}): boolean =>
  input.draft.trim().length === 0 || input.seedTexts.has(input.draft);

/**
 * The whole decision for one click.
 *
 * `memory` is what the last application recorded, or `null` on the first click
 * of a run. The caller keeps it in a ref; nothing here reads or writes state.
 */
export function applyStarterSeed(input: {
  /** What the composer holds right now. */
  draft: string;
  /** Every sentence the catalogue's cards can produce, in the active locale. */
  seedTexts: ReadonlySet<string>;
  /** Whether the clicked card declares web search. */
  wantsWebSearch: boolean;
  /** The composer's live web-search mode. */
  currentWebSearchMode: WebSearchMode;
  memory: StarterSeedToggleMemory | null;
}): StarterSeedApplication {
  if (!starterSeedMayWrite({ draft: input.draft, seedTexts: input.seedTexts })) {
    return { applies: false };
  }

  // We own the toggle only while it still reads as the value we last wrote.
  // A person who reached past the card and flipped it themselves has taken it
  // back, and their setting is then the one to preserve -- including as the
  // value a later card restores to.
  const owned = input.memory !== null && input.memory.applied === input.currentWebSearchMode;
  const restore = owned ? input.memory!.restore : input.currentWebSearchMode;
  const webSearchMode = input.wantsWebSearch ? "always" : restore;

  return {
    applies: true,
    webSearchMode,
    memory: { restore, applied: webSearchMode },
  };
}
