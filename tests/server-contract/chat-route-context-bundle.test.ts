import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Server-side contract for the §10 context bundle on POST /api/chat.
//
// docs/policy/external-conversation-import-and-memory.md §10.
//
// The DB integration tests cover the resolver's decisions. What is checked
// here is the ROUTE's half of the invariant, which nothing else can see:
//
//   * a turn whose memory context is active but unquoted is refused with 409
//     CHAT_CONTEXT_BUNDLE_STALE and requiresPreflight, BEFORE a credit is
//     reserved or a provider is called;
//   * a memory store that is briefly unreadable degrades the turn to
//     no-memory instead of failing it.
//
// The second is not a nicety. Memory is an enhancement to a chat turn, and a
// hiccup in the memory store taking every chat down with it would be a far
// worse outage than losing memory from a few turns.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "server-contract-test-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

const SESSION_USER_ID = "qa-memory-user";
const CONVERSATION_ID = "qa-memory-conversation";
const MODEL_ID = "gpt-5-4-mini";

type Spies = { creditReservations: number; streamTextCalls: number };

let activeSpies: Spies = { creditReservations: 0, streamTextCalls: 0 };
/** Swapped per test: what the shared builder pretends the store holds. */
let builderBehaviour: "active" | "throws" = "active";
let mocksInstalled = false;

const ACTIVE_CONTEXT = {
  active: true,
  inactiveReason: null,
  factual: { text: "ACCOUNT MEMORY", tokens: 5, itemCount: 1 },
  style: { text: null, tokens: 0, itemCount: 0 },
  promptText: "ACCOUNT MEMORY (facts about the user):\n- (expertise) x",
  totalTokens: 12,
  binding: {
    memoryStateHash: "state-hash",
    retrievalHash: "retrieval-hash",
    retrievalVersion: 1,
    styleEnabled: true,
    memoryMode: "on" as const,
    profileVersion: null,
    promptVersion: "mem-context-v1",
  },
};

async function loadRoute(): Promise<{
  POST: (req: Request) => Promise<Response>;
  spies: Spies;
}> {
  const spies: Spies = { creditReservations: 0, streamTextCalls: 0 };
  activeSpies = spies;

  if (mocksInstalled) {
    const cached = (await import(
      `${mod("app/api/chat/route.ts")}?context-bundle=cached`
    )) as { POST: (req: Request) => Promise<Response> };
    return { POST: cached.POST, spies };
  }
  mocksInstalled = true;

  const original = (path: string) =>
    require(resolve(ROOT, path)) as Record<string, unknown>;

  mock.module("next-auth/next", {
    namedExports: {
      getServerSession: async () => ({
        user: { id: SESSION_USER_ID, email: "qa@tomverse.app" },
      }),
    },
  });

  const realBillingEntitlements = original("lib/billingEntitlements.ts");
  const { getDefaultBillingPlan } = original(
    "lib/billingPlanDefaults.ts"
  ) as unknown as {
    getDefaultBillingPlan: (id: "free" | "pro" | "max") => unknown;
  };
  mock.module(mod("lib/billingEntitlements.ts"), {
    namedExports: {
      ...realBillingEntitlements,
      getUserBillingPlan: async () => getDefaultBillingPlan("free"),
    },
  });

  mock.module(mod("lib/prisma.ts"), {
    namedExports: {
      prisma: {
        conversation: {
          findUnique: async () => ({
            userId: SESSION_USER_ID,
            password: null,
            selectedModels: JSON.stringify([MODEL_ID]),
            memoryMode: "on",
          }),
          findFirst: async () => ({ memoryMode: "on" }),
        },
        messageProviderContext: { findMany: async () => [] },
        $executeRaw: async () => 0,
        $queryRaw: async () => [],
      },
    },
  });

  // The builder stands in for the whole memory store. Mocking it rather than
  // the resolver keeps the resolver — the thing that decides inject vs refuse
  // — as real code in this test.
  const realBuilder = original("lib/memoryContextBuilder.ts");
  mock.module(mod("lib/memoryContextBuilder.ts"), {
    namedExports: {
      ...realBuilder,
      buildMemoryContext: async () => {
        if (builderBehaviour === "throws") {
          throw new Error("memory store unavailable");
        }
        return ACTIVE_CONTEXT;
      },
    },
  });

  mock.module("ai", {
    namedExports: {
      streamText: () => {
        activeSpies.streamTextCalls += 1;
        throw new Error("streamText must not be reached");
      },
    },
  });
  const realChatSecurity = original("lib/chatSecurity.ts");
  mock.module(mod("lib/chatSecurity.ts"), {
    namedExports: {
      ...realChatSecurity,
      acquireChatAccess: () => {
        activeSpies.creditReservations += 1;
        throw new Error("acquireChatAccess must not reserve credits");
      },
    },
  });

  const route = (await import(
    `${mod("app/api/chat/route.ts")}?context-bundle=cached`
  )) as { POST: (req: Request) => Promise<Response> };
  return { POST: route.POST, spies };
}

const chatRequest = (body: Record<string, unknown> = {}) =>
  new Request("http://127.0.0.1:3100/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
      modelId: MODEL_ID,
      conversationId: CONVERSATION_ID,
      assistantMessageId: "22222222-2222-4222-8222-222222222222",
      ...body,
    }),
  });

test("active memory with no bundle is refused with 409 before any spend (§10)", async () => {
  builderBehaviour = "active";
  const { POST, spies } = await loadRoute();

  const response = await POST(chatRequest());

  assert.equal(response.status, 409);
  const payload = (await response.json()) as {
    code?: string;
    details?: { requiresPreflight?: boolean; reason?: string };
  };
  assert.equal(payload.code, "CHAT_CONTEXT_BUNDLE_STALE");
  assert.equal(payload.details?.requiresPreflight, true);
  assert.equal(payload.details?.reason, "bundle_missing");
  // The whole point of refusing here rather than later: nothing was committed.
  assert.equal(spies.creditReservations, 0);
  assert.equal(spies.streamTextCalls, 0);
});

test("a forged bundle is rejected outright, not sent back for a retry", async () => {
  builderBehaviour = "active";
  const { POST, spies } = await loadRoute();

  const response = await POST(
    chatRequest({ contextBundle: "not-a-real-bundle.signature" })
  );

  // 400, not 409: re-preflighting would not turn a forged token into a valid
  // one, and telling the client to retry would loop it.
  assert.equal(response.status, 400);
  const payload = (await response.json()) as { code?: string };
  assert.equal(payload.code, "INVALID_CONTEXT_BUNDLE");
  assert.equal(spies.creditReservations, 0);
  assert.equal(spies.streamTextCalls, 0);
});

test("an unreadable memory store degrades the turn instead of failing it", async () => {
  builderBehaviour = "throws";
  const { POST, spies } = await loadRoute();

  const response = await POST(chatRequest());

  // The request proceeds past the memory step and reaches the reservation,
  // where this test's spy stops it. What matters is that it got there: no 409,
  // no 500 from the memory store, and no memory in the prompt either.
  const payload = (await response.json().catch(() => null)) as {
    code?: string;
  } | null;
  assert.notEqual(payload?.code, "CHAT_CONTEXT_BUNDLE_STALE");
  assert.equal(
    spies.creditReservations,
    1,
    "the turn continued to the credit reservation without memory"
  );
});
