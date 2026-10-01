import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { chatDraftMatchesSubmission, chatPreparedSendIsCurrent, chatSingleModelRefusal, decideChatWorkspaceEntry, newWorkspaceDraftModels } from "../lib/chatWorkspaceEntry.ts";
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
test("a new Chat draft uses the first effective default without rewriting the stored combination", () => {
  const models = Object.freeze(["model-b", "model-a", "model-c"]);
  assert.deepEqual(newWorkspaceDraftModels({ surface: "chat", models, fallbackModelId: "fallback" }), ["model-b"]);
  for (const surface of ["workspace", "continuation"]) {
    assert.deepEqual(newWorkspaceDraftModels({ surface, models, fallbackModelId: "fallback" }), models);
  }
  assert.deepEqual(newWorkspaceDraftModels({ surface: "chat", models: [], fallbackModelId: "fallback" }), ["fallback"]);
  assert.deepEqual(models, ["model-b", "model-a", "model-c"]);
  assert.equal(chatSingleModelRefusal({ productKey: "chat", selectedModels: models, fromProfile: true }), "CHAT_PROFILE_SINGLE_MODEL_REQUIRED");
});
const prepared = {
  identityKey: "account:a", currentIdentityKey: "account:a",
  conversationId: "chat-a", currentConversationId: "chat-a",
  modelIds: ["model-a"], currentModelIds: ["model-a"], currentDisabledIds: [],
  selectionTicket: 1, currentSelectionTicket: 1,
};
test("prepared Chat send requires the same identity, conversation and exact enabled singleton", () => {
  assert.equal(chatPreparedSendIsCurrent(prepared), true);
  for (const changed of [
    { identityKey: null }, { currentIdentityKey: "account:b" },
    { currentConversationId: "chat-b" }, { currentConversationId: null },
    { modelIds: [] }, { modelIds: ["model-a", "model-b"] },
    { currentModelIds: ["model-b"] }, { currentModelIds: ["model-a", "model-b"] },
    { currentDisabledIds: ["model-a"] },
    { currentSelectionTicket: 2 },
  ]) assert.equal(chatPreparedSendIsCurrent({ ...prepared, ...changed }), false, JSON.stringify(changed));
});
test("an explicit New Chat invalidates an old same-null preparation even with the same model", () => {
  const fresh = { ...prepared, conversationId: null, currentConversationId: null };
  assert.equal(chatPreparedSendIsCurrent(fresh), true);
  assert.equal(chatPreparedSendIsCurrent({ ...fresh, currentSelectionTicket: 2 }), false);
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

// Execute the actual private callbacks without mounting the entire page or
// adding a production-only test API. AST selection fails if the handler moves.
const parseSource = (path) => ts.createSourceFile(path,
  readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const findNodes = (source, predicate) => {
  const matches = [];
  const visit = (node) => { if (predicate(node)) matches.push(node); ts.forEachChild(node, visit); };
  visit(source);
  return matches;
};
const executable = (node, source, context) => vm.runInNewContext(ts.transpileModule(
  `(${node.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText, context);
const pageSource = parseSource("../app/(site)/(application)/chat/ChatPageClient.tsx");
const pageHandler = (name, context) => {
  const matches = findNodes(pageSource, (node) => ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) && node.name.text === name);
  assert.equal(matches.length, 1, `${name} must identify the actual page handler`);
  assert.ok(matches[0].initializer && ts.isArrowFunction(matches[0].initializer));
  return executable(matches[0].initializer, pageSource, context);
};

test("actual Chat remove handlers refuse before confirmation, selection mutation or history deletion", async () => {
  const events = [];
  const context = {
    mountedSurface: "chat", selectedModels: { filter: () => { events.push("selection-read"); return []; } },
    disabledPanels: { filter: () => { events.push("disabled-read"); return []; } },
    currentChatId: "chat-owned", setPendingRemoveModelId: () => events.push("confirmation"),
    mutateModelSettings: () => events.push("mutation"), accountConversationId: (id) => id,
    fetch: async () => { events.push("DELETE"); return {}; }, discardResponseBody: async () => {},
  };
  await pageHandler("handleRemoveModel", context)("model-a");
  await pageHandler("executeRemoveModel", context)("model-a");
  assert.deepEqual(events, []);
});

test("actual Review remove handlers retain confirmation, model mutation and model-scoped DELETE", async () => {
  const events = [];
  const context = {
    mountedSurface: "workspace", selectedModels: ["model-a", "model-b"], disabledPanels: ["model-a"],
    currentChatId: "review-owned", setPendingRemoveModelId: (id) => events.push(["confirmation", id]),
    mutateModelSettings: (id, models, disabled) => events.push(["mutation", id, models, disabled]),
    accountConversationId: (id) => id,
    fetch: async (url, options) => { events.push([options.method, url]); return {}; },
    discardResponseBody: async () => {},
  };
  await pageHandler("handleRemoveModel", context)("model-a");
  await pageHandler("executeRemoveModel", context)("model-a");
  assert.deepEqual(events, [["confirmation", "model-a"], ["mutation", "review-owned", ["model-b"], []],
    ["DELETE", "/api/conversations/review-owned/messages?modelId=model-a"]]);
});

for (const shell of ["DesktopChatShell", "MobileChatShell"]) {
  test(`${shell} recovery captures the actual button even when focus and the nested click target differ`, () => {
    class FocusTarget {}
    const trigger = new FocusTarget();
    const previouslyFocused = new FocusTarget();
    const nestedIcon = { parentElement: trigger };
    const path = `../components/chat/${shell}.tsx`;
    const source = parseSource(path);
    const attributes = findNodes(source, (node) => ts.isJsxAttribute(node) && node.name.getText(source) === "onRequestCloseModel");
    assert.equal(attributes.length, 1);
    const expression = attributes[0].initializer.expression;
    for (const singleTranscript of [true, false]) {
      const events = [];
      const click = { currentTarget: trigger, target: nestedIcon };
      const handler = executable(expression, source, { singleTranscript, modelId: "model-a", HTMLElement: FocusTarget,
        document: { activeElement: previouslyFocused }, openChatModelPicker: (target) => events.push(["picker", target]),
        onToggleModel: (id) => events.push(["toggle", id]),
      });
      handler(singleTranscript ? click : undefined);
      // React's currentTarget is only available during dispatch. Keep the node,
      // not the event, for the later close operation. Review needs no event.
      click.currentTarget = null;
      assert.deepEqual(events, singleTranscript ? [["picker", trigger]] : [["toggle", "model-a"]]);
      if (singleTranscript) assert.equal(events[0][1], trigger);
    }
    assert.ok(findNodes(source, (node) => ts.isImportDeclaration(node) &&
      node.moduleSpecifier.text === "@/lib/chatModelPickerEvents").length > 0);
  });
}
