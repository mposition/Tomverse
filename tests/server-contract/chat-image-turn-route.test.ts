// Contract: POST /api/conversations/[id]/image-turn is signed-in only, takes a
// strict body, and passes refusals from the image turn through as they are.

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.NEXTAUTH_SECRET ||= "chat-image-turn-contract-secret-2026";

let sessionOverride: unknown = null;
let refusal: { status: number; code: string } | null = null;
const turns: Array<Record<string, unknown>> = [];
let mocksInstalled = false;

async function loadRoute() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<string, unknown>;
    const { ChatAccessError } = require(resolve(ROOT, "lib/chatSecurity.ts")) as {
      ChatAccessError: new (status: number, code: string, message: string) => Error;
    };
    mock.module("next-auth/next", {
      namedExports: { getServerSession: async () => sessionOverride },
    });
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => undefined },
    });
    mock.module(mod("lib/chatImageTurn.ts"), {
      namedExports: {
        startChatImageTurn: async (input: Record<string, unknown>) => {
          turns.push(input);
          if (refusal) throw new ChatAccessError(refusal.status, refusal.code, "refused");
          return {
            groupId: "group-1",
            imageModelIds: ["gpt-image-2"],
            content: "[Image generated] cat",
            pendingGenerationIds: [],
          };
        },
      },
    });
    mock.module(mod("lib/imageGenerationService.ts"), {
      namedExports: { processImageGenerationGroup: async () => undefined },
    });
  }
  return import(mod("app/api/conversations/[conversationId]/image-turn/route.ts"));
}

const body = {
  sourceUserMessageId: "msg-user",
  assistantMessageId: "6f1c1d3e-1111-4a2b-9c3d-000000000001",
  modelId: "gpt-6-luna",
  imageModelIds: ["gpt-image-2"],
  preset: "draft",
};

const post = async (payload: unknown) => {
  const { POST } = await loadRoute();
  const response = await POST(
    new Request("http://127.0.0.1:3100/api/conversations/conv-1/image-turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ conversationId: "conv-1" }) }
  );
  return { status: response.status, payload: await response.json() };
};

const reset = () => {
  sessionOverride = { user: { id: "user-1" } };
  refusal = null;
  turns.length = 0;
};

test("no session is rejected before anything else", async () => {
  reset();
  sessionOverride = null;
  assert.equal((await post(body)).status, 401);
  assert.equal(turns.length, 0);
});

test("a valid turn names the group its card polls", async () => {
  reset();
  assert.deepEqual(await post(body), {
    status: 202,
    payload: {
      content: "[Image generated] cat",
      imageTurn: { groupId: "group-1", modelIds: ["gpt-image-2"] },
    },
  });
  assert.deepEqual(turns, [{ userId: "user-1", conversationId: "conv-1", ...body }]);
});

test("the body is strict: no prompt text, no extra fields", async () => {
  reset();
  assert.equal((await post({ ...body, prompt: "ignored" })).status, 400);
  assert.equal((await post({ ...body, assistantMessageId: "bad id!" })).status, 400);
  assert.equal(turns.length, 0);
});

test("a refusal passes through with its status and code", async () => {
  reset();
  refusal = { status: 403, code: "PLAN_FEATURE_NOT_INCLUDED" };
  const { status, payload } = await post(body);
  assert.equal(status, 403);
  assert.equal(payload.code, "PLAN_FEATURE_NOT_INCLUDED");
});
