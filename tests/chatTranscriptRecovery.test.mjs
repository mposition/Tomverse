import assert from "node:assert/strict";
import test from "node:test";
import { answeringModelId, recoveryPromptForMessage, transcriptMessagesForScope } from "../lib/chatTranscriptRecovery.ts";
import * as transcriptRecovery from "../lib/chatTranscriptRecovery.ts";
import { toChatRequestMessage } from "../lib/chatMessageSerialization.ts";
import { abortChatRuntime, advanceChatRuntimeRevision, beginChatRuntimeRun, chatRuntimeKey,
  claimChatRuntimeLoad, getChatRuntimeRevision, getChatRuntimeSnapshot, isChatRuntimeStreaming,
  isCurrentChatRuntimeLoad, resetChatStreamRuntime, settleChatRuntimeLoad,
  writeChatRuntimeMessages, releaseChatRuntimeForOtherIdentities } from "../lib/chatStreamRuntime.ts";

const key = (modelId, transcriptScope = "conversation", identityKey = "account:a", conversationId = "c") =>
  chatRuntimeKey({ identityKey, conversationId, modelId, transcriptScope });
const messages = [
  { id: "u1", role: "user", content: "First question" },
  { id: "a1", role: "assistant", modelId: "model-a", content: "Partial\n\nMore", status: "error" },
  { id: "u2", role: "user", modelId: "model-b", content: "Later question" },
  { id: "a2", role: "assistant", modelId: "model-b", content: "Finished", status: "normal" },
];
test.beforeEach(() => resetChatStreamRuntime());
test.after(() => resetChatStreamRuntime());

test("Chat runtime survives model selection and cannot collide with Review model keys", () => {
  assert.equal(key("model-a"), key("model-b"));
  assert.notEqual(key("model-a"), key("model-a", "model"));
  assert.notEqual(key("model-a"), key("@conversation", "model"));
  assert.notEqual(key("model-a"), key("transcript", "model"));
  assert.equal(key("model-a", "model"), "account:a|c|model-a");
});
test("selection changes adopt the same messages, busy controller and late-load revision", () => {
  const a = key("model-a"), b = key("model-b");
  const ticket = claimChatRuntimeLoad(a);
  settleChatRuntimeLoad(a, ticket, { loaded: true });
  const before = getChatRuntimeRevision(a);
  const controller = beginChatRuntimeRun(a);
  advanceChatRuntimeRevision(a);
  writeChatRuntimeMessages(a, messages);
  assert.equal(isCurrentChatRuntimeLoad(b, ticket), true);
  assert.notEqual(getChatRuntimeRevision(b), before);
  assert.equal(getChatRuntimeSnapshot(b).messages, messages);
  assert.equal(isChatRuntimeStreaming(b), true);
  assert.equal(isChatRuntimeStreaming(key("model-a", "model")), false);
  abortChatRuntime(b, "user_stop");
  assert.equal(controller.signal.aborted, true);
});
test("Chat conversation and identity namespaces remain isolated", () => {
  const a = key("model-a");
  const controller = beginChatRuntimeRun(a);
  writeChatRuntimeMessages(a, messages);
  assert.equal(getChatRuntimeSnapshot(key("model-a", "conversation", "account:b")).messages.length, 0);
  assert.equal(getChatRuntimeSnapshot(key("model-a", "conversation", "account:a", "other")).messages.length, 0);
  releaseChatRuntimeForOtherIdentities("account:b");
  assert.equal(controller.signal.aborted, true);
  assert.equal(getChatRuntimeSnapshot(a).messages.length, 0);
});
test("Chat loads every model once; Review retains model-filtered history", () => {
  assert.deepEqual(transcriptMessagesForScope([...messages, messages[0]], "model-b", "conversation"), messages);
  assert.deepEqual(transcriptMessagesForScope(messages, "model-a", "model").map(x => x.id), ["u1", "a1"]);
});
test("recovery restores the selected failed question, never the later last question", () => {
  assert.deepEqual(recoveryPromptForMessage(messages, "a1", "c"), {
    text: "First question", attachments: [], targetChatId: "c",
  });
  assert.equal(recoveryPromptForMessage(messages, "a2", "c"), null);
});
test("reloaded trailing question can be restored without inferring failure or generating", () => {
  assert.equal(recoveryPromptForMessage(messages.slice(0, 3), "u2", "c").text, "Later question");
  assert.equal(recoveryPromptForMessage(messages, "u1", "c"), null);
  assert.equal(recoveryPromptForMessage(messages, "missing", "c"), null);
  assert.equal(recoveryPromptForMessage(messages, "a1", null), null);
});
test("restoration carries an attachment-only question and preserves imported boundaries", () => {
  const attachment = { id: "att", name: "notes.txt", mediaType: "text/plain", size: 4,
    kind: "file", attachmentId: "stored" };
  const rows = [{ ...messages[0], content: "", attachments: [attachment] }, messages[1]];
  const restored = recoveryPromptForMessage(rows, "a1", "c");
  assert.equal(restored.text, "");
  assert.deepEqual(restored.attachments, [attachment]);
  assert.notEqual(restored.attachments[0], attachment);
  assert.equal(recoveryPromptForMessage([{ ...messages[0], imported: { provider: "openai" } }, messages[1]], "a1", "c"), null);
});
test("actual answering model uses fallback then routed then requested precedence", () => {
  assert.equal(answeringModelId({ requestedModelId: "a", routedModelId: "b", retryingWithModelId: "c" }), "c");
  assert.equal(answeringModelId({ requestedModelId: "a", routedModelId: "b" }), "b");
  assert.equal(answeringModelId({ requestedModelId: "a" }), "a");
});

