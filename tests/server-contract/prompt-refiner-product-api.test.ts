import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const scopeId = "11111111-1111-4111-8111-111111111111";
const suggestionId = "22222222-2222-4222-8222-222222222222";
const clientRequestId = "33333333-3333-4333-8333-333333333333";
let mode: "explicit" | "auto" | null = null;
let captures = 0;

mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => {},
  readLimitedJson: async (request: Request, _limit: number, schema: {
    safeParse: (value: unknown) => { success: boolean; data?: unknown };
  }) => {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) throw Object.assign(new Error("invalid"),
      { status: 400, code: "INVALID_REQUEST" });
    return parsed.data;
  },
  apiSecurityResponse: (error: unknown) => {
    const problem = error as { status?: number; code?: string };
    return problem.status ? Response.json({ code: problem.code },
      { status: problem.status }) : null;
  },
} });
mock.module(mod("lib/conversationLock.ts"), { namedExports: {
  hasConversationUnlockGrant: () => true,
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  conversation: { findFirst: async () => ({ password: null }) },
} } });
mock.module(mod("lib/promptRefinerChatExecutionRelease.ts"), { namedExports: {
  promptRefinerChatExecutionRelease: async () => ({
    explicitEnabled: true, autoEnabled: true,
  }),
} });
mock.module(mod("lib/promptRefinerChatExecutionStore.ts"), { namedExports: {
  advancePromptRefinerChatScope: async () => ({ id: scopeId, epoch: 4 }),
  capturePromptRefinerChatDraft: async (input: unknown) => {
    captures += 1;
    return Object.freeze({ ...(input as object), sourcePrompt: "server draft" });
  },
} });
mock.module(mod("lib/promptRefinerProductService.ts"), { namedExports: {
  preparePromptRefinerProductSuggestion: async (input: {
    mode: "explicit" | "auto";
  }) => {
    mode = input.mode;
    return { outcome: "held", held: {
      requestId: "44444444-4444-4444-8444-444444444444",
      suggestionId, refinedPrompt: "server validated suggestion",
      refinerVersion: "suggest-v2",
      inputScope: "current_user_turn_text_only",
      scopeId, epoch: 4, clientRequestId, executionReceiptId: "receipt",
    } };
  },
} });

const apiPromise = import(mod("lib/promptRefinerProductApi.ts"));
const request = (path: string, body: object) => new Request(
  `http://localhost${path}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const proposal = { conversationId: "conversation", scopeId, epoch: 4,
  draftRevision: 7 };

test("proposal API rejects browser prompt/suggestion authority before capture", async () => {
  const api = await apiPromise;
  const before = captures;
  let response: Response;
  try {
    response = await api.handlePromptRefinerProductProposal(
      request("/api/chat/prompt-refiner/proposal", {
        ...proposal, refinedPrompt: "browser supplied", decision: true,
      }), "owner");
  } catch (error) {
    response = api.promptRefinerProductApiErrorResponse(error);
  }
  assert.equal(response.status, 400);
  assert.equal(captures, before);
});

test("explicit proposal returns only the server-held result", async () => {
  const api = await apiPromise;
  const response = await api.handlePromptRefinerProductProposal(
    request("/api/chat/prompt-refiner/proposal", proposal), "owner");
  assert.equal(response.status, 200);
  assert.equal(mode, "explicit");
  assert.deepEqual(await response.json(), {
    requestId: "44444444-4444-4444-8444-444444444444",
    suggestionId, refinedPrompt: "server validated suggestion",
    refinerVersion: "suggest-v2", inputScope: "current_user_turn_text_only",
    scopeId, epoch: 4, clientRequestId,
  });
});

test("automatic prepare chooses auto on the server and hides proposal text", async () => {
  const api = await apiPromise;
  const response = await api.handlePromptRefinerProductPrepare(
    request("/api/chat/prompt-refiner/prepare", proposal), "owner");
  assert.equal(response.status, 200);
  assert.equal(mode, "auto");
  const value = await response.json();
  assert.deepEqual(value, { outcome: "auto_held", decision: {
    suggestionId, scopeId, epoch: 4, decision: "accepted",
  }, clientRequestId });
  assert.equal(JSON.stringify(value).includes("validated suggestion"), false);
});

test("scope API admits stored Chat only", async () => {
  const api = await apiPromise;
  const workspace = await api.handlePromptRefinerProductScope(
    request("/api/chat/prompt-refiner/scope", {
      mountId: clientRequestId, conversationId: "conversation",
      surface: "workspace",
    }), "owner");
  assert.equal(workspace.status, 409);
  const chat = await api.handlePromptRefinerProductScope(
    request("/api/chat/prompt-refiner/scope", {
      mountId: clientRequestId, conversationId: "conversation", surface: "chat",
    }), "owner");
  assert.equal(chat.status, 200);
  assert.deepEqual(await chat.json(), { scopeId, epoch: 4 });
});

