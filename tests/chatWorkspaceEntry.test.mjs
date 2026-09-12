import assert from "node:assert/strict";
import test from "node:test";
import { chatDraftMatchesSubmission, chatPreparedSendIsCurrent, chatSingleModelRefusal, decideChatWorkspaceEntry } from "../lib/chatWorkspaceEntry.ts";
import { conversationHandoffHref, conversationSurface, surfaceHasContinuationBridge } from "../lib/continuationRoutes.ts";

test("stored Chat routes additively while bridge, legacy and Review remain on their own surfaces", () => {
  assert.equal(conversationSurface({ productKey: "chat", hasContinuationBridge: false }), "chat");
  assert.equal(conversationSurface({ productKey: "chat", hasContinuationBridge: true }), "continuation");
  assert.equal(conversationSurface({ productKey: null, hasContinuationBridge: false }), "workspace");
  assert.equal(conversationSurface({ productKey: "review", hasContinuationBridge: false }), "workspace");
  assert.equal(conversationSurface({ productKey: "studio", hasContinuationBridge: false }), "workspace");
  assert.equal(conversationHandoffHref("chat", "a/b", "/chat"), "/chat/workspace?conversation=a%2Fb");
  assert.equal(surfaceHasContinuationBridge("chat"), false);
});
test("an offered gate is not ownership and legacy product is not Chat authority", () => {
  assert.deepEqual(decideChatWorkspaceEntry({ authenticated: true, requestedConversation: true, ownedConversation: null, offered: true }), { action: "not_found" });
  assert.deepEqual(decideChatWorkspaceEntry({ authenticated: true, requestedConversation: true, ownedConversation: { productKey: null, hasContinuationBridge: false }, offered: true }), { action: "redirect", surface: "workspace" });
});
test("single-model admission refuses original multi-choice without mutating it", () => {
  const selectedModels = Object.freeze(["a", "b"]);
  assert.equal(chatSingleModelRefusal({ productKey: "chat", selectedModels, fromProfile: true }), "CHAT_PROFILE_SINGLE_MODEL_REQUIRED");
  assert.equal(chatSingleModelRefusal({ productKey: "review", selectedModels, fromProfile: false }), null);
  assert.deepEqual(selectedModels, ["a", "b"]);
});
const prepared = {
  identityKey: "account:a", currentIdentityKey: "account:a",
  conversationId: "chat-a", currentConversationId: "chat-a",
  modelIds: ["model-a"], currentModelIds: ["model-a"], currentDisabledIds: [],
};
test("prepared Chat send requires the same identity, conversation and exact enabled singleton", () => {
  assert.equal(chatPreparedSendIsCurrent(prepared), true);
  for (const changed of [
    { identityKey: null }, { currentIdentityKey: "account:b" },
    { currentConversationId: "chat-b" }, { currentConversationId: null },
    { modelIds: [] }, { modelIds: ["model-a", "model-b"] },
    { currentModelIds: ["model-b"] }, { currentModelIds: ["model-a", "model-b"] },
    { currentDisabledIds: ["model-a"] },
  ]) assert.equal(chatPreparedSendIsCurrent({ ...prepared, ...changed }), false, JSON.stringify(changed));
});
test("only the consumed draft may clear; edits, added/removed/reordered files remain", () => {
  const draft = { submittedText: "Question  ", currentText: "Question  ", submittedAttachmentIds: ["file-a", "file-b"], currentAttachmentIds: ["file-a", "file-b"] };
  assert.equal(chatDraftMatchesSubmission(draft), true);
  for (const changed of [
    { currentText: "Question" }, { currentText: "Next question" },
    { currentAttachmentIds: [] }, { currentAttachmentIds: ["file-a"] },
    { currentAttachmentIds: ["file-a", "file-b", "file-c"] },
    { currentAttachmentIds: ["file-b", "file-a"] },
  ]) assert.equal(chatDraftMatchesSubmission({ ...draft, ...changed }), false);
});
