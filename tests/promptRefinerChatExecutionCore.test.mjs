import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { validatePromptRefinerChatExecution, promptRefinerChatDecisionSchema } from "../lib/promptRefinerChatExecutionCore.ts";
import { promptRefinerChatExecutionRelease } from "../lib/promptRefinerChatExecutionRelease.ts";
import { scopedMessageId } from "../lib/messageRequestIdentity.ts";
import { profileTextFor, preflightInputEstimate } from "../lib/autoDispatchPreflight.ts";

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const original = "  Cafe\u0301 한글 🙂\r\nvoice transcript / search / file request  ";
const refined = "  Compare Cafe\u0301 한글 🙂 and cite the attached file.\r\nKeep every constraint.  ";
const fixture = () => {
  const attachments = [{ uploadId: "image" }, { attachmentId: "document" }];
  const messages = Object.freeze([
    Object.freeze({ id: "history", role: "user", content: "Earlier text", attachments }),
    Object.freeze({ id: "answer", role: "assistant", content: "Earlier answer" }),
    Object.freeze({ id: uuid(3), role: "user", content: original, attachments }),
  ]);
  return { messages, decision: { suggestionId: uuid(1), scopeId: uuid(2), epoch: 4, decision: "accepted" },
    held: { id: uuid(1), userId: "owner", conversationId: "conversation", surface: "chat", scopeId: uuid(2),
      scopeEpoch: 4, recoveryEpoch: 1, sourceMessageId: uuid(3), sourcePrompt: original, refinedPrompt: refined,
      requestId: uuid(4), refinerVersion: "suggest-v2", mode: "explicit", state: "ready",
      expiresAt: new Date("2026-10-09T14:05:00Z") },
    facts: { userId: "owner", conversationId: "conversation", sourceMessageId: uuid(3), persistedSourcePrompt: original,
      recoveryEpoch: 1, scope: { id: uuid(2), epoch: 4, surface: "chat", conversationId: "conversation" },
      dbNow: new Date("2026-10-09T14:00:00Z"), explicitEnabled: true, autoEnabled: false,
      autoConversation: true, killSwitch: false } };
};
const refuse = input => assert.throws(() => validatePromptRefinerChatExecution(input), error =>
  error.code === "PROMPT_REFINER_DECISION_UNAVAILABLE" && error.status === 409 && !error.message.includes(original));

test("explicit adoption changes only current execution text; history, files and authored bytes remain", () => {
  const input = fixture(); const view = validatePromptRefinerChatExecution(input);
  assert.equal(view.authoredMessages, input.messages);
  assert.equal(view.authoredMessages.at(-1).content, original);
  assert.equal(view.executionMessages.at(-1).content, refined);
  assert.equal(view.executionMessages.at(-1).attachments, input.messages.at(-1).attachments);
  assert.equal(view.executionMessages[0], input.messages[0]);
  assert.equal(view.executionMessages[1], input.messages[1]);
  assert.equal(profileTextFor(view.executionMessages), refined);
  assert.notDeepEqual(preflightInputEstimate(view.executionMessages), preflightInputEstimate(input.messages));
});
test("keep-original resolves the decision while retaining the authored view", () => {
  const input = fixture(); input.decision.decision = "kept_original";
  const view = validatePromptRefinerChatExecution(input);
  assert.equal(view.executionMessages, input.messages);
});
test("automatic mode needs separate server authority and Auto conversation", () => {
  const input = fixture(); input.held.mode = "auto"; refuse(input);
  input.facts.autoEnabled = true;
  assert.equal(validatePromptRefinerChatExecution(input).executionMessages.at(-1).content, refined);
  input.facts.autoConversation = false; refuse(input);
  input.held.mode = "explicit"; input.facts.explicitEnabled = false; refuse(input);
});
test("the checked-in release has neither explicit nor automatic activation", () => {
  assert.deepEqual(promptRefinerChatExecutionRelease(), { explicitEnabled: false, autoEnabled: false });
});
for (const [name, modify] of [
  ["replay", x => { x.held.state = "consumed"; }],
  ["invalidated draft", x => { x.held.state = "stale"; }],
  ["cross-account", x => { x.facts.userId = "another-owner"; }],
  ["cross-conversation", x => { x.facts.conversationId = "another-conversation"; }],
  ["surface change", x => { x.facts.scope.surface = "workspace"; }],
  ["same-value scope ABA", x => { x.facts.scope.epoch = 6; }],
  ["mount change", x => { x.facts.scope.id = uuid(9); }],
  ["history clear epoch", x => { x.facts.recoveryEpoch = 2; }],
  ["source message mismatch", x => { x.held.sourceMessageId = uuid(8); }],
  ["persisted source changed", x => { x.facts.persistedSourcePrompt += " "; }],
  ["exact expiry", x => { x.facts.dbNow = x.held.expiresAt; }],
  ["invalid clock", x => { x.facts.dbNow = new Date(NaN); }],
  ["kill switch", x => { x.facts.killSwitch = true; }],
  ["forged proposal", x => { x.decision.refinedPrompt = "Browser text"; }],
  ["forged boolean", x => { x.decision = { accepted: true }; }],
  ["invalid held mode", x => { x.held.mode = "anything"; }],
  ["suggestion id mismatch", x => { x.decision.suggestionId = uuid(7); }],
  ["revision decision mismatch", x => { x.decision.epoch = 3; }],
]) test(`${name} refuses without execution or disclosure`, () => { const input = fixture(); modify(input); refuse(input); });
test("empty, duplicate-id, edited and trailing assistant transcripts refuse", () => {
  for (const messages of [[], [fixture().messages.at(-1), fixture().messages.at(-1)],
    [...fixture().messages.slice(0, 2), { ...fixture().messages.at(-1), content: original + "edit" }],
    [...fixture().messages, { id: "trailing", role: "assistant", content: "reply" }]]) {
    refuse({ ...fixture(), messages });
  }
});
test("legacy client request id remains scoped and is never rewritten in either view", () => {
  const input = fixture(); input.held.sourceMessageId = scopedMessageId("conversation", uuid(3));
  input.facts.sourceMessageId = input.held.sourceMessageId;
  assert.equal(validatePromptRefinerChatExecution(input).executionMessages.at(-1).id, uuid(3));
});
test("public decision has ids and a choice only", () => {
  assert.equal(promptRefinerChatDecisionSchema.safeParse(fixture().decision).success, true);
  assert.equal(promptRefinerChatDecisionSchema.safeParse({ ...fixture().decision, mode: "auto" }).success, false);
});
test("Router, shadow and provider formatting use the consumed view; signed context and source validation stay authored", () => {
  const route = readFileSync("app/api/chat/route.ts", "utf8");
  assert.match(route, /executionMessages = \[\.\.\.view.executionMessages\]/);
  assert.match(route, /const autoRoutingMessages = executionMessages/);
  assert.match(route, /reservedInputTokens: preflightInputEstimate\(autoRoutingMessages\)/);
  assert.equal((route.match(/text: profileTextFor\(autoRoutingMessages\)/g) ?? []).length, 2);
  assert.match(route, /const latestMessage = executionMessages\[executionMessages.length - 1\]/);
  assert.match(route, /query: latestUserPromptText\(messages\)/);
  assert.match(route, /for \(const msg of executionMessages\)/);
  assert.match(route, /verifyDurableChatSourceMessage\(\{[\s\S]*?messages,\s*\}\)/);
  assert.match(route, /chatResponseAttemptRequestPayloadDigest\(\{[\s\S]*?messages: executionMessages/);
});
