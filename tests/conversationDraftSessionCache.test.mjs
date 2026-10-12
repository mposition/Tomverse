import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeConversationDraftSession,
  openConversationDraftSession,
  publishConversationDraftSession,
  resetConversationDraftSessionCacheForTest,
} from "../lib/conversationDraftSessionCache.ts";

const draft = (text) => ({
  [`draft|account:a|new-conversation`]: { text, attachments: [] },
});

test.beforeEach(() => resetConversationDraftSessionCacheForTest());

test("Chat and Review retain separate drafts for one resolved identity", () => {
  const chat = openConversationDraftSession("account:a", "chat");
  assert.ok(chat.fence);
  assert.equal(publishConversationDraftSession(chat.fence, draft("chat draft")), true);

  const review = openConversationDraftSession("account:a", "review");
  assert.ok(review.fence);
  assert.deepEqual(review.store, {});
  assert.equal(publishConversationDraftSession(review.fence, draft("review draft")), true);

  const returnedChat = openConversationDraftSession("account:a", "chat");
  assert.deepEqual(returnedChat.store, draft("chat draft"));
  assert.equal(
    consumeConversationDraftSession(returnedChat.fence, returnedChat.store),
    true
  );
  const returnedReview = openConversationDraftSession("account:a", "review");
  assert.deepEqual(returnedReview.store, draft("review draft"));
});

test("a discarded development remount cannot consume the committed mount's snapshot", () => {
  const original = openConversationDraftSession("account:a", "chat");
  assert.ok(original.fence);
  assert.equal(
    publishConversationDraftSession(original.fence, draft("survives remount")),
    true
  );

  const discarded = openConversationDraftSession("account:a", "chat");
  const committed = openConversationDraftSession("account:a", "chat");
  assert.deepEqual(discarded.store, draft("survives remount"));
  assert.deepEqual(committed.store, draft("survives remount"));
  assert.equal(
    consumeConversationDraftSession(discarded.fence, discarded.store),
    false
  );
  assert.equal(
    consumeConversationDraftSession(committed.fence, committed.store),
    true
  );

  const next = openConversationDraftSession("account:a", "chat");
  assert.deepEqual(next.store, {});
});

test("an identity transition purges prior drafts and A to B to A restores nothing", () => {
  const a = openConversationDraftSession("account:a", "chat");
  assert.ok(a.fence);
  publishConversationDraftSession(a.fence, draft("private A draft"));

  const b = openConversationDraftSession("account:b", "chat");
  assert.deepEqual(b.store, {});
  assert.deepEqual(b.retired, [draft("private A draft")]);

  const returnedA = openConversationDraftSession("account:a", "chat");
  assert.deepEqual(returnedA.store, {});
});

test("a stale A writer cannot publish after B owns the cache", () => {
  const a = openConversationDraftSession("account:a", "chat");
  assert.ok(a.fence);
  const b = openConversationDraftSession("account:b", "chat");
  assert.ok(b.fence);
  assert.equal(publishConversationDraftSession(a.fence, draft("late A")), false);
  assert.equal(publishConversationDraftSession(b.fence, draft("current B")), true);

  const reviewB = openConversationDraftSession("account:b", "review");
  assert.deepEqual(reviewB.store, {});
});

test("a replaced mount cannot overwrite a newer lease for the same product", () => {
  const oldMount = openConversationDraftSession("account:a", "chat");
  assert.ok(oldMount.fence);
  const newMount = openConversationDraftSession("account:a", "chat");
  assert.ok(newMount.fence);
  assert.equal(
    publishConversationDraftSession(oldMount.fence, draft("stale mount")),
    false
  );
  assert.equal(
    publishConversationDraftSession(newMount.fence, draft("current mount")),
    true
  );
});

test("unresolved identity neither restores nor publishes resolved drafts", () => {
  const a = openConversationDraftSession("account:a", "chat");
  assert.ok(a.fence);
  publishConversationDraftSession(a.fence, draft("private A draft"));

  const unresolved = openConversationDraftSession(null, "chat");
  assert.equal(unresolved.fence, null);
  assert.deepEqual(unresolved.store, {});
  assert.deepEqual(unresolved.retired, [draft("private A draft")]);
  assert.equal(publishConversationDraftSession(a.fence, draft("late A")), false);
});
