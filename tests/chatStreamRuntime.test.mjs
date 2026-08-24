import assert from "node:assert/strict";
import test from "node:test";
import {
  abortChatRuntime,
  advanceChatRuntimeRevision,
  beginChatRuntimeRun,
  chatRuntimeIdentityKey,
  chatRuntimeKey,
  chatRuntimeKeyIdentity,
  claimChatRuntimeLoad,
  endChatRuntimeRun,
  getChatRuntimeLastPrompt,
  getChatRuntimeRevision,
  getChatRuntimeServerSnapshot,
  getChatRuntimeSnapshot,
  hasResumedChatRuntimeJob,
  isChatRuntimeLoadInFlight,
  isChatRuntimeStreaming,
  isCurrentChatRuntimeLoad,
  markChatRuntimeJobResumed,
  ownsChatRuntimeTranscript,
  releaseChatRuntimeForOtherIdentities,
  releaseChatRuntimeLoad,
  resetChatStreamRuntime,
  setChatRuntimeLastPrompt,
  settleChatRuntimeLoad,
  subscribeChatRuntime,
  writeChatRuntimeMessages,
} from "../lib/chatStreamRuntime.ts";

// ---------------------------------------------------------------------------
// The store that makes leaving a conversation mid-answer survivable. Every
// test here stands for a step of that journey: the answer keeps arriving in
// the conversation it was sent in, the panel that comes back adopts it, and
// nothing another conversation does can reach it.
// ---------------------------------------------------------------------------

const ACCOUNT = chatRuntimeIdentityKey({ kind: "account", userId: "user-1" });
const OTHER_ACCOUNT = chatRuntimeIdentityKey({
  kind: "account",
  userId: "user-2",
});
const GUEST = chatRuntimeIdentityKey({ kind: "guest" });

const keyFor = (conversationId, modelId = "gpt-5-4-mini", identityKey = ACCOUNT) =>
  chatRuntimeKey({ identityKey, conversationId, modelId });

const A = keyFor("conversation-a");
const B = keyFor("conversation-b");
const NEW = keyFor(null);

test.beforeEach(() => resetChatStreamRuntime());
test.after(() => resetChatStreamRuntime());

test("a key names an identity, a conversation and a model", () => {
  assert.equal(A, "account:user-1|conversation-a|gpt-5-4-mini");
  assert.equal(NEW, "account:user-1|new|gpt-5-4-mini");
  assert.equal(GUEST, "guest");
  assert.equal(chatRuntimeIdentityKey({ kind: "account", userId: null }), "account");
  assert.equal(chatRuntimeKeyIdentity(A), ACCOUNT);
  // Guest and account are separate namespaces even for the same conversation
  // id shape (docs/policy/chat-concurrency-and-identity.md §5).
  assert.notEqual(keyFor("c", "m", GUEST), keyFor("c", "m", ACCOUNT));
});

test("an untouched key reads as empty, on the client and on the server", () => {
  const snapshot = getChatRuntimeSnapshot(A);
  assert.deepEqual(snapshot.messages, []);
  assert.equal(snapshot.isLoaded, false);
  assert.equal(snapshot.isStreaming, false);
  // The same frozen value, so useSyncExternalStore never sees a new object for
  // a key nothing has written to.
  assert.equal(getChatRuntimeSnapshot(B), snapshot);
  assert.equal(getChatRuntimeServerSnapshot(), snapshot);
});

test("reading a key never creates it, so a render has no side effects", () => {
  getChatRuntimeSnapshot(A);
  isChatRuntimeStreaming(A);
  getChatRuntimeRevision(A);
  // Nothing above may have started a run or a load for A.
  assert.equal(ownsChatRuntimeTranscript(A), false);
  assert.equal(isChatRuntimeLoadInFlight(A), false);
});

