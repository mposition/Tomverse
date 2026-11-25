import assert from "node:assert/strict";
import test from "node:test";
import { summarizeDiff, visibleDiff } from "../src/renderer/diffSummary";

test("file markers are excluded from the added and removed line count", () => {
  assert.deepEqual(summarizeDiff("+++ new file test\n+ a\n- b\n  context"), { added: 1, removed: 1, lines: 4 });
});

test("the visible diff reports the number of omitted lines", () => {
  assert.deepEqual(visibleDiff("a\nb\nc", 2), { text: "a\nb", hidden: 1 });
  assert.deepEqual(visibleDiff("a\nb\nc", 0), { text: "", hidden: 3 });
});
