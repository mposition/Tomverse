import assert from "node:assert/strict";
import test from "node:test";
import {
  collectReleasablePreviewUrls,
  draftKeyFor,
  isDraftEmpty,
  moveDraftEntry,
  NEW_CONVERSATION_DRAFT_KEY,
  readDraftEntry,
  removeDraftEntry,
  resolveDraftUpdate,
  writeDraftEntry,
} from "../lib/conversationDraftStore.ts";

const setText = (store, key, text) =>
  writeDraftEntry(store, key, (existing) => ({ ...existing, text }));

const setAttachments = (store, key, attachments) =>
  writeDraftEntry(store, key, (existing) => ({ ...existing, attachments }));

const attachment = (id, data) => ({
  id,
  name: `${id}.png`,
  mediaType: "image/png",
  size: 1,
  kind: "file",
  ...(data ? { data } : {}),
});

test("a conversation without an id gets an explicit key of its own", () => {
  assert.equal(draftKeyFor(null), NEW_CONVERSATION_DRAFT_KEY);
  assert.equal(draftKeyFor(undefined), NEW_CONVERSATION_DRAFT_KEY);
  assert.equal(draftKeyFor(""), NEW_CONVERSATION_DRAFT_KEY);
  assert.equal(draftKeyFor("conversation-a"), "conversation-a");
  // Idempotent, so a caller holding a key can pass it back in as a scope.
  assert.equal(
    draftKeyFor(NEW_CONVERSATION_DRAFT_KEY),
    NEW_CONVERSATION_DRAFT_KEY
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
  let store = setText({}, NEW_CONVERSATION_DRAFT_KEY, "first question");
  store = setText(store, "conversation-a", "question for A");

  store = moveDraftEntry(store, NEW_CONVERSATION_DRAFT_KEY, "conversation-new");

  assert.equal(NEW_CONVERSATION_DRAFT_KEY in store, false);
  assert.equal(readDraftEntry(store, "conversation-new").text, "first question");
  assert.equal(readDraftEntry(store, "conversation-a").text, "question for A");
});

test("a hand-off never overwrites a draft the target already has", () => {
  let store = setText({}, NEW_CONVERSATION_DRAFT_KEY, "pending question");
  store = setText(store, "conversation-a", "question for A");

  store = moveDraftEntry(store, NEW_CONVERSATION_DRAFT_KEY, "conversation-a");

  assert.equal(readDraftEntry(store, "conversation-a").text, "question for A");
  assert.equal(NEW_CONVERSATION_DRAFT_KEY in store, false);
});

test("a hand-off with nothing to move, or onto itself, changes nothing", () => {
  const store = setText({}, "conversation-a", "question for A");
  assert.equal(moveDraftEntry(store, "conversation-a", "conversation-a"), store);
  assert.equal(
    moveDraftEntry(store, NEW_CONVERSATION_DRAFT_KEY, "conversation-b"),
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
