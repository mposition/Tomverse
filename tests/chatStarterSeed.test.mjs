import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_STARTER_SEED_MEMORIES,
  applyStarterSeed,
  starterSeedMayWrite,
  starterSeedMemoryFor,
} from "../lib/chatStarterSeed.ts";

const apply = (overrides = {}) =>
  applyStarterSeed({
    scope: "A",
    draft: "",
    seedText: "seed A",
    wantsWebSearch: false,
    currentWebSearchMode: "off",
    memories: EMPTY_STARTER_SEED_MEMORIES,
    ...overrides,
  });

const wrote = (text, scope = "A") => ({ scope, text, restore: "off", applied: "off" });
const recordOf = (result, scope = "A") => starterSeedMemoryFor(result.memories, scope);

// --- who owns the box -------------------------------------------------------

test("an empty box and the sentence the last card wrote are both free to write", () => {
  assert.equal(starterSeedMayWrite({ draft: "", memory: null }), true);
  assert.equal(starterSeedMayWrite({ draft: "   ", memory: null }), true);
  assert.equal(starterSeedMayWrite({ draft: "seed A", memory: wrote("seed A") }), true);
});

test("a person's own sentence is not", () => {
  assert.equal(
    starterSeedMayWrite({ draft: "my own half finished question", memory: wrote("seed A") }),
    false
  );
  // Nearly a seed is not a seed. Anything edited is theirs.
  assert.equal(
    starterSeedMayWrite({ draft: "seed A but edited", memory: wrote("seed A") }),
    false
  );
});

test("a card's sentence no card put there is the person's", () => {
  // Ownership is remembered, not recognised. Somebody who typed a card's
  // sentence themselves -- in any language -- typed it, and a click must not
  // take it. Recognising every locale's sentences would have got this wrong.
  assert.equal(starterSeedMayWrite({ draft: "seed A", memory: null }), false);
  assert.equal(starterSeedMayWrite({ draft: "seed A", memory: wrote("seed B") }), false);
});

test("the seed applies as a unit or not at all", () => {
  // The defect: the text was preserved and search was armed anyway, which is
  // half a seed on somebody else's sentence.
  const result = apply({
    draft: "my own question",
    wantsWebSearch: true,
    currentWebSearchMode: "off",
  });
  assert.deepEqual(result, { applies: false });
});

test("the memory records the text the seed leaves in the box", () => {
  assert.equal(recordOf(apply({ seedText: "seed A" })).text, "seed A");
  // An image card hands its sentence over and empties the chat box; what it
  // leaves behind is the empty string, not the sentence it handed over.
  assert.equal(recordOf(apply({ seedText: "" })).text, "");
});

// --- a seed outlives a language change --------------------------------------

test("a seed written in one language is still ours after the language changes", () => {
  // Cross review round 2, 2026-09-15. The draft holds the English seed; the
  // catalogue now renders Korean, so the next card's sentence is Korean. The
  // old rule looked the draft up among the active locale's sentences, did not
  // find it, applied nothing, and left search armed -- the 9-credit send.
  const english = apply({
    seedText: "What changed this year? Include the sources you used.",
    wantsWebSearch: true,
    currentWebSearchMode: "off",
  });
  const korean = apply({
    draft: "What changed this year? Include the sources you used.",
    seedText: "같은 질문을 여러 모델에게 물어보기",
    wantsWebSearch: false,
    currentWebSearchMode: english.webSearchMode,
    memories: english.memories,
  });
  assert.equal(korean.applies, true);
  assert.equal(korean.webSearchMode, "off");
  assert.equal(recordOf(korean).text, "같은 질문을 여러 모델에게 물어보기");
});

// --- one record per conversation --------------------------------------------

test("each conversation restores to its own mode, not the last one seeded", () => {
  // Cross review v2 round 0. A over `auto`, then B over `off` with the same
  // card, then back to A. A single page-wide record was B's by then, and A's
  // draft and mode matched it by coincidence, so A was put back to `off`.
  const inA = apply({
    scope: "A",
    seedText: "sourced seed",
    wantsWebSearch: true,
    currentWebSearchMode: "auto",
  });
  const inB = apply({
    scope: "B",
    seedText: "sourced seed",
    wantsWebSearch: true,
    currentWebSearchMode: "off",
    memories: inA.memories,
  });
  const backInA = apply({
    scope: "A",
    draft: "sourced seed",
    seedText: "plain seed",
    wantsWebSearch: false,
    currentWebSearchMode: "always",
    memories: inB.memories,
  });
  assert.equal(backInA.applies, true);
  assert.equal(backInA.webSearchMode, "auto");
  // B's record is untouched by what happened in A.
  assert.deepEqual(recordOf(backInA, "B"), {
    scope: "B",
    text: "sourced seed",
    restore: "off",
    applied: "always",
  });
});