test("a run keeps writing into the conversation it was sent in", () => {
  const controller = beginChatRuntimeRun(A);
  writeChatRuntimeMessages(A, [{ id: "m1", role: "assistant", content: "chunk0" }]);

  // The user opens another conversation; the run is untouched by that.
  writeChatRuntimeMessages(B, [{ id: "m2", role: "assistant", content: "elsewhere" }]);
  writeChatRuntimeMessages(A, (prev) => [
    { ...prev[0], content: `${prev[0].content} chunk1` },
  ]);

  assert.equal(getChatRuntimeSnapshot(A).messages[0].content, "chunk0 chunk1");
  assert.equal(getChatRuntimeSnapshot(B).messages[0].content, "elsewhere");
  assert.equal(isChatRuntimeStreaming(A), true);
  assert.equal(isChatRuntimeStreaming(B), false);

  endChatRuntimeRun(A, controller);
  assert.equal(isChatRuntimeStreaming(A), false);
});

test("subscribers of one key are not woken by another key", () => {
  let aNotifications = 0;
  let bNotifications = 0;
  const unsubscribeA = subscribeChatRuntime(A, () => {
    aNotifications += 1;
  });
  const unsubscribeB = subscribeChatRuntime(B, () => {
    bNotifications += 1;
  });

  writeChatRuntimeMessages(A, [{ id: "m1", role: "assistant", content: "x" }]);
  assert.equal(aNotifications, 1);
  assert.equal(bNotifications, 0);

  // An identical write is not a change, so it does not re-render.
  const unchanged = getChatRuntimeSnapshot(A).messages;
  writeChatRuntimeMessages(A, unchanged);
  assert.equal(aNotifications, 1);

  unsubscribeA();
  unsubscribeB();
  writeChatRuntimeMessages(A, []);
  assert.equal(aNotifications, 1);
});

test("the stop button of a panel that remounted stops the run that is going", () => {
  const controller = beginChatRuntimeRun(A);
  let aborted = false;
  controller.signal.addEventListener("abort", () => {
    aborted = true;
  });

  // The panel that started this is long gone; only the key is known.
  abortChatRuntime(A);
  assert.equal(aborted, true);

  // Idempotent, and harmless on a key with nothing running.
  abortChatRuntime(A);
  abortChatRuntime(B);
});

test("a settled run does not close a retry that already took the key", () => {
  const first = beginChatRuntimeRun(A);
  const second = beginChatRuntimeRun(A);

  endChatRuntimeRun(A, first);
  assert.equal(
    isChatRuntimeStreaming(A),
    true,
    "the predecessor must not mark the retry finished"
  );

  endChatRuntimeRun(A, second);
  assert.equal(isChatRuntimeStreaming(A), false);
});

test("only the newest load ticket may settle the view", () => {
  const stale = claimChatRuntimeLoad(A);
  const current = claimChatRuntimeLoad(A);

  assert.equal(isCurrentChatRuntimeLoad(A, stale), false);
  assert.equal(isCurrentChatRuntimeLoad(A, current), true);

  settleChatRuntimeLoad(A, stale, { loaded: true });
  assert.equal(getChatRuntimeSnapshot(A).isLoaded, false);
  assert.equal(isChatRuntimeLoadInFlight(A), true);

  settleChatRuntimeLoad(A, current, { loaded: true });
  assert.equal(getChatRuntimeSnapshot(A).isLoaded, true);
  assert.equal(isChatRuntimeLoadInFlight(A), false);
});

test("a failed load releases its claim so a later attempt can retry", () => {
  const requestId = claimChatRuntimeLoad(A);
  assert.equal(isChatRuntimeLoadInFlight(A), true);

  releaseChatRuntimeLoad(A, requestId);
  assert.equal(isChatRuntimeLoadInFlight(A), false);
  assert.equal(
    getChatRuntimeSnapshot(A).isLoaded,
    false,
    "a failed load must not claim the view is loaded"
  );
});

