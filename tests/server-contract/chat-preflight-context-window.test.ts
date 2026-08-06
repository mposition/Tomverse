import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// A comparison preflight must not price what the chat route will refuse.
//
// §10 requires preflight and chat to share one context builder because
// preflight prices the prompt chat sends. The context guard is part of the
// same bargain and was only on the chat side: preflight quoted credits and
// reserved a concurrency slot for a model whose window could never hold the
// request, and the refusal arrived one HTTP call later. On a comparison that
// is the partial execution the aggregate admission exists to prevent, reached
// after admission instead of before it.
//
// Two things are asserted, and the second is the one that costs money:
//
//   * the refusal is a 400 carrying MODEL_CONTEXT_WINDOW_EXCEEDED, the same
//     code the chat route already uses, so the client has one path; and
//   * `preflightChatComparisonAccess` is never reached, so a refused
//     comparison reserves no slot and no per-minute capacity.
//
// The arithmetic is not under test here -- tests/chatContextWindow.test.mjs
// owns the boundary. What is under test is that the route runs it at all, and
// runs it before the reservation.

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

let preflightCalls = 0;
/** Window the runtime catalogue reports for the model under test. */
let contextWindowTokens: number | null = 8;

const original = (relativePath: string) =>
  require(resolve(ROOT, relativePath)) as Record<string, unknown>;

const realRegistry = original("lib/modelRegistry.ts");
const realChatSecurity = original("lib/chatSecurity.ts");
const realApiSecurity = original("lib/apiSecurity.ts");

// The window comes from the runtime catalogue, which is where an operator can
// actually change it -- so that is the seam. Shrinking it here reaches the
// guard without needing a megabyte of prompt, and leaves the real budget
// arithmetic in place.
mock.module(mod("lib/modelRegistry.ts"), {
  namedExports: {
    ...realRegistry,
    getRuntimeModels: async () => {
      const models = (await (
        realRegistry.getRuntimeModels as () => Promise<
          Array<Record<string, unknown>>
        >
      )()) as Array<Record<string, unknown>>;
      return models.map((model) =>
        model.id === "gpt-5-6-luna" ? { ...model, contextWindowTokens } : model
      );
    },
  },
});

mock.module(mod("lib/chatSecurity.ts"), {
  namedExports: {
    ...realChatSecurity,
    preflightChatComparisonAccess: async () => {
      preflightCalls += 1;
      throw new Error(
        "the aggregate reservation must not be reached for a model that cannot hold the request"
      );
    },
  },
});

// A database write, and this suite runs without one.
mock.module(mod("lib/apiSecurity.ts"), {
  namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => undefined },
});

mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => null },
});

let route: { POST: (request: Request) => Promise<Response> } | null = null;
const loadRoute = async () => {
  if (route) return route;
  route = (await import(
    `${mod("app/api/chat/preflight/route.ts")}?window=cached`
  )) as { POST: (request: Request) => Promise<Response> };
  return route;
};

/** Two models minimum: the endpoint prices comparisons, not single sends. */
const preflightRequest = (modelIds: string[]) =>
  new Request("http://127.0.0.1:3100/api/chat/preflight", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Client-Request-ID": "8f1c2b40-5d0e-4a91-9f3c-2b6e7a0d4c11",
    },
    body: JSON.stringify({
      comparisonId: "1754000000000",
      conversationId: "private-chat",
      modelIds,
      prompt: "compare these two answers for me",
      attachments: [],
    }),
  });

test("a model whose window cannot hold the request is refused before any reservation", async () => {
  const { POST } = await loadRoute();
  preflightCalls = 0;
  contextWindowTokens = 8;

  const response = await POST(
    preflightRequest(["gpt-5-6-luna", "gpt-5-4-mini"])
  );
  const body = (await response.json()) as { code?: string; error?: string };

  assert.equal(response.status, 400);
  assert.equal(body.code, "MODEL_CONTEXT_WINDOW_EXCEEDED");
  // The message names the model and the limit, so the person reading it knows
  // which panel to drop rather than only that something is too long.
  assert.match(String(body.error), /GPT-5\.6 Luna/);
  assert.equal(
    preflightCalls,
    0,
    "a refused comparison must reserve no concurrency slot"
  );
});

test("one oversized model refuses the whole comparison, not just its own panel", async () => {
  // Admitting the subset that fits is exactly what the aggregate admission
  // forbids: three panels are one logical request, and "some answers ran, the
  // rest were refused" is the report that produced the all-or-nothing rule.
  const { POST } = await loadRoute();
  preflightCalls = 0;
  contextWindowTokens = 8;

  const response = await POST(
    preflightRequest(["gpt-5-4-mini", "gpt-5-6-luna"])
  );
  const body = (await response.json()) as { code?: string };

  assert.equal(response.status, 400);
  assert.equal(body.code, "MODEL_CONTEXT_WINDOW_EXCEEDED");
  assert.equal(preflightCalls, 0);
});

test("a model with no declared window is not refused, because nothing was checked", async () => {
  // An undeclared window is unmeasured, not zero. Refusing here would take
  // every model in the catalogue that has not been verified yet offline.
  const { POST } = await loadRoute();
  preflightCalls = 0;
  contextWindowTokens = null;

  await assert.rejects(
    POST(preflightRequest(["gpt-5-6-luna", "gpt-5-4-mini"])).then(async (response) => {
      // The route reached the reservation seam, which throws by design here.
      // Surfacing that as a rejection is the assertion: the request got past
      // the context guard.
      const body = (await response.json()) as { code?: string };
      throw new Error(`expected to reach the reservation, got ${body.code}`);
    })
  );
  assert.equal(
    preflightCalls,
    1,
    "the request should have reached the aggregate reservation"
  );
});
