import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// A comparison preflight that reserves and then cannot answer must give the
// slots back.
//
// The concurrency policy names the function for this in step 4 of the admission
// lifecycle -- `rollbackChatAdmission()` -- and nothing called it. The failure
// it prevents is not hypothetical and it compounds: step 6 tells the client to
// retry a 5xx preflight once, so the retry arrives at a subject whose previous
// attempt is still holding every slot it reserved, and is refused for
// concurrency while running nothing at all. The admission TTL clears it a
// minute later, which is a minute of "a response is already being generated"
// for someone who has no response in flight.
//
// What is asserted is the rollback, not the 500: the response body for an
// infrastructure failure is uninteresting and already covered elsewhere. The
// interesting fact is that the reserved allowance does not survive it.

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

const ADMISSION_ID = "admission-rollback-test";

let rolledBack: string[] = [];
/** Whether the step after the reservation fails this run. */
let failAfterAdmission = true;
let admissionsGranted = 0;

const original = (relativePath: string) =>
  require(resolve(ROOT, relativePath)) as Record<string, unknown>;

const realChatSecurity = original("lib/chatSecurity.ts");
const realApiSecurity = original("lib/apiSecurity.ts");
const realBundle = original("lib/chatContextBundleService.ts");

mock.module(mod("lib/chatSecurity.ts"), {
  namedExports: {
    ...realChatSecurity,
    // Succeeds, so the route gets past admission and into the region where a
    // failure leaves slots held. The real one needs a database.
    preflightChatComparisonAccess: async () => {
      admissionsGranted += 1;
      return {
        modelCount: 2,
        requiredCredits: 2,
        admission: {
          token: "admission-token",
          admissionId: ADMISSION_ID,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      };
    },
    rollbackChatAdmission: async (admissionId: string) => {
      rolledBack.push(admissionId);
      return 2;
    },
  },
});

// The step after admission. A signing secret that is absent, a memory-context
// read that fails -- the shape does not matter, only that it throws where the
// slots are already held.
mock.module(mod("lib/chatContextBundleService.ts"), {
  namedExports: {
    ...realBundle,
    issueChatContextBundle: () => {
      if (failAfterAdmission) {
        throw new Error("CONTEXT_BUNDLE_SIGNING_UNAVAILABLE");
      }
      return null;
    },
  },
});

mock.module(mod("lib/apiSecurity.ts"), {
  namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => undefined },
});

// An account, not a guest: the region between admission and response is where
// the memory context and its §10 bundle are built, and a guest has neither, so
// a guest preflight has almost nothing between the reservation and the reply.
// The window this test is about belongs to signed-in traffic.
const SESSION_USER_ID = "user-rollback-test";
mock.module("next-auth/next", {
  namedExports: {
    getServerSession: async () => ({
      user: { id: SESSION_USER_ID, email: "qa@tomverse.app" },
    }),
  },
});

const realBillingEntitlements = original("lib/billingEntitlements.ts");
const { getDefaultBillingPlan } = original("lib/billingPlanDefaults.ts") as {
  getDefaultBillingPlan: (id: "free" | "pro" | "max") => unknown;
};
mock.module(mod("lib/billingEntitlements.ts"), {
  namedExports: {
    ...realBillingEntitlements,
    getUserBillingPlan: async () => getDefaultBillingPlan("free"),
  },
});

// The memory context is a database read; what it returns is not this
// contract's subject, only that it produces a context the bundle step then
// tries to sign.
const realMemoryContext = original("lib/chatMemoryContext.ts");
mock.module(mod("lib/chatMemoryContext.ts"), {
  namedExports: {
    ...realMemoryContext,
    buildChatMemoryContext: async () => ({
      decision: { allowed: true },
      prompt: {
        promptVersion: "mem-context-v1",
        text: null,
        usedCount: 0,
        factualCount: 0,
        styleCount: 0,
      },
      memoryTokens: 0,
      fingerprintInput: {},
      fingerprint: "fingerprint",
      consideredCount: 0,
      truncatedByBudget: false,
    }),
  },
});

let route: { POST: (request: Request) => Promise<Response> } | null = null;
const loadRoute = async () => {
  if (route) return route;
  route = (await import(
    `${mod("app/api/chat/preflight/route.ts")}?rollback=cached`
  )) as { POST: (request: Request) => Promise<Response> };
  return route;
};

const preflightRequest = () =>
  new Request("http://127.0.0.1:3100/api/chat/preflight", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Client-Request-ID": "3d9a71c8-6e42-4f05-8b1a-9c7d2e5f0a63",
    },
    body: JSON.stringify({
      comparisonId: "1754000000000",
      conversationId: "private-chat",
      modelIds: ["gpt-5-6-luna", "gpt-5-4-mini"],
      prompt: "compare these two answers for me",
      attachments: [],
    }),
  });

test("a failure after admission returns the reserved slots", async () => {
  const { POST } = await loadRoute();
  rolledBack = [];
  admissionsGranted = 0;
  failAfterAdmission = true;

  const response = await POST(preflightRequest());

  assert.ok(response.status >= 500, `expected a 5xx, got ${response.status}`);
  assert.equal(admissionsGranted, 1, "the admission should have been granted");
  assert.deepEqual(
    rolledBack,
    [ADMISSION_ID],
    "the slots the client never received a token for must be given back"
  );
});

test("a successful preflight keeps its slots", async () => {
  // The other half of the contract. Rolling back on the happy path would
  // release the very slots the model requests are about to claim, and every
  // panel would then fall through to the ordinary single-slot path -- which is
  // the partial admission the aggregate reservation exists to prevent.
  const { POST } = await loadRoute();
  rolledBack = [];
  admissionsGranted = 0;
  failAfterAdmission = false;

  const response = await POST(preflightRequest());

  assert.equal(response.status, 200);
  assert.equal(admissionsGranted, 1);
  assert.deepEqual(rolledBack, []);
});

test("a failure before admission has nothing to roll back", async () => {
  // The rollback is conditional on an admission existing. An unconditional one
  // would call into the release path with a null id on every ordinary
  // validation refusal.
  const { POST } = await loadRoute();
  rolledBack = [];
  admissionsGranted = 0;

  const response = await POST(
    new Request("http://127.0.0.1:3100/api/chat/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comparisonId: "not-a-comparison-id" }),
    })
  );

  assert.ok(response.status >= 400 && response.status < 500);
  assert.equal(admissionsGranted, 0);
  assert.deepEqual(rolledBack, []);
});
