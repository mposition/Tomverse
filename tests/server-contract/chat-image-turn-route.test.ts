// Contract: POST /api/conversations/[id]/image-turn is signed-in only, takes a
// strict body, and passes refusals from the image turn through as they are.

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { nativeParityBearerRoute } from "../../lib/nativeBearerGate.ts";

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
let cookieReads = 0;
/** Image allowance consumptions, and whether the next one is refused. */
let rateLimitCalls = 0;
let rateLimitRefused = false;
/** Whether the panel's group is already reserved, and who asked. */
let groupReserved = false;
const groupChecks: Array<Record<string, unknown>> = [];

async function loadRoute() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<string, unknown>;
    const { ChatAccessError } = require(resolve(ROOT, "lib/chatSecurity.ts")) as {
      ChatAccessError: new (status: number, code: string, message: string) => Error;
    };
    mock.module("next-auth/next", {
      namedExports: { getServerSession: async () => { cookieReads++; return sessionOverride; } },
    });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
      user: { findUnique: async () => ({ id: "native-owner", accountStatus: "active" }) },
    } } });
    mock.module(mod("lib/mobileAuthRoute.ts"), { namedExports: {
      mobileAuthRefusal: (code: string) => Response.json({ code }, { status: 401 }),
      requireMobileBearer: async (request: Request) => request.headers.get("authorization") === "Bearer valid-native" ?
        { ok: true, identity: { userId: "native-owner" } } :
        { ok: false, response: Response.json({ code: "MOBILE_TOKEN_INVALID" }, { status: 401 }) },
    } });
    const { ApiSecurityError } = realApiSecurity as {
      ApiSecurityError: new (status: number, code: string, message: string) => Error;
    };
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => {
        rateLimitCalls += 1;
        if (rateLimitRefused) throw new ApiSecurityError(429, "API_RATE_LIMITED", "Too many requests.");
      } },
    });
    mock.module(mod("lib/chatImageTurn.ts"), {
      namedExports: {
        chatImageTurnGroupReserved: async (input: Record<string, unknown>) => {
          groupChecks.push(input);
          return groupReserved;
        },
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

const post = async (payload: unknown, headers: Record<string, string> = {}) => {
  const { POST } = await loadRoute();
  const response = await POST(
    new Request("http://127.0.0.1:3100/api/conversations/conv-1/image-turn", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ conversationId: "conv-1" }) }
  );
  return { status: response.status, payload: await response.json() };
};

const reset = () => {
  process.env.TOMVERSE_NATIVE_CHAT_ENABLED = "true";
  process.env.TOMVERSE_NATIVE_PARITY_ENABLED = "true";
  sessionOverride = { user: { id: "user-1" } };
  refusal = null;
  turns.length = 0;
  rateLimitCalls = 0;
  rateLimitRefused = false;
  groupReserved = false;
  groupChecks.length = 0;
};

const reviewPanel = {
  ...body,
  assistantMessageId: "6f1c1d3e-2222-4a2b-9c3d-000000000002_1",
  imageGroupModelIds: ["fal-ai/nano-banana-2", "gpt-image-2"],
  imageGroupPanelModelIds: ["google-chat", "gpt-6-luna"],
};

test("a later Review panel of a reserved group binds without spending the image allowance", async () => {
  reset();
  groupReserved = true;
  const { status } = await post(reviewPanel);
  assert.equal(status, 202);
  assert.equal(rateLimitCalls, 0, "binding to a reserved group buys nothing, so it is not counted");
  assert.deepEqual(groupChecks, [{ userId: "user-1", conversationId: "conv-1",
    assistantMessageId: reviewPanel.assistantMessageId }]);
  assert.deepEqual(turns[0].imageGroupPanelModelIds, reviewPanel.imageGroupPanelModelIds);

  // Even with the allowance spent, it still binds: its image is paid for.
  reset();
  groupReserved = true;
  rateLimitRefused = true;
  assert.equal((await post(reviewPanel)).status, 202);
});

test("the panel that reserves a group, and every plain turn, still spend the image allowance", async () => {
  reset();
  assert.equal((await post(reviewPanel)).status, 202);
  assert.equal(rateLimitCalls, 1);
  reset();
  assert.equal((await post(body)).status, 202);
  assert.equal(rateLimitCalls, 1);
  assert.equal(groupChecks.length, 0, "a plain Chat image turn is never a later panel");
  reset();
  rateLimitRefused = true;
  const refused = await post(reviewPanel);
  assert.equal(refused.status, 429);
  assert.equal(turns.length, 0, "nothing was reserved");
});

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
  assert.ok(turns[0].request instanceof Request);
  assert.deepEqual(turns.map(turn => { const copy = { ...turn }; delete copy.request; return copy; }), [
    { userId: "user-1", conversationId: "conv-1", ...body, prompt: undefined },
  ]);
});

test("a follow-up's prompt passes through; the body is otherwise strict", async () => {
  reset();
  assert.equal((await post({ ...body, prompt: "a blue cat icon" })).status, 202);
  assert.equal(turns[0].prompt, "a blue cat icon");
  reset();
  assert.equal((await post({ ...body, prompt: "x".repeat(4_001) })).status, 400);
  assert.equal((await post({ ...body, extra: 1 })).status, 400);
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

test("native image turns use the verified owner and preserve the original answer identity", async () => {
  reset();
  const before = cookieReads;
  const response = await post(body, { authorization: "Bearer valid-native", origin: "https://localhost", cookie: "another-account" });
  assert.equal(response.status, 202);
  assert.equal(turns[0].userId, "native-owner");
  assert.equal(turns[0].assistantMessageId, body.assistantMessageId);
  assert.equal(turns[0].sourceUserMessageId, body.sourceUserMessageId);
  assert.equal(cookieReads, before);
});

test("native image enrollment is exact POST only and remains default off", async () => {
  reset();
  const path = "/api/conversations/conv-1/image-turn";
  assert.equal(nativeParityBearerRoute(path, "POST", true), true);
  assert.equal(nativeParityBearerRoute(path, "POST"), false);
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) assert.equal(nativeParityBearerRoute(path, method, true), false);
  for (const path of ["/api/conversations/conv-1/image-turn/extra", "/api/conversations/%2Fadmin/image-turn", "/api/admin/image-turn"]) assert.equal(nativeParityBearerRoute(path, "POST", true), false);
  const before = cookieReads;
  delete process.env.TOMVERSE_NATIVE_PARITY_ENABLED;
  assert.equal((await post(body, { authorization: "Bearer valid-native" })).status, 503);
  assert.equal(turns.length, 0);
  assert.equal(cookieReads, before);
});

test("invalid native credentials and foreign origins never borrow a web session or start an image", async () => {
  reset();
  const before = cookieReads;
  assert.equal((await post(body, { authorization: "Bearer invalid", cookie: "valid-cookie" })).status, 401);
  assert.equal((await post(body, { authorization: "Bearer valid-native", origin: "https://foreign.invalid" })).status, 401);
  assert.equal(turns.length, 0);
  assert.equal(cookieReads, before);
});
