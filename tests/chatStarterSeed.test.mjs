import assert from "node:assert/strict";
import test from "node:test";

import {
  applyStarterSeed,
  starterSeedMayWrite,
} from "../lib/chatStarterSeed.ts";

const apply = (overrides = {}) =>
  applyStarterSeed({
    draft: "",
    seedText: "seed A",
    wantsWebSearch: false,
    currentWebSearchMode: "off",
    memory: null,
    ...overrides,
  });

const wrote = (text) => ({ text, restore: "off", applied: "off" });

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
  const result = apply({ seedText: "seed A" });
  assert.equal(result.memory.text, "seed A");
  // An image card hands its sentence over and empties the chat box; what it
  // leaves behind is the empty string, not the sentence it handed over.
  const handedOver = apply({ seedText: "" });
  assert.equal(handedOver.memory.text, "");
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
    memory: english.memory,
  });
  assert.equal(korean.applies, true);
  assert.equal(korean.webSearchMode, "off");
  assert.equal(korean.memory.text, "같은 질문을 여러 모델에게 물어보기");
});

// --- the toggle follows the same ownership rule -----------------------------

test("a card that wants search arms it and remembers what it replaced", () => {
  const result = apply({ wantsWebSearch: true, currentWebSearchMode: "off" });
  assert.equal(result.applies, true);
  assert.equal(result.webSearchMode, "always");
  assert.deepEqual(result.memory, { text: "seed A", restore: "off", applied: "always" });
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
    memory: first.memory,
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
    memory: first.memory,
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
    memory: first.memory,
  });
  assert.equal(second.webSearchMode, "auto");
  assert.deepEqual(second.memory, { text: "seed B", restore: "auto", applied: "auto" });
});

test("re-picking the searching card arms it again from the same restore point", () => {
  const first = apply({ wantsWebSearch: true, currentWebSearchMode: "off" });
  const second = apply({
    draft: "seed A",
    seedText: "seed B",
    wantsWebSearch: false,
    currentWebSearchMode: "always",
    memory: first.memory,
  });
  const third = apply({
    draft: "seed B",
    seedText: "seed A",
    wantsWebSearch: true,
    currentWebSearchMode: second.webSearchMode,
    memory: second.memory,
  });
  assert.equal(third.webSearchMode, "always");
  assert.equal(third.memory.restore, "off");
});

test("a first card that does not want search changes nothing", () => {
  const result = apply({ wantsWebSearch: false, currentWebSearchMode: "auto" });
  assert.equal(result.applies, true);
  assert.equal(result.webSearchMode, "auto");
});

test("stale memory from another conversation is ignored, not trusted", () => {
  // A conversation switch resets the mode without telling this module. The
  // memory is only trusted while the live mode still matches what it wrote, so
  // the mismatch makes it capture afresh rather than restore a stranger's
  // value.
  const stale = { text: "seed A", restore: "always", applied: "always" };
  const result = apply({
    wantsWebSearch: false,
    currentWebSearchMode: "off",
    memory: stale,
  });
  assert.equal(result.webSearchMode, "off");
  assert.deepEqual(result.memory, { text: "seed A", restore: "off", applied: "off" });
});