test("a conversation no card has seeded trusts nobody else's record", () => {
  // B's draft and mode equal what A's record wrote, but no card wrote them in
  // B: the sentence is the person's, and nothing of the seed lands.
  const inA = apply({ scope: "A", seedText: "seed A", wantsWebSearch: true });
  const inB = apply({
    scope: "B",
    draft: "seed A",
    seedText: "seed B",
    currentWebSearchMode: "always",
    memories: inA.memories,
  });
  assert.deepEqual(inB, { applies: false });
});

test("a record filed under the wrong scope is refused, not trusted", () => {
  const misfiled = new Map([["A", wrote("seed A", "B")]]);
  assert.equal(starterSeedMemoryFor(misfiled, "A"), null);
  assert.deepEqual(
    apply({ scope: "A", draft: "seed A", memories: misfiled }),
    { applies: false }
  );
});

// --- the toggle follows the same ownership rule -----------------------------

test("a card that wants search arms it and remembers what it replaced", () => {
  const result = apply({ wantsWebSearch: true, currentWebSearchMode: "off" });
  assert.equal(result.applies, true);
  assert.equal(result.webSearchMode, "always");
  assert.deepEqual(recordOf(result), {
    scope: "A",
    text: "seed A",
    restore: "off",
    applied: "always",
  });
});

test("a later card that does not want search puts the mode back", () => {
  // This is the staging finding: search stayed on across a card change, and
  // the next send was priced at 9 credits instead of 1.
  const first = apply({ wantsWebSearch: true, currentWebSearchMode: "off" });
  const second = apply({
    draft: "seed A",
    seedText: "seed B",
    wantsWebSearch: false,
    currentWebSearchMode: first.webSearchMode,
    memories: first.memories,
  });
  assert.equal(second.applies, true);
  assert.equal(second.webSearchMode, "off");
});

test("what it puts back is what was there before the first seed, not a default", () => {
  const first = apply({ wantsWebSearch: true, currentWebSearchMode: "auto" });
  assert.equal(first.webSearchMode, "always");
  const second = apply({
    draft: "seed A",
    seedText: "seed B",
    wantsWebSearch: false,
    currentWebSearchMode: "always",
    memories: first.memories,
  });
  assert.equal(second.webSearchMode, "auto");
});

test("a toggle the person changed themselves is theirs, and is not put back", () => {
  const first = apply({ wantsWebSearch: true, currentWebSearchMode: "off" });
  // They reached past the card and turned it off; then they turn it on again
  // deliberately. The live mode no longer matches what the seed wrote, so the
  // next card must not treat it as ours to restore.
  const second = apply({
    draft: "seed A",
    seedText: "seed B",
    wantsWebSearch: false,
    currentWebSearchMode: "auto",
    memories: first.memories,
  });
  assert.equal(second.webSearchMode, "auto");
  assert.deepEqual(recordOf(second), {
    scope: "A",
    text: "seed B",
    restore: "auto",
    applied: "auto",
  });
});

test("re-picking the searching card arms it again from the same restore point", () => {
  const first = apply({ wantsWebSearch: true, currentWebSearchMode: "off" });
  const second = apply({
    draft: "seed A",
    seedText: "seed B",
    wantsWebSearch: false,
    currentWebSearchMode: "always",
    memories: first.memories,
  });
  const third = apply({
    draft: "seed B",
    seedText: "seed A",
    wantsWebSearch: true,
    currentWebSearchMode: second.webSearchMode,
    memories: second.memories,
  });
  assert.equal(third.webSearchMode, "always");
  assert.equal(recordOf(third).restore, "off");
});

test("a first card that does not want search changes nothing", () => {
  const result = apply({ wantsWebSearch: false, currentWebSearchMode: "auto" });
  assert.equal(result.applies, true);
  assert.equal(result.webSearchMode, "auto");
});

test("a record whose mode was reset under it is ignored, not trusted", () => {
  // Reopening a conversation resets the mode from its saved settings without
  // telling this module. The record is only trusted while the live mode still
  // matches what it wrote, so the mismatch makes it capture afresh rather
  // than restore a value from before the reset.
  const stale = new Map([["A", { scope: "A", text: "seed A", restore: "always", applied: "always" }]]);
  const result = apply({
    wantsWebSearch: false,
    currentWebSearchMode: "off",
    memories: stale,
  });
  assert.equal(result.webSearchMode, "off");
  assert.deepEqual(recordOf(result), {
    scope: "A",
    text: "seed A",
    restore: "off",
    applied: "off",
  });
});
