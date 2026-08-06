import assert from "node:assert/strict";
import test from "node:test";
import { latestUserPromptText } from "../lib/chatMemoryContextCore.ts";

const user = (content) => ({ role: "user", content });
const assistant = (content) => ({ role: "assistant", content });

test("the query is the newest user turn, not the newest turn", () => {
  assert.equal(
    latestUserPromptText([
      user("first question"),
      assistant("an answer"),
      user("the question being asked now"),
    ]),
    "the question being asked now"
  );
});

test("a trailing assistant turn does not become the query", () => {
  // Regenerate and follow-up flows can end the history on an assistant turn.
  // Scoring retrieval against the model's own last answer would retrieve for
  // the wrong text, and preparation and chat would still agree about it --
  // so no fingerprint check would catch it.
  assert.equal(
    latestUserPromptText([user("the real question"), assistant("an answer")]),
    "the real question"
  );
});

test("the text is passed through exactly, because the fingerprint compares it", () => {
  // Preparation and chat build the context independently and compare
  // fingerprints. Any normalization here that the preparation step does not
  // also perform turns every send into a false staleness refusal.
  const raw = "  Spaced   out\nand multi-line  ";
  assert.equal(latestUserPromptText([user(raw)]), raw);
});

test("a history with no user turn yields an empty query rather than throwing", () => {
  assert.equal(latestUserPromptText([assistant("orphan")]), "");
  assert.equal(latestUserPromptText([]), "");
});
