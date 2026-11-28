import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { reviewTurnInput } from "../src/chat-contract";

test("A Review turn may carry the chosen plugin, but never with Deep Research or a one-model follow-up", () => {
  const base = { requestId: randomUUID(), prompt: "Compare", mode: "professional", choices: ["gpt-6-luna", "claude-opus-5-5"], effort: "default",
    attachmentUploadIds: [] } as const;
  assert.equal(reviewTurnInput.safeParse({ ...base, mcpConnectionId: "connection_1" }).success, true);
  assert.equal(reviewTurnInput.safeParse({ ...base, mcpConnectionId: "../x" }).success, false);
  assert.equal(reviewTurnInput.safeParse({ ...base, mcpConnectionId: "connection_1", deepResearchDepth: "quick" }).success, false);
  assert.equal(reviewTurnInput.safeParse({ ...base, conversationId: "c1", choices: ["gpt-6-luna"], onlyModelId: "gpt-6-luna",
    mcpConnectionId: "connection_1" }).success, false);
});
