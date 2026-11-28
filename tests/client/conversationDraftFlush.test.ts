import assert from "node:assert/strict";
import test from "node:test";

import {
  draftRequestKeepalive,
  flushPendingDraftSaves,
} from "@/components/chat/useConversationDrafts";

test("flushing pending saves cancels each debounce timer and persists every key once", async () => {
  let fired = 0;
  const timers = new Map<string, ReturnType<typeof setTimeout>>([
    ["draft|account:a|one", setTimeout(() => void fired++, 20)],
    ["draft|account:a|two", setTimeout(() => void fired++, 20)],
  ]);
  const persisted: string[] = [];

  flushPendingDraftSaves(timers, (key) => void persisted.push(key));

  assert.deepEqual(persisted, ["draft|account:a|one", "draft|account:a|two"]);
  assert.equal(timers.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fired, 0, "the debounced callbacks must not also run");
});

test("flushing with nothing pending persists nothing", () => {
  const persisted: string[] = [];
  flushPendingDraftSaves(new Map(), (key) => void persisted.push(key));
  assert.deepEqual(persisted, []);
});

test("a draft write asks to outlive the page only when requested and small enough", () => {
  assert.equal(draftRequestKeepalive("{}", true), true);
  assert.equal(draftRequestKeepalive("{}", false), false);
  assert.equal(draftRequestKeepalive("x".repeat(30_000), true), false);
});
