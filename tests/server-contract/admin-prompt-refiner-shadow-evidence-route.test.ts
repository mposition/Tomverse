import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "prompt-refiner-historical-route-test";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

const ids = [
  ...Array.from({ length: 8 }, (_, index) => `prsv1-ko-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 8 }, (_, index) => `prsv1-en-${String(index + 1).padStart(2, "0")}`),
];
const completeBundle = () => ({
  gateOutcome: "fail",
  gateReasons: ["case_evidence_failed"],
  executionAdmitted: false,
  productAdapterReady: false,
  suggestionUiAuthorized: false,
  routerCouplingAuthorized: false,
  paidRunAuthorized: false,
  humanReviewRequired: true,
  summary: { attemptedCases: 16, passedCases: 13 },
  cases: ids.map((caseId, index) => ({
    caseId,
    terminalStatus: "suggested",
    evidenceStatus: index < 13 ? "pass" : "fail",
    failureReasons: index < 13 ? [] : ["required_concept_missing"],
    sourceText: "never expose stored input",
    refinedPrompt: "never expose stored proposal",
    userId: "never expose identity",
    providerError: "never expose provider error",
    modelOutput: "never expose model output",
  })),
});

const terminalBundle = (includeFailed: boolean) => {
  const result = completeBundle();
  for (const item of result.cases) {
    item.evidenceStatus = "pass";
    item.failureReasons = [];
  }
  result.cases[1].terminalStatus = "unknown";
  result.cases[1].evidenceStatus = "insufficient_evidence";
  if (includeFailed) {
    result.cases[0].terminalStatus = "failed";
    result.cases[0].evidenceStatus = "fail";
    result.cases[0].failureReasons = ["not_suggested"];
  }
  result.summary.passedCases = includeFailed ? 14 : 15;
  result.gateOutcome = includeFailed ? "fail" : "insufficient_evidence";
  result.gateReasons = [
    ...(includeFailed ? ["case_evidence_failed"] : []),
    "case_evidence_incomplete",
    ...(includeFailed ? ["terminal_failure_present"] : []),
    "unknown_present", "cost_incomplete", "latency_incomplete",
  ];
  return result;
};

type World = {
  authenticated: boolean;
  role: string;
  recent: boolean;
  evidenceReads: number;
  rateLimitCalls: number;
  rateLimitError: Error | null;
  storeFailure: Error | null;
  contractDrift: boolean;
};
const fresh = (): World => ({
  authenticated: true,
  role: "owner",
  recent: true,
  evidenceReads: 0,
  rateLimitCalls: 0,
  rateLimitError: null,
  storeFailure: null,
  contractDrift: false,
});
let world = fresh();
let bundle: ReturnType<typeof completeBundle> | null = null;
let installed = false;
let apiSecurityErrorClass: new (
  status: number,
  code: string,
  message: string,
  retryAfter?: number
) => Error;

async function loadRoute() {
  if (!installed) {
    installed = true;
    mock.module(mod("node_modules/next-auth/next/index.js"), {
      namedExports: {
        getServerSession: async () => world.authenticated
          ? { user: { id: "owner-1", authenticatedAt: new Date().toISOString() } }
          : null,
      },
    });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/adminAuth.ts"), {
      namedExports: {
        isAdminSession: () => world.authenticated,
        getAdminRole: () => world.role,
      },
    });
    mock.module(mod("lib/adminReauthentication.ts"), {
      namedExports: {
        assertRecentAdminAuthentication: async () => {
          if (!world.recent) throw new Error("reauth");
        },
        isAdminReauthenticationError: (error: unknown) =>
          error instanceof Error && error.message === "reauth",
      },
    });
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const realSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<string, unknown>;
    apiSecurityErrorClass = realSecurity.ApiSecurityError as typeof apiSecurityErrorClass;
    const realRunStore = require(resolve(ROOT, "lib/promptRefinerShadowRunStore.ts")) as {
      PromptRefinerShadowRunError: new (status: number, code: string, message: string) => Error;
      promptRefinerShadowRunErrorResponse: (error: unknown) => Response | null;
    };
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        ...realSecurity,
        consumeApiRateLimit: async () => {
          world.rateLimitCalls += 1;
          if (world.rateLimitError) throw world.rateLimitError;
        },
      },
    });
    mock.module(mod("lib/promptRefinerShadowRunStore.ts"), {
      namedExports: {
        // This is the sole store read. A current-authority or source read
        // would fail after expiry and must never be added to this route.
        readPromptRefinerShadowEvidenceBundle: async () => {
          world.evidenceReads += 1;
          if (world.storeFailure) throw world.storeFailure;
          if (world.contractDrift) {
            throw new realRunStore.PromptRefinerShadowRunError(
              409,
              "PROMPT_REFINER_SHADOW_EVIDENCE_RUN_MISMATCH",
              "The stored run is not bound to the reviewed evidence contract."
            );
          }
          return bundle;
        },
        promptRefinerShadowRunErrorResponse: realRunStore.promptRefinerShadowRunErrorResponse,
      },
    });
  }
  return import(mod("app/api/admin/prompt-refiner/shadow-run/evidence/route.ts"));
}

const get = () => new Request(
  "http://127.0.0.1:3100/api/admin/prompt-refiner/shadow-run/evidence",
  { method: "GET" }
);
const assertNoStore = (response: Response) =>
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");

test.beforeEach(() => {
  world = fresh();
  bundle = null;
});

test("historical GET is owner-only, recent-auth and rate-limited", async () => {
  const route = await loadRoute();
  world.authenticated = false;
  const unauthenticated = await route.GET(get());
  assert.equal(unauthenticated.status, 404);
  assertNoStore(unauthenticated);
  world.authenticated = true;
  world.role = "ops";
  const nonOwner = await route.GET(get());
  assert.equal(nonOwner.status, 403);
  assertNoStore(nonOwner);
  world.role = "owner";
  world.recent = false;
  const staleAuthentication = await route.GET(get());
  assert.equal(staleAuthentication.status, 428);
  assertNoStore(staleAuthentication);
  assert.equal(world.rateLimitCalls, 0);
  assert.equal(world.evidenceReads, 0);
});

test("rate-limit refusal is a no-store 429 before any evidence read", async () => {
  const route = await loadRoute();
  world.rateLimitError = new apiSecurityErrorClass(
    429,
    "API_RATE_LIMITED",
    "Too many requests.",
    60
  );
  const response = await route.GET(get());
  assert.equal(response.status, 429);
  assertNoStore(response);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.deepEqual(await response.json(), {
    error: "Too many requests.",
    code: "API_RATE_LIMITED",
  });
  assert.equal(world.rateLimitCalls, 1);
  assert.equal(world.evidenceReads, 0);
});

test("completed evidence remains readable without current stage or deployment authority", async () => {
  const route = await loadRoute();
  bundle = completeBundle();
  const response = await route.GET(get());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(world.rateLimitCalls, 1);
  assert.equal(world.evidenceReads, 1);
  assert.equal(route.POST, undefined);
  const body = await response.json();
  assert.equal(body.diagnostics.runId, "prompt-refiner-shadow-run-v6");
  assert.equal(body.diagnostics.passedCases, 13);
  assert.equal(body.diagnostics.executionAdmitted, false);
  assert.equal(body.diagnostics.suggestionUiAuthorized, false);
  assert.equal(body.diagnostics.routerCouplingAuthorized, false);
  assert.equal(body.diagnostics.paidRunAuthorized, false);
  assert.equal(body.diagnostics.cases.length, 16);
  assert.deepEqual(body.diagnostics.cases[15].failureReasons, ["required_concept_missing"]);
  assert.doesNotMatch(
    JSON.stringify(body),
    /never expose|sourceText|refinedPrompt|userId|providerError|modelOutput/i
  );
});

test("historical GET returns failed and unknown terminal evidence", async () => {
  const route = await loadRoute();
  for (const includeFailed of [false, true]) {
    bundle = terminalBundle(includeFailed);
    const response = await route.GET(get());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    const { diagnostics } = await response.json();
    assert.equal(diagnostics.gateOutcome, includeFailed ? "fail" : "insufficient_evidence");
    assert.equal(diagnostics.passedCases, includeFailed ? 14 : 15);
    assert.deepEqual(diagnostics.cases[1], {
      caseId: ids[1],
      terminalStatus: "unknown",
      evidenceStatus: "insufficient_evidence",
      failureReasons: [],
    });
    assert.deepEqual(diagnostics.cases[0], {
      caseId: ids[0],
      terminalStatus: includeFailed ? "failed" : "suggested",
      evidenceStatus: includeFailed ? "fail" : "pass",
      failureReasons: includeFailed ? ["not_suggested"] : [],
    });
    assert.equal(diagnostics.executionAdmitted, false);
    assert.equal(diagnostics.paidRunAuthorized, false);
    assert.doesNotMatch(JSON.stringify(diagnostics), /never expose/i);
  }
  assert.equal(world.evidenceReads, 2);
});

test("an incomplete run returns null without creating an authorization", async () => {
  const route = await loadRoute();
  const response = await route.GET(get());
  assert.equal(response.status, 200);
  assertNoStore(response);
  assert.deepEqual(await response.json(), { diagnostics: null });
  assert.equal(world.evidenceReads, 1);
});

test("unexpected store failure returns a no-store 500", async () => {
  const route = await loadRoute();
  world.storeFailure = new Error("unexpected test store failure");
  const errorLog = mock.method(console, "error", () => {});
  try {
    const response = await route.GET(get());
    assert.equal(response.status, 500);
    assertNoStore(response);
    assert.deepEqual(await response.json(), {
      error: "Failed to read Prompt Refiner historical evidence.",
    });
    assert.equal(world.evidenceReads, 1);
  } finally {
    errorLog.mock.restore();
  }
});

test("run contract drift remains a no-store 409 instead of an empty or mutable history", async () => {
  const route = await loadRoute();
  world.contractDrift = true;
  const response = await route.GET(get());
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(await response.json(), {
    error: "The stored run is not bound to the reviewed evidence contract.",
    code: "PROMPT_REFINER_SHADOW_EVIDENCE_RUN_MISMATCH",
  });
  assert.equal(world.evidenceReads, 1);
});
