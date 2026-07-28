import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// UX-F006 / WO-004 -- server-side safety contract for POST /api/chat.
//
// The E2E suite mocks /api/chat wholesale, so it can only show that the
// client stops sending. It cannot show what the server does when someone
// calls the endpoint directly: an attacker, a stale tab, or simply a bug that
// skips the client preflight. This harness drives the real route handler with
// spies on the two seams that cost money:
//
//   * the provider adapter  -- lib/activeAiModel.getActiveAiModel, plus
//     streamText from the `ai` SDK, and
//   * the credit reservation -- lib/chatSecurity.acquireChatAccess.
//
// A rejected request must reach neither. "Rejected" is asserted by status
// code, but the point of these tests is the two zero-counts.
//
// Module mocking is process-global, which is why this runs under its own
// runner (scripts/run-server-contract-tests.mjs) instead of alongside the
// unit suite.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

// The route reads the registry through getRuntimeModels, which returns the
// static bootstrap catalog when the database is disabled -- so these guards
// are exercised without a database.
process.env.E2E_DISABLE_DATABASE = "true";
// Unroutable port: any accidental database access fails fast instead of
// stalling on a connect timeout.
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "server-contract-test-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

type Spies = {
  adapterCalls: string[];
  streamTextCalls: number;
  creditReservations: number;
  surchargeArgs: Array<{ mode: unknown; capability: unknown }>;
};

/**
 * Installs spies on the paid seams and returns the freshly imported route.
 * Every mock keeps the module's real exports and replaces only what is being
 * observed, so the guard logic under test stays real.
 */
async function loadRouteWithSpies(options: {
  session?: unknown;
} = {}): Promise<{ POST: (req: Request) => Promise<Response>; spies: Spies }> {
  mock.reset();

  const spies: Spies = {
    adapterCalls: [],
    streamTextCalls: 0,
    creditReservations: 0,
    surchargeArgs: [],
  };

  // Originals come from the CommonJS cache, which is separate from the ESM
  // registry mock.module operates on. Loading them with a dynamic import
  // instead -- even under a `?original` query, which tsx normalises away --
  // caches the real module under its canonical URL and mock.module then
  // never intercepts the route's import of it. That bites transitively too:
  // importing lib/chatSecurity.ts pulls in lib/webSearchCredits.ts, which is
  // why the surcharge spy silently recorded nothing while the credit spy
  // beside it worked.
  const original = (path: string) =>
    require(resolve(ROOT, path)) as Record<string, unknown>;

  // --- provider adapter seam -------------------------------------------------
  // Recorded, then delegated to the real builder: the route reads fields off
  // the object it returns, so a stub derails the flow long before the seams
  // that actually spend anything. Constructing a client issues no request --
  // streamText is what would, and it is blocked below.
  const realActiveAiModel = original("lib/activeAiModel.ts") as unknown as {
    getActiveAiModel: (model: unknown) => unknown;
  };
  mock.module(mod("lib/activeAiModel.ts"), {
    namedExports: {
      getActiveAiModel: (model: { id?: string }) => {
        spies.adapterCalls.push(model?.id ?? "unknown");
        return realActiveAiModel.getActiveAiModel(model);
      },
    },
  });

  // The route's only runtime import from `ai` is streamText (FilePart and
  // ModelMessage are types, erased at compile time), so this needs no
  // passthrough. Reaching it means a provider request was about to be issued.
  mock.module("ai", {
    namedExports: {
      streamText: (...args: unknown[]) => {
        spies.streamTextCalls += 1;
        throw new Error(
          `streamText must not be reached for a rejected chat request (${args.length} args)`
        );
      },
    },
  });

  // --- credit seam -----------------------------------------------------------
  const realChatSecurity = original("lib/chatSecurity.ts");
  mock.module(mod("lib/chatSecurity.ts"), {
    namedExports: {
      ...realChatSecurity,
      createChatBudget: (
        kind: unknown,
        model: unknown,
        estimatedInputTokens: unknown,
        options?: { webSearchSurchargeCredits?: number }
      ) => {
        spies.surchargeArgs.push({
          mode: options?.webSearchSurchargeCredits,
          capability: (model as { id?: string })?.id,
        });
        return (
          realChatSecurity.createChatBudget as (
            a: unknown,
            b: unknown,
            c: unknown,
            d: unknown
          ) => unknown
        )(kind, model, estimatedInputTokens, options);
      },
      acquireChatAccess: (...args: unknown[]) => {
        spies.creditReservations += 1;
        throw new Error(
          `acquireChatAccess must not reserve credits for a rejected chat request (${args.length} args)`
        );
      },
    },
  });

  // --- web-search surcharge input -------------------------------------------
  // Observed through createChatBudget rather than by mocking
  // lib/webSearchCredits directly. createChatBudget lives in lib/chatSecurity,
  // already mocked above, and it receives the surcharge the route derived from
  // the request's webSearchMode -- so this sees the value that actually feeds
  // the credit reservation.
  // --- session ---------------------------------------------------------------
  // getServerSession is the route's only runtime import from next-auth/next.
  mock.module("next-auth/next", {
    namedExports: {
      getServerSession: async () => options.session ?? null,
    },
  });

  const route = (await import(
    `${mod("app/api/chat/route.ts")}?spy=${Math.random()}`
  )) as { POST: (req: Request) => Promise<Response> };

  return { POST: route.POST, spies };
}

