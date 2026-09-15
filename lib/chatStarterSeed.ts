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
 * ## Why the text is remembered rather than recognised
 *
 * The text used to be owned by recognition: "is the draft one of the sentences
 * the cards produce", with that set built from the active locale. Cross review
 * round 2 (2026-09-15) found the hole -- change the language after a click and
 * the sentence already in the box is no longer in the set, so the next card
 * reads it as the person's writing, applies nothing, and the search the first
 * card armed can no longer be put back. The 9-credit send, reached by a
 * language switch. A copy edit or a translation update does the same.
 *
 * Recognising every locale's sentences instead would close that and open the
 * opposite hole: a person who typed a card's sentence themselves, in any
 * language, would have it replaced. So the text is owned the way the toggle
 * already was -- by remembering what we last wrote and asking whether the box
 * still holds exactly that.
 *
 * Pure, and separate from `ChatPageClient` on purpose -- the component is
 * seven thousand lines and this rule is four cases that each need a test.
 */

import type { WebSearchMode } from "@/lib/appDefaults";

/**
 * What the last seed wrote into the composer.
 *
 * `text` is the draft that seed left behind. `restore` is the web-search mode
 * as it stood before the first seed of this run touched it, and `applied` the
 * mode that seed left behind. Each is trusted only while the live composer
 * still reads as what was written: a draft that no longer equals `text`, or a
 * mode that no longer equals `applied`, has been taken back by the person.
 */
export type StarterSeedMemory = {
  text: string;
  restore: WebSearchMode;
  applied: WebSearchMode;
};

export type StarterSeedApplication =
  /** The box holds the person's own writing. The seed does not apply at all. */
  | { applies: false }
  | {
      applies: true;
      webSearchMode: WebSearchMode;
      memory: StarterSeedMemory;
    };

/**
 * Whether the composer is free for a seed to write into.
 *
 * Empty, or still holding exactly the text the last seed wrote. Anything else
 * is the person's work, and a starter card is an offer rather than an edit --
 * including a sentence that happens to match a card's, if no card put it there.
 */
export const starterSeedMayWrite = (input: {
  draft: string;
  memory: StarterSeedMemory | null;
}): boolean =>
  input.draft.trim().length === 0 ||
  (input.memory !== null && input.memory.text === input.draft);

/**
 * The whole decision for one click.
 *
 * `memory` is what the last application recorded, or `null` on the first click
 * of a run. The caller keeps it in a ref; nothing here reads or writes state.
 */
export function applyStarterSeed(input: {
  /** What the composer holds right now. */
  draft: string;
  /** What the composer will hold if this seed applies. */
  seedText: string;
  /** Whether the clicked card declares web search. */
  wantsWebSearch: boolean;
  /** The composer's live web-search mode. */
  currentWebSearchMode: WebSearchMode;
  memory: StarterSeedMemory | null;
}): StarterSeedApplication {
  if (!starterSeedMayWrite({ draft: input.draft, memory: input.memory })) {
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
    memory: { text: input.seedText, restore, applied: webSearchMode },
  };
}
