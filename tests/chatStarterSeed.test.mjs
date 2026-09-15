import assert from "node:assert/strict";
import test from "node:test";

import {
  applyStarterSeed,
  starterSeedMayWrite,
} from "../lib/chatStarterSeed.ts";

const SEEDS = new Set(["seed A", "seed B"]);

const apply = (overrides = {}) =>
  applyStarterSeed({
    draft: "",
    seedTexts: SEEDS,
    wantsWebSearch: false,
    currentWebSearchMode: "off",
    memory: null,
    ...overrides,
  });

// --- who owns the box -------------------------------------------------------

test("an empty box and another card's sentence are both free to write", () => {
  assert.equal(starterSeedMayWrite({ draft: "", seedTexts: SEEDS }), true);
  assert.equal(starterSeedMayWrite({ draft: "   ", seedTexts: SEEDS }), true);
  assert.equal(starterSeedMayWrite({ draft: "seed A", seedTexts: SEEDS }), true);
});

test("a person's own sentence is not", () => {
  assert.equal(
    starterSeedMayWrite({ draft: "my own half finished question", seedTexts: SEEDS }),
    false
  );
  // Nearly a seed is not a seed. Anything edited is theirs.
  assert.equal(
    starterSeedMayWrite({ draft: "seed A but edited", seedTexts: SEEDS }),
    false
  );
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

// --- the toggle follows the same ownership rule -----------------------------

test("a card that wants search arms it and remembers what it replaced", () => {
  const result = apply({ wantsWebSearch: true, currentWebSearchMode: "off" });
  assert.equal(result.applies, true);
  assert.equal(result.webSearchMode, "always");
  assert.deepEqual(result.memory, { restore: "off", applied: "always" });
});

test("a later card that does not want search puts the mode back", () => {
  // This is the staging finding: search stayed on across a card change, and
  // the next send was priced at 9 credits instead of 1.
  const first = apply({ wantsWebSearch: true, currentWebSearchMode: "off" });
  const second = apply({
    draft: "seed A",
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
    wantsWebSearch: false,
    currentWebSearchMode: "auto",
    memory: first.memory,
  });
  assert.equal(second.webSearchMode, "auto");
  assert.deepEqual(second.memory, { restore: "auto", applied: "auto" });
});

test("re-picking the searching card arms it again from the same restore point", () => {
  const first = apply({ wantsWebSearch: true, currentWebSearchMode: "off" });
  const second = apply({
    draft: "seed A",
    wantsWebSearch: false,
    currentWebSearchMode: "always",
    memory: first.memory,
  });
  const third = apply({
    draft: "seed B",
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
  const stale = { restore: "always", applied: "always" };
  const result = apply({
    wantsWebSearch: false,
    currentWebSearchMode: "off",
    memory: stale,
  });
  assert.equal(result.webSearchMode, "off");
  assert.deepEqual(result.memory, { restore: "off", applied: "off" });
});