test("Chat request omits empty assistant placeholders without deleting their UI history or attachment-only turns", () => {
  const attachment = { id: "file", name: "notes.txt", mediaType: "text/plain", size: 4,
    kind: "file", attachmentId: "stored-file" };
  const currentUser = { id: "retry", role: "user", content: "Specific question" };
  const rows = [
    { id: "welcome", role: "assistant", content: "Welcome" },
    { id: "original", role: "user", content: "Specific question" },
    { id: "error", role: "assistant", content: "", status: "error", recoveryNotice: "Unable to connect" },
    { id: "cancelled", role: "assistant", content: " \n", status: "cancelled" },
    { id: "partial", role: "assistant", content: "Kept partial", status: "error", recoveryNotice: "Interrupted" },
    { id: "file-only", role: "user", content: "", attachments: [attachment] },
    { id: "assistant-file", role: "assistant", content: "", attachments: [attachment] },
    currentUser,
  ];
  writeChatRuntimeMessages(key("a"), rows);
  const outgoing = transcriptRecovery.requestTranscriptForScope(rows, currentUser, "conversation").map(toChatRequestMessage);
  assert.deepEqual(outgoing.map(row => row.id), ["original", "partial", "file-only", "assistant-file", "retry"]);
  assert.equal(outgoing.find(row => row.id === "partial").content, "Kept partial");
  assert.equal("recoveryNotice" in outgoing.find(row => row.id === "partial"), false);
  assert.equal(outgoing.find(row => row.id === "file-only").attachments[0].attachmentId, "stored-file");
  assert.equal(getChatRuntimeSnapshot(key("a")).messages, rows);
  assert.equal(rows.find(row => row.id === "error").status, "error");
  // Review keeps its existing outbound semantics; current-user deduplication
  // remains by id, not by text that a user may deliberately repeat.
  assert.deepEqual(transcriptRecovery.requestTranscriptForScope(rows, currentUser, "model").map(row => row.id),
    ["original", "error", "cancelled", "partial", "file-only", "assistant-file", "retry"]);
});

test("recovery index preserves imported boundaries, blank questions, duplicate ids and the last unanswered user", () => {
  const rows = [
    { id: "orphan", role: "assistant", content: "", status: "error" },
    { id: "u1", role: "user", content: "First" },
    { id: "a1", role: "assistant", content: "partial", status: "error" },
    { id: "a2", role: "assistant", content: "partial", status: "cancelled" },
    { id: "import", role: "assistant", content: "Imported", imported: { provider: "openai" } },
    { id: "after-import", role: "assistant", content: "", status: "error" },
    { id: "blank", role: "user", content: " " },
    { id: "after-blank", role: "assistant", content: "", status: "error" },
    { id: "u1", role: "user", content: "Duplicate id, last question" },
  ];
  const indexed = transcriptRecovery.recoveryPromptsForMessages(rows, "c");
  assert.deepEqual([...indexed.keys()], ["a1", "a2"]);
  assert.equal(indexed.get("a1").text, "First");
  assert.equal(indexed.get("a2").text, "First");
  assert.equal(indexed.get("missing"), undefined);
  assert.equal(transcriptRecovery.recoveryPromptsForMessages(rows, null).size, 0);
  const trailing = [...rows, { id: "last", role: "user", content: "Last question" }];
  assert.equal(transcriptRecovery.recoveryPromptsForMessages(trailing, "c").get("last").text, "Last question");
  assert.equal(recoveryPromptForMessage(trailing, "last", "c").text, "Last question");
});

test("recovery index reads transcript entries once rather than once per rendered message", () => {
  const rows = Array.from({ length: 1000 }, (_, index) => ({ id: `m${index}`,
    role: index % 2 ? "assistant" : "user", content: "text", status: index % 2 ? "error" : "normal" }));
  let indexedReads = 0;
  const observed = new Proxy(rows, { get(target, property, receiver) {
    if (/^\d+$/.test(String(property))) indexedReads++;
    return Reflect.get(target, property, receiver);
  } });
  const indexed = transcriptRecovery.recoveryPromptsForMessages(observed, "c");
  assert.equal(indexed.size, 500);
  assert.ok(indexedReads <= rows.length * 2, `${indexedReads} indexed reads for ${rows.length} messages`);
});
