import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { PromptRefinerChatExecutionError } from "@/lib/promptRefinerChatExecutionCore";

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
let explicitRefinerAuthority = false;
let refinerScopeAuthorized = true;
let consumedRefinerDecisions = 0;
let refinerAdmissions = 0;
let refinerAdmissionRefused = false;
let refinerAdmissionEvents: string[] = [];

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

  const realRefinerRelease = original("lib/promptRefinerChatExecutionRelease.ts");
  mock.module(mod("lib/promptRefinerChatExecutionRelease.ts"), { namedExports: {
    promptRefinerChatExecutionRelease: () => explicitRefinerAuthority
      ? { explicitEnabled: true, autoEnabled: false }
      : (realRefinerRelease.promptRefinerChatExecutionRelease as () => unknown)(),
  } });
  mock.module(mod("lib/promptRefinerChatExecutionStore.ts"), { namedExports: {
    consumePromptRefinerChatExecution: async (input: { messages: Array<{ role: string; content: string }> }) => {
      refinerAdmissionEvents.push("consume");
      if (!explicitRefinerAuthority || consumedRefinerDecisions !== 0) throw new PromptRefinerChatExecutionError();
      consumedRefinerDecisions += 1;
      return { executionMessages: input.messages.map((message, index) => index === input.messages.length - 1
        ? { ...message, content: "Synthetic held execution prompt" } : message),
        mode: "explicit", provenance: { decision: "accepted" } };
    },
  } });
  mock.module(mod("lib/chatDurableRecoveryAccess.ts"), { namedExports: {
    authorizeChatRecoveryScope: async () => {
      refinerAdmissionEvents.push("scope");
      return refinerScopeAuthorized
        ? { ok: true, conversationId: CONVERSATION_ID }
        : { ok: false, response: Response.json(
          { error: "Conversation not found.", code: "CONVERSATION_NOT_FOUND" },
          { status: 404 }
        ) };
    },
  } });
  const realApiSecurity = original("lib/apiSecurity.ts");
  mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
    ...realApiSecurity,
    consumeApiRateLimit: async (_request: Request, _userId: string, scope: string) => {
      if (scope !== "chat-durable-attempt") return;
      refinerAdmissionEvents.push("admission");
      refinerAdmissions += 1;
      if (refinerAdmissionRefused) {
        const ApiSecurityError = realApiSecurity.ApiSecurityError as new (
          status: number,
          code: string,
          message: string,
          retryAfter?: number
        ) => Error;
        throw new ApiSecurityError(429, "API_RATE_LIMITED", "Too many requests.", 30);
      }
    },
  } });

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
          // The routing-state read is no longer gated on cohort eligibility:
          // decision record v1.2 §3 settles the product before the cohort, and
          // the product lives on this row. A manual Review conversation, which
          // is what every conversation is today.
          findFirst: async () => ({
            selectionMode: "manual",
            routerModelId: null,
            routerChallengerTurns: 0,
            productKey: "review",
          }),
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

const refinerRequest = () =>
  new Request("http://127.0.0.1:3100/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ id: "22222222-2222-4222-8222-222222222222", role: "user", content: "authored source" }],
      modelId: STORED_SELECTED_MODELS[0], conversationId: CONVERSATION_ID,
      assistantMessageId: "11111111-1111-4111-8111-111111111111", sourceUserMessageId: "22222222-2222-4222-8222-222222222222",
      promptRefinerDecision: { suggestionId: "33333333-3333-4333-8333-333333333333",
        scopeId: "44444444-4444-4444-8444-444444444444", epoch: 1, decision: "accepted" } }),
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

test("a Refiner decision on the default-off deployment refuses before model, credit or provider work", async () => {
  const { POST, spies } = await loadRouteWithSpies();
  const response = await POST(new Request("http://127.0.0.1:3100/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ id: "22222222-2222-4222-8222-222222222222", role: "user", content: "authored source" }],
      modelId: STORED_SELECTED_MODELS[0], conversationId: CONVERSATION_ID,
      assistantMessageId: "11111111-1111-4111-8111-111111111111",
      sourceUserMessageId: "22222222-2222-4222-8222-222222222222",
      promptRefinerDecision: { suggestionId: "33333333-3333-4333-8333-333333333333",
        scopeId: "44444444-4444-4444-8444-444444444444", epoch: 1, decision: "accepted" },
    }),
  }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "PROMPT_REFINER_DECISION_UNAVAILABLE");
  assert.equal(spies.creditReservations, 0);
  assert.equal(spies.streamTextCalls, 0);
  assert.equal(spies.conversationReads, 0);
});

test("a cross-scope Refiner decision refuses before durable admission or one-time consume", async () => {
  const { POST, spies } = await loadRouteWithSpies();
  explicitRefinerAuthority = true; refinerScopeAuthorized = false;
  consumedRefinerDecisions = 0; refinerAdmissions = 0; refinerAdmissionEvents = [];
  try {
    const response = await POST(refinerRequest());
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "CONVERSATION_NOT_FOUND");
    assert.deepEqual(refinerAdmissionEvents, ["scope"]);
    assert.equal(refinerAdmissions, 0);
    assert.equal(consumedRefinerDecisions, 0);
    assert.equal(spies.creditReservations, 0);
    assert.equal(spies.streamTextCalls, 0);
  } finally {
    explicitRefinerAuthority = false; refinerScopeAuthorized = true;
  }
});

test("a rate-limited Refiner decision is not consumed", async () => {
  const { POST, spies } = await loadRouteWithSpies();
  explicitRefinerAuthority = true; refinerAdmissionRefused = true;
  consumedRefinerDecisions = 0; refinerAdmissions = 0; refinerAdmissionEvents = [];
  try {
    const response = await POST(refinerRequest());
    assert.equal(response.status, 429);
    assert.equal((await response.json()).code, "API_RATE_LIMITED");
    assert.deepEqual(refinerAdmissionEvents, ["scope", "admission"]);
    assert.equal(refinerAdmissions, 1);
    assert.equal(consumedRefinerDecisions, 0);
    assert.equal(spies.creditReservations, 0);
    assert.equal(spies.streamTextCalls, 0);
  } finally {
    explicitRefinerAuthority = false; refinerAdmissionRefused = false;
  }
});

test("an admitted valid Refiner decision consumes once and a stale replay remains rate-protected", async () => {
  const { POST, spies } = await loadRouteWithSpies();
  explicitRefinerAuthority = true; consumedRefinerDecisions = 0;
  refinerAdmissions = 0; refinerAdmissionEvents = [];
  try {
    // The existing access spy throws before any actual reservation or provider.
    assert.equal((await POST(refinerRequest())).status, 500);
    assert.equal(consumedRefinerDecisions, 1);
    assert.equal(spies.creditReservations, 1);
    assert.deepEqual(refinerAdmissionEvents, ["scope", "admission", "consume"]);
    const repeated = await POST(refinerRequest());
    assert.equal(repeated.status, 409);
    assert.equal((await repeated.json()).code, "PROMPT_REFINER_DECISION_UNAVAILABLE");
    assert.equal(consumedRefinerDecisions, 1);
    assert.equal(spies.creditReservations, 1);
    assert.equal(spies.streamTextCalls, 0);
    assert.equal(refinerAdmissions, 2, "each POST probe is admitted once, including a refused replay");
    assert.deepEqual(refinerAdmissionEvents, [
      "scope", "admission", "consume",
      "scope", "admission", "consume",
    ]);
  } finally { explicitRefinerAuthority = false; }
});
