import assert from "node:assert/strict";
import test from "node:test";
import {
  collectReleasablePreviewUrls,
  draftKeyFor,
  isDraftEmpty,
  isDraftKey,
  moveDraftEntry,
  NEW_CONVERSATION_DRAFT_SEGMENT,
  readDraftEntry,
  removeDraftEntry,
  resolveDraftUpdate,
  writeDraftEntry,
} from "../lib/conversationDraftStore.ts";

const setText = (store, key, text) =>
  writeDraftEntry(store, key, (existing) => ({ ...existing, text }));

const setAttachments = (store, key, attachments) =>
  writeDraftEntry(store, key, (existing) => ({ ...existing, attachments }));

/** The key a signed-in account's new-conversation composer writes under. */
const newChatKey = (identityKey) => draftKeyFor(null, identityKey);

const attachment = (id, data) => ({
  id,
  name: `${id}.png`,
  mediaType: "image/png",
  size: 1,
  kind: "file",
  ...(data ? { data } : {}),
});

test("a conversation without an id gets an explicit key of its own", () => {
  const key = newChatKey("account:user-1");
  assert.equal(draftKeyFor(undefined, "account:user-1"), key);
  assert.equal(draftKeyFor("", "account:user-1"), key);
  assert.ok(key.endsWith(NEW_CONVERSATION_DRAFT_SEGMENT));
  assert.ok(isDraftKey(key));
});

test("a key is idempotent, and keeps the identity it was made with", () => {
  // The property the composer relies on: it holds keys, not conversation ids,
  // and passes them back as scopes. If re-resolving them adopted the *current*
  // identity, an upload finishing after the tab changed hands would land in the
  // new account's draft — which is the whole defect.
  const aKey = draftKeyFor("conversation-a", "account:A");

  assert.equal(draftKeyFor(aKey, "account:A"), aKey);
  assert.equal(
    draftKeyFor(aKey, "account:B"),
    aKey,
    "a key already names its person; a later reader must not rewrite that"
  );
  assert.equal(draftKeyFor(newChatKey("account:A"), null), newChatKey("account:A"));
});

/* ------------------------------------------------------------------------ */
/* Identity isolation: docs/policy/conversation-draft-identity-scope.md      */
/* ------------------------------------------------------------------------ */

test("two accounts in one tab do not share the new-conversation draft", () => {
  // The reproduction. Both accounts' composers are on "new chat", which is the
  // one conversation key every identity used to have in common.
  const store = setText({}, newChatKey("account:A"), "계정 A가 쓰던 초안");

  assert.equal(readDraftEntry(store, newChatKey("account:B")).text, "");
  assert.equal(readDraftEntry(store, newChatKey("account:A")).text, "계정 A가 쓰던 초안");
});

test("a guest and an account do not share it either", () => {
  const store = setText({}, newChatKey("guest"), "guest question");

  assert.equal(readDraftEntry(store, newChatKey("account:A")).text, "");
});

test("attachments are separated by the same key, previews included", () => {
  // §2: the exposure was never only a file card. `data` is a local image
  // preview the composer renders, so it has to be behind the same boundary.
  const store = setAttachments({}, newChatKey("account:A"), [
    attachment("a1", "blob:account-a-thumbnail"),
  ]);

  assert.deepEqual(readDraftEntry(store, newChatKey("account:B")).attachments, []);
});

test("an unresolved session gets its own namespace, not somebody else's", () => {
  const unresolved = draftKeyFor(null, null);

  assert.notEqual(unresolved, newChatKey("account:A"));
  assert.notEqual(unresolved, newChatKey("guest"));
  const store = setText({}, unresolved, "typed before the session settled");
  assert.equal(
    readDraftEntry(store, newChatKey("account:A")).text,
    "",
    "resolving must not adopt text typed by nobody in particular"
  );
});

test("the same conversation id under two identities is two drafts", () => {
  // Not reachable through the UI today — a conversation id belongs to one
  // identity — but the key must not be what stops it.
  let store = setText({}, draftKeyFor("conversation-a", "account:A"), "A");
  store = setText(store, draftKeyFor("conversation-a", "account:B"), "B");

  assert.equal(readDraftEntry(store, draftKeyFor("conversation-a", "account:A")).text, "A");
  assert.equal(readDraftEntry(store, draftKeyFor("conversation-a", "account:B")).text, "B");
});

test("coming back to the first account restores what it was writing", () => {
  // The reason this is isolation rather than deletion: nothing of A's is lost,
  // it is only unreachable from B. In-memory, so it still dies with the tab.
  let store = setText({}, newChatKey("account:A"), "half-written question");
  store = setText(store, newChatKey("account:B"), "B's own question");

  assert.equal(
    readDraftEntry(store, newChatKey("account:A")).text,
    "half-written question"
  );
});

test("an untouched conversation reads as an empty draft, not as undefined", () => {
  const draft = readDraftEntry({}, "conversation-b");
  assert.equal(draft.text, "");
  assert.deepEqual(draft.attachments, []);
  assert.equal(isDraftEmpty(draft), true);
});

