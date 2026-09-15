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
 * ## Why the memory is kept per conversation
 *
 * One memory for the whole page is trusted by coincidence. Cross review of the
 * fix above (v2 round 0) showed it: seed conversation A over `auto`, seed
 * conversation B over `off`, return to A and pick another card -- A's draft and
 * mode still match the single record, which is now B's, so A was put back to
 * B's `off` instead of its own `auto`. So the memory is a store keyed by the
 * composer's draft scope, the same key the draft store uses, and a record is
 * only ever read for the scope that wrote it.
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
  /** The draft scope (`draftKeyFor`) this record was written in. */
  scope: string;
  text: string;
  restore: WebSearchMode;
  applied: WebSearchMode;
};

/** Every scope's last record, keyed by draft scope. */
export type StarterSeedMemories = ReadonlyMap<string, StarterSeedMemory>;

export const EMPTY_STARTER_SEED_MEMORIES: StarterSeedMemories = new Map();

/**
 * The record a click in `scope` may trust, or `null`.
 *
 * A record filed under the wrong key is refused too, so a caller that mixes
 * scopes up fails toward leaving the composer alone rather than trusting a
 * stranger's record.
 */
export const starterSeedMemoryFor = (
  memories: StarterSeedMemories,
  scope: string
): StarterSeedMemory | null => {
  const memory = memories.get(scope);
  return memory !== undefined && memory.scope === scope ? memory : null;
};

export type StarterSeedApplication =
  /** The box holds the person's own writing. The seed does not apply at all. */
  | { applies: false }
  | {
      applies: true;
      webSearchMode: WebSearchMode;
      /** The store with this scope's record replaced; other scopes untouched. */
      memories: StarterSeedMemories;
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
 * `memories` is what earlier applications recorded, per draft scope. The
 * caller keeps the store in a ref and replaces it with the one returned;
 * nothing here reads or writes state.
 */
export function applyStarterSeed(input: {
  /** The composer's draft scope (`draftKeyFor`), the key the draft lives under. */
  scope: string;
  /** What the composer holds right now. */
  draft: string;
  /** What the composer will hold if this seed applies. */
  seedText: string;
  /** Whether the clicked card declares web search. */
  wantsWebSearch: boolean;
  /** The composer's live web-search mode. */
  currentWebSearchMode: WebSearchMode;
  memories: StarterSeedMemories;
}): StarterSeedApplication {
  const memory = starterSeedMemoryFor(input.memories, input.scope);
  if (!starterSeedMayWrite({ draft: input.draft, memory })) {
    return { applies: false };
  }

  // We own the toggle only while it still reads as the value we last wrote.
  // A person who reached past the card and flipped it themselves has taken it
  // back, and their setting is then the one to preserve -- including as the
  // value a later card restores to.
  const owned = memory !== null && memory.applied === input.currentWebSearchMode;
  const restore = owned ? memory.restore : input.currentWebSearchMode;
  const webSearchMode = input.wantsWebSearch ? "always" : restore;

  const memories = new Map(input.memories);
  memories.set(input.scope, {
    scope: input.scope,
    text: input.seedText,
    restore,
    applied: webSearchMode,
  });
  return { applies: true, webSearchMode, memories };
}
