// Contract: POST /api/chat/image-intent only routes, and pays for the model
// call only for a caller the image workspace would serve. Everyone else gets
// `{ image: false }` with no call at all.

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
process.env.NEXTAUTH_SECRET ||= "chat-image-intent-contract-secret-2026";

let sessionOverride: unknown = null;
let flagEnabled = true;
let planTier: "Free" | "Pro" | "Max" = "Pro";
let accessRefused = false;
let triageModelId: string | null = "gpt-6-luna";
let detectAnswer: unknown = { image: true, modelId: "gpt-image-2", preset: "final" };
const detectCalls: Array<{ text: string }> = [];
let mocksInstalled = false;

async function loadRoute() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<
      string,
      unknown
    >;
    mock.module("next-auth/next", {
      namedExports: { getServerSession: async () => sessionOverride },
    });
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        ...realApiSecurity,
        consumeApiRateLimit: async () => undefined,
      },
    });
    mock.module(mod("lib/appSettings.ts"), {
      namedExports: { isImageGenerationEnabledCached: async () => flagEnabled },
    });
    mock.module(mod("lib/billingEntitlements.ts"), {
      namedExports: {
        getUserBillingPlan: async () => ({ tier: planTier }),
        planAllowsFeature: (plan: { tier: string }, feature: string) =>
          feature === "imageGeneration" && (plan.tier === "Pro" || plan.tier === "Max"),
      },
    });
    mock.module(mod("lib/chatSecurity.ts"), {
      namedExports: {
        assertUserOperationalAccess: async () => {
          if (accessRefused) throw new Error("restricted");
        },
      },
    });
    mock.module(mod("lib/chatImageIntent.ts"), {
      namedExports: {
        chatImageTriageModelId: async () => triageModelId,
        detectChatImageRequest: async (input: { text: string }) => {
          detectCalls.push({ text: input.text });
          return detectAnswer;
        },
      },
    });
  }
  return import(mod("app/api/chat/image-intent/route.ts"));
}

const postRequest = (body: unknown) =>
  new Request("http://127.0.0.1:3100/api/chat/image-intent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const reset = () => {
  sessionOverride = { user: { id: "user-image-intent-1" } };
  triageModelId = "gpt-6-luna";
  flagEnabled = true;
  planTier = "Pro";
  accessRefused = false;
  detectAnswer = { image: true, modelId: "gpt-image-2", preset: "final" };
  detectCalls.length = 0;
};

const answer = async (body: unknown = { text: "고양이 그림 그려줘" }) => {
  const { POST } = await loadRoute();
  const response = await POST(postRequest(body));
  return { status: response.status, payload: await response.json() };
};

test("no session is rejected", async () => {
  reset();
  sessionOverride = null;
  const { status } = await answer();
  assert.equal(status, 401);
  assert.equal(detectCalls.length, 0);
});

test("an eligible caller gets the triage decision", async () => {
  reset();
  assert.deepEqual(await answer(), {
    status: 200,
    payload: { image: true, modelId: "gpt-image-2", preset: "final" },
  });
  assert.deepEqual(detectCalls, [{ text: "고양이 그림 그려줘" }]);
  reset();
  detectAnswer = { image: false };
  assert.deepEqual((await answer()).payload, { image: false });
});

for (const [name, arrange] of [
  ["image triage is off in Admin › Routing", () => (triageModelId = null)],
  ["image generation is off", () => (flagEnabled = false)],
  ["the plan has no image generation", () => (planTier = "Free")],
  ["the account is restricted", () => (accessRefused = true)],
] as const) {
  test(`no model call when ${name}`, async () => {
    reset();
    arrange();
    assert.deepEqual(await answer(), { status: 200, payload: { image: false } });
    assert.equal(detectCalls.length, 0);
  });
}

test("blank text makes no call and an unknown field is refused", async () => {
  reset();
  assert.deepEqual((await answer({ text: "   " })).payload, { image: false });
  assert.equal(detectCalls.length, 0);
  const { status } = await answer({ text: "draw", extra: 1 });
  assert.equal(status, 400);
  assert.equal(detectCalls.length, 0);
});