test("writing one conversation's draft leaves every other one alone", () => {
  let store = setText({}, "conversation-a", "question for A");
  store = setText(store, "conversation-b", "question for B");

  assert.equal(readDraftEntry(store, "conversation-a").text, "question for A");
  assert.equal(readDraftEntry(store, "conversation-b").text, "question for B");

  store = setText(store, "conversation-b", "question for B, edited");
  assert.equal(readDraftEntry(store, "conversation-a").text, "question for A");
  assert.equal(
    readDraftEntry(store, "conversation-b").text,
    "question for B, edited"
  );
});

test("switching back and forth never mixes two conversations' drafts", () => {
  let store = {};
  for (const round of [1, 2, 3]) {
    store = setText(store, "conversation-a", `A round ${round}`);
    store = setText(store, "conversation-b", `B round ${round}`);
    assert.equal(readDraftEntry(store, "conversation-a").text, `A round ${round}`);
    assert.equal(readDraftEntry(store, "conversation-b").text, `B round ${round}`);
  }
});

test("a no-op write returns the same store so no render is triggered", () => {
  const store = setText({}, "conversation-a", "unchanged");
  assert.equal(setText(store, "conversation-a", "unchanged"), store);
  assert.equal(setText(store, "conversation-b", ""), store);
});

test("emptying a draft removes its entry instead of leaving a blank record", () => {
  let store = setText({}, "conversation-a", "typed then cleared");
  store = setText(store, "conversation-a", "");
  assert.deepEqual(store, {});
});

test("a draft keeps its attachments when its text is emptied", () => {
  let store = setAttachments({}, "conversation-a", [attachment("one")]);
  store = setText(store, "conversation-a", "");
  assert.equal(store["conversation-a"].attachments.length, 1);
});

test("an attachment reducer appends to the target conversation's own list", () => {
  let store = setAttachments({}, "conversation-a", [attachment("a1")]);
  store = setAttachments(store, "conversation-b", [attachment("b1")]);

  // What an upload that finished after the user switched conversations does:
  // it names its own conversation and appends to that list.
  store = writeDraftEntry(store, "conversation-a", (existing) => ({
    ...existing,
    attachments: resolveDraftUpdate(
      (current) => [...current, attachment("a2")],
      existing.attachments
    ),
  }));

  assert.deepEqual(
    store["conversation-a"].attachments.map((item) => item.id),
    ["a1", "a2"]
  );
  assert.deepEqual(
    store["conversation-b"].attachments.map((item) => item.id),
    ["b1"]
  );
});

test("sending clears only the conversation that was sent", () => {
  let store = setText({}, "conversation-a", "question for A");
  store = setText(store, "conversation-b", "question for B");

  store = removeDraftEntry(store, "conversation-b");
  assert.equal(readDraftEntry(store, "conversation-a").text, "question for A");
  assert.equal(readDraftEntry(store, "conversation-b").text, "");
});

test("removing a conversation with no draft returns the same store", () => {
  const store = setText({}, "conversation-a", "question for A");
  assert.equal(removeDraftEntry(store, "conversation-b"), store);
});

test("a new conversation's draft follows the id the server issues", () => {
  let store = setText({}, newChatKey("account:A"), "first question");
  store = setText(store, "conversation-a", "question for A");

  store = moveDraftEntry(store, newChatKey("account:A"), "conversation-new");

  assert.equal(newChatKey("account:A") in store, false);
  assert.equal(readDraftEntry(store, "conversation-new").text, "first question");
  assert.equal(readDraftEntry(store, "conversation-a").text, "question for A");
});

test("a hand-off never overwrites a draft the target already has", () => {
  let store = setText({}, newChatKey("account:A"), "pending question");
  store = setText(store, "conversation-a", "question for A");

  store = moveDraftEntry(store, newChatKey("account:A"), "conversation-a");

  assert.equal(readDraftEntry(store, "conversation-a").text, "question for A");
  assert.equal(newChatKey("account:A") in store, false);
});

test("a hand-off with nothing to move, or onto itself, changes nothing", () => {
  const store = setText({}, "conversation-a", "question for A");
  assert.equal(moveDraftEntry(store, "conversation-a", "conversation-a"), store);
  assert.equal(
    moveDraftEntry(store, newChatKey("account:A"), "conversation-b"),
    store
  );
});

test("only blob previews are released, and never one the sent message kept", () => {
  const kept = attachment("kept", "blob:kept");
  const dropped = attachment("dropped", "blob:dropped");
  const inlined = attachment("inlined", "data:image/png;base64,AA");
  const remote = attachment("remote");

  assert.deepEqual(
    collectReleasablePreviewUrls([kept, dropped, inlined, remote], [kept]),
    ["blob:dropped"]
  );
  assert.deepEqual(
    collectReleasablePreviewUrls([kept, dropped], []),
    ["blob:kept", "blob:dropped"]
  );
});