test("a transcript this session produced is never re-read from the server", () => {
  const requestId = claimChatRuntimeLoad(A);
  settleChatRuntimeLoad(A, requestId, { loaded: true });
  assert.equal(
    ownsChatRuntimeTranscript(A),
    false,
    "a plain server view may be refreshed"
  );

  // Still streaming: re-reading would overwrite the answer as it arrives.
  const controller = beginChatRuntimeRun(A);
  assert.equal(ownsChatRuntimeTranscript(A), true);

  // Finished, but locally produced: re-reading could replace it with a server
  // copy written before the answer landed, so the answer would appear, vanish
  // and (on the next load) appear again.
  advanceChatRuntimeRevision(A);
  endChatRuntimeRun(A, controller);
  assert.equal(ownsChatRuntimeTranscript(A), true);
  assert.equal(getChatRuntimeRevision(A), 1);
});

test("an unloaded key is never treated as owning a transcript", () => {
  beginChatRuntimeRun(A);
  advanceChatRuntimeRevision(A);
  assert.equal(
    ownsChatRuntimeTranscript(A),
    false,
    "a load still on its way must be allowed to settle the view"
  );
});

test("a deep-research job is re-attached to once, not once per remount", () => {
  assert.equal(hasResumedChatRuntimeJob(A, "job-1"), false);
  markChatRuntimeJobResumed(A, "job-1");
  assert.equal(hasResumedChatRuntimeJob(A, "job-1"), true);
  // A different conversation's panel has its own job to watch.
  assert.equal(hasResumedChatRuntimeJob(B, "job-1"), false);
});

test("the last prompt to retry belongs to one conversation", () => {
  setChatRuntimeLastPrompt(A, {
    text: "ask again",
    targetChatId: "conversation-a",
    attachments: [],
  });

  assert.equal(getChatRuntimeLastPrompt(A)?.text, "ask again");
  assert.equal(getChatRuntimeLastPrompt(B), null);
});

test("an identity change drops the previous identity's keys and aborts its runs", () => {
  const mine = keyFor("conversation-a", "gpt-5-4-mini", ACCOUNT);
  const theirs = keyFor("conversation-x", "gpt-5-4-mini", OTHER_ACCOUNT);
  const guest = keyFor("guest_1", "gpt-5-4-mini", GUEST);

  writeChatRuntimeMessages(mine, [{ id: "m", role: "assistant", content: "mine" }]);
  writeChatRuntimeMessages(theirs, [{ id: "m", role: "assistant", content: "theirs" }]);
  const guestController = beginChatRuntimeRun(guest);
  let guestAborted = false;
  guestController.signal.addEventListener("abort", () => {
    guestAborted = true;
  });

  releaseChatRuntimeForOtherIdentities(ACCOUNT);

  assert.equal(getChatRuntimeSnapshot(mine).messages[0].content, "mine");
  assert.deepEqual(getChatRuntimeSnapshot(theirs).messages, []);
  assert.deepEqual(getChatRuntimeSnapshot(guest).messages, []);
  assert.equal(guestAborted, true);
  assert.equal(isChatRuntimeStreaming(guest), false);
});

test("a streaming key is retained however many other conversations are opened", () => {
  const streaming = keyFor("streaming-conversation");
  beginChatRuntimeRun(streaming);
  writeChatRuntimeMessages(streaming, [
    { id: "m", role: "assistant", content: "still arriving" },
  ]);

  // Far past the retention cap: every one of these is idle and unsubscribed,
  // so they are what gets dropped -- never the answer still being written.
  for (let index = 0; index < 200; index += 1) {
    const key = keyFor(`browsed-${index}`);
    const requestId = claimChatRuntimeLoad(key);
    settleChatRuntimeLoad(key, requestId, { loaded: true });
    writeChatRuntimeMessages(key, [
      { id: "m", role: "assistant", content: `browsed ${index}` },
    ]);
  }

  assert.equal(isChatRuntimeStreaming(streaming), true);
  assert.equal(
    getChatRuntimeSnapshot(streaming).messages[0].content,
    "still arriving"
  );
});
