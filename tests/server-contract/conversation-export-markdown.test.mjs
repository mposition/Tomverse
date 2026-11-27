import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;

let plan = { allowDownloads: true };
let unlocked = true;
let storedMessages = [];
let sessionUser = "owner-1";
const reads = [];

mock.module(mod("lib/chatRouteSession.ts"), {
  namedExports: {
    resolveChatRouteSession: async () => ({ session: sessionUser ? { user: { id: sessionUser } } : null }),
  },
});
mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      conversation: {
        findFirst: async ({ where }) => {
          reads.push(where);
          return where.userId === "owner-1"
            ? {
                id: where.id,
                title: "Plan *A*",
                createdAt: new Date("2026-01-02T03:04:05.000Z"),
                password: unlocked ? null : "stored",
                passwordVersion: 0,
                kind: "chat",
                productKey: "chat",
                continuationBridge: null,
              }
            : null;
        },
      },
      message: { findMany: async () => storedMessages },
    },
  },
});
const security = await import("../../lib/apiSecurity.ts");
mock.module(mod("lib/apiSecurity.ts"), {
  namedExports: { ...security, apiSecurityResponse: () => null, consumeApiRateLimit: async () => {} },
});
mock.module(mod("lib/billingEntitlements.ts"), {
  namedExports: {
    getUserBillingPlan: async () => plan,
    featureNotIncludedResponse: () => Response.json({ code: "FEATURE_NOT_INCLUDED" }, { status: 403 }),
  },
});
const lock = await import("../../lib/conversationLock.ts");
mock.module(mod("lib/conversationLock.ts"), {
  namedExports: {
    ...lock,
    hasConversationUnlockGrant: () => unlocked,
    conversationLockedResponse: () => Response.json({ code: "CONVERSATION_LOCKED" }, { status: 423 }),
  },
});
const settings = await import("../../lib/appSettings.ts");
mock.module(mod("lib/appSettings.ts"), {
  namedExports: { ...settings, isMemoryInjectionEnabled: async () => false },
});
const continuation = await import("../../lib/externalContinuationService.ts");
mock.module(mod("lib/externalContinuationService.ts"), {
  namedExports: { ...continuation, getContinuationBridge: async () => null },
});

const { GET } = await import("../../app/api/conversations/[conversationId]/export/route.ts");
const context = { params: Promise.resolve({ conversationId: "c1" }) };
const call = (query = "") => GET(new Request(`https://tomverse.app/api/conversations/c1/export${query}`), context);

const reset = () => {
  plan = { allowDownloads: true };
  unlocked = true;
  sessionUser = "owner-1";
  reads.length = 0;
  storedMessages = [
    { id: "m1", role: "user", content: "Hello\n\n```js\nx\n```", modelId: null, createdAt: new Date("2026-01-02T03:04:06.000Z") },
    { id: "m2", role: "assistant", content: "# Answer", modelId: "gpt-4o", createdAt: new Date("2026-01-02T03:04:07.000Z") },
  ];
};

test("?format=md returns the same conversation as a Markdown file", async () => {
  reset();
  const response = await call("?format=md");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.match(response.headers.get("content-disposition"), /filename\*=UTF-8''Plan\s?-?A?/);
  assert.match(response.headers.get("content-disposition"), /\.md/);
  const body = await response.text();
  assert.match(body, /^# Plan \\\*A\\\*\n/);
  assert.match(body, /## User · 2026-01-02T03:04:06\.000Z/);
  assert.match(body, /## GPT-4o · 2026-01-02T03:04:07\.000Z/);
  assert.ok(body.includes("```js\nx\n```"));
});

test("the default and an unknown format stay a text download", async () => {
  reset();
  for (const query of ["", "?format=txt", "?format=pdf"]) {
    const response = await call(query);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8", query);
    assert.match(response.headers.get("content-disposition"), /\.txt/);
    assert.match(await response.text(), /^Tomverse Chat Export\n/);
  }
});

test("Markdown is refused exactly where the text export is refused", async () => {
  for (const query of ["", "?format=md"]) {
    reset();
    plan = { allowDownloads: false };
    assert.equal((await call(query)).status, 403, `plan ${query}`);

    reset();
    unlocked = false;
    assert.equal((await call(query)).status, 423, `lock ${query}`);

    reset();
    sessionUser = null;
    assert.equal((await call(query)).status, 401, `login ${query}`);
  }
  // Another account's conversation is not found, in either format.
  reset();
  sessionUser = "someone-else";
  assert.equal((await call("?format=md")).status, 404);
});
