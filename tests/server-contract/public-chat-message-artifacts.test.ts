import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A file card survives a reload (CHAT-ART-01).
 *
 * The stream trailer is what the browser sees while the answer arrives; the
 * conversation GET is what it sees afterwards. Both must describe the same
 * cards, and the second must do it without handing the browser a storage key
 * (docs/policy/generated-artifacts.md, "objectKey never reaches the client").
 *
 * On this branch the conversation route selects and shapes the cards itself,
 * so the read boundary is pinned on that route's source: the exact public
 * fields it selects, and that a message with no file carries no artifacts key.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const source = readFileSync(resolve(ROOT, "app/api/conversations/[conversationId]/route.ts"), "utf8");

const CARD_FIELDS = [
  "byteSize",
  "failureCode",
  "filename",
  "format",
  "id",
  "mediaType",
  "modelId",
  "ordinal",
  "status",
];

const artifactSelect = () => {
  const match = /artifacts:\s*\{\s*orderBy:\s*\{\s*ordinal:\s*"asc"\s*\},\s*select:\s*\{([^}]*)\}/.exec(source);
  assert.ok(match, "the conversation route no longer selects artifacts by ordinal with a named select");
  return match[1];
};

test("the conversation GET selects a card's public fields and never its storage key", () => {
  const select = artifactSelect();
  const fields = [...select.matchAll(/(\w+):\s*true/g)].map((entry) => entry[1]).sort();
  assert.deepEqual(fields, CARD_FIELDS);
  assert.doesNotMatch(select, /objectKey/);
});

test("the conversation GET never includes artifact rows wholesale", () => {
  // Comments quote the forbidden form to explain the select; only code counts.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /artifacts:\s*true/);
  assert.doesNotMatch(code, /artifacts:\s*\{\s*include/);
});

test("a restored message carries artifacts only when the answer made a file", () => {
  // Absent, not empty: the same shape the streaming trailer uses.
  assert.match(source, /\.\.\.\(artifacts\.length \? \{ artifacts \} : \{\}\)/);
});