const chatRequest = (body: unknown) =>
  new Request("http://127.0.0.1:3100/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const assertNothingSpent = (spies: Spies, context: string) => {
  assert.equal(
    spies.streamTextCalls,
    0,
    `${context}: streamText was called`
  );
  assert.equal(
    spies.creditReservations,
    0,
    `${context}: credits were reserved`
  );
  assert.deepEqual(
    spies.adapterCalls,
    [],
    `${context}: a provider client was constructed for a request that never should have got that far`
  );
};

test("a retired model is rejected without touching the provider or credits", async () => {
  const { POST, spies } = await loadRouteWithSpies();

  const response = await POST(
    chatRequest({
      messages: [{ role: "user", content: "hello" }],
      // Retired in lib/models.ts: groq stopped serving it.
      modelId: "llama-4-scout",
    })
  );

  assert.equal(response.status, 410);
  const payload = (await response.json()) as { code?: string };
  assert.equal(payload.code, "MODEL_RETIRED");
  assertNothingSpent(spies, "retired model");
});

test("an unknown model is rejected without touching the provider or credits", async () => {
  const { POST, spies } = await loadRouteWithSpies();

  const response = await POST(
    chatRequest({
      messages: [{ role: "user", content: "hello" }],
      modelId: "definitely-not-a-real-model",
    })
  );

  assert.equal(response.status, 400);
  const payload = (await response.json()) as { code?: string };
  assert.equal(payload.code, "MODEL_NOT_AVAILABLE");
  assertNothingSpent(spies, "unknown model");
});

test("a malformed payload is rejected without touching the provider or credits", async () => {
  const { POST, spies } = await loadRouteWithSpies();

  const response = await POST(chatRequest({ messages: "not-an-array" }));

  assert.ok(
    response.status >= 400 && response.status < 500,
    `expected a 4xx rejection, got ${response.status}`
  );
  assertNothingSpent(spies, "malformed payload");
});

test("an empty message list is rejected without touching the provider or credits", async () => {
  const { POST, spies } = await loadRouteWithSpies();

  const response = await POST(
    chatRequest({ messages: [], modelId: "gpt-5-4-mini" })
  );

  assert.ok(
    response.status >= 400 && response.status < 500,
    `expected a 4xx rejection, got ${response.status}`
  );
  assertNothingSpent(spies, "empty messages");
});

// NOT COVERED HERE: the end-to-end webSearchMode -> credit-surcharge
// plumbing through this route.
//
// Reaching createChatBudget requires getting past ensureGuestVerified (which
// calls next/headers) or past the authenticated path (which needs a real
// database), and neither a Next request scope nor a database exists in this
// process. Faking either would make the assertion pass without exercising the
// plumbing it claims to protect, so it is deliberately absent rather than
// green-but-hollow.
//
// Partial cover that does exist today:
//   * tests/chatSecurityWebSearchMode.test.mjs -- validateChatPayload
//     preserves the requested mode.
//   * tests/webSearchCredits*.test.* -- the mode -> surcharge table.
// The join between them, inside the route, is still unverified. Closing it
// needs either a Next request-scope harness or a throwaway database.
