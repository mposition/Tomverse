import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Server-side contract for MODEL_NOT_SELECTED on POST /api/chat.
//
// The client-side fix for the model-selection sync race (the per-conversation
// serialized sync queue and its send barrier) makes this rejection rare, but
// it must never make it optional: a stale tab, a second browser, or a request
// that simply skips the client entirely still has to be refused when it names
// a model the conversation's stored `selectedModels` does not contain -- and
// refused BEFORE a credit is reserved or a provider is called.
//
// The conversation fixture mirrors the shape reported by trace
// 5dc1d2ee-6c98-44fa-8b6f-03d798c3f011 (`chat_model_selection_denied`):
// the request names a model that is enabled and plan-accessible, but absent
// from the conversation's stored selection. The production log for that trace
// was not retrievable (the deployment that served it has been removed and its
// logs were not retained), so the fixture uses representative model ids with
// the same relationship rather than the incident's literal values.

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

const SESSION_USER_ID = "qa-user-1";
const CONVERSATION_ID = "qa-conversation-5dc1d2ee";
const STORED_SELECTED_MODELS = ["gpt-5-4-mini"];
const UNSELECTED_MODEL_ID = "claude-haiku-4-5";

type Spies = {
  streamTextCalls: number;
  creditReservations: number;
  conversationReads: number;
};

let activeSpies: Spies = {
  streamTextCalls: 0,
  creditReservations: 0,
  conversationReads: 0,
};
let mocksInstalled = false;

async function loadRouteWithSpies(): Promise<{
  POST: (req: Request) => Promise<Response>;
  spies: Spies;
}> {
  const spies: Spies = {
    streamTextCalls: 0,
    creditReservations: 0,
    conversationReads: 0,
  };
  activeSpies = spies;

  if (mocksInstalled) {
    const cached = (await import(
      `${mod("app/api/chat/route.ts")}?spy=cached`
    )) as { POST: (req: Request) => Promise<Response> };
    return { POST: cached.POST, spies };
  }
  mocksInstalled = true;

  const original = (path: string) =>
    require(resolve(ROOT, path)) as Record<string, unknown>;

  // --- session: an authenticated account, so the conversation branch runs.
  mock.module("next-auth/next", {
    namedExports: {
      getServerSession: async () => ({
        user: { id: SESSION_USER_ID, email: "qa@tomverse.app" },
      }),
    },
  });

  // --- billing plan: the static Free defaults, without a database.
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

  // --- conversation storage: the exact denial-shaped row.
  mock.module(mod("lib/prisma.ts"), {
    namedExports: {
      prisma: {
        conversation: {
          findUnique: async () => {
            activeSpies.conversationReads += 1;
            return {
              userId: SESSION_USER_ID,
              password: null,
              selectedModels: JSON.stringify(STORED_SELECTED_MODELS),
            };
          },
        },
        // The second test deliberately fails after the selection gate; the
        // route's provider-failure bookkeeping then runs. Absorb it -- what
        // it records is not this contract's subject.
        $executeRaw: async () => 0,
        $queryRaw: async () => [],
      },
    },
  });

  // --- the paid seams: reaching either is the contract violation.
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
    `${mod("app/api/chat/route.ts")}?spy=cached`
  )) as { POST: (req: Request) => Promise<Response> };
  return { POST: route.POST, spies };
}

const chatRequest = (modelId: string) =>
  new Request("http://127.0.0.1:3100/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
      modelId,
      conversationId: CONVERSATION_ID,
      assistantMessageId: "11111111-1111-4111-8111-111111111111",
    }),
  });

test("a model outside the conversation's stored selection is refused with 403 MODEL_NOT_SELECTED", async () => {
  const { POST, spies } = await loadRouteWithSpies();

  const response = await POST(chatRequest(UNSELECTED_MODEL_ID));

  assert.equal(response.status, 403);
  const payload = (await response.json()) as {
    code?: string;
    error?: string;
    traceId?: string;
  };
  assert.equal(payload.code, "MODEL_NOT_SELECTED");
  assert.match(String(payload.error), /not selected for this conversation/i);
  assert.ok(payload.traceId, "the refusal carries a trace id");
  assert.equal(spies.conversationReads, 1, "the stored selection was consulted");
  assert.equal(
    spies.creditReservations,
    0,
    "no credit was reserved for the refused request"
  );
  assert.equal(
    spies.streamTextCalls,
    0,
    "no provider call was made for the refused request"
  );
});

test("a model inside the stored selection passes the selection gate", async () => {
  const { POST, spies } = await loadRouteWithSpies();

  const response = await POST(chatRequest(STORED_SELECTED_MODELS[0]!));

  // The credit spy throws on purpose, so the request fails *after* the
  // selection gate -- what matters here is that the refusal above is not an
  // overblock: a selected model reaches the credit reservation.
  const payload = (await response.json().catch(() => null)) as {
    code?: string;
  } | null;
  assert.notEqual(payload?.code, "MODEL_NOT_SELECTED");
  assert.equal(
    spies.creditReservations,
    1,
    "a selected model proceeds to the credit reservation"
  );
  assert.equal(spies.streamTextCalls, 0);
});
