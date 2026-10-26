import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
const endpoint = "https://tomverse.test/api/admin/amux/ideas/session-budget-resolution";
const claimId = "00000000-0000-4000-8000-000000000001";
let session = null;
let role = "owner";
let readCount = 0;
let listCount = 0;
let listSession = null;
let writeCount = 0;
let readError = null;
let writeError = null;
let originAllowed = true;

class AmuxSessionBudgetResolutionError extends Error {
  constructor(code) { super(code); this.code = code; }
}
mock.module("next-auth/next", { namedExports: {
  getServerSession: async () => session,
} });
mock.module("@/lib/adminAuth", { namedExports: {
  isAdminSession: (value) => value?.user?.id === "owner-id",
  getAdminRole: () => role,
} });
mock.module("@/lib/adminReauthentication", { namedExports: {
  isAdminReauthenticationError: (error) => error?.code === "reauth",
} });
mock.module("@/lib/apiSecurity", { namedExports: {
  apiSecurityResponse: (error) => error?.name === "ZodError"
    ? new Response(JSON.stringify({ error: "invalid" }), { status: 400 }) : null,
  consumeApiRateLimit: async () => {},
  readLimitedJson: async (request, _limit, schema) =>
    schema.parse(await request.json()),
} });
mock.module("@/lib/auth", { namedExports: { authOptions: {} } });
mock.module("@/lib/amux/ideaSessionAnalysisBudgetResolutionService", {
  namedExports: {
    AmuxSessionBudgetResolutionError,
    listAmuxSessionBudgetUnknownClaims: async (_tx, input) => {
      listCount += 1;
      listSession = input.session;
      return { rows: [{ claimId, invocationOrdinal: 0,
        budgetMode: "max_shadow", createdAt: "2026-10-20T00:00:00.000Z" }],
      total: 1, limit: 20 };
    },
    readAmuxSessionBudgetResolution: async () => {
      readCount += 1;
      if (readError) throw readError;
      return { claimId, status: "outcome_unknown", reservedMicroUsd: "5000",
        readbackDigest: "a".repeat(64) };
    },
    commitAmuxSessionBudgetUnknownResolution: async () => {
      writeCount += 1;
      if (writeError) throw writeError;
      return { claimId, status: "owner_consumed", settledMicroUsd: "5000" };
    },
  },
});
mock.module("@/lib/prisma", { namedExports: {
  prisma: { $transaction: async (operation) => operation({}) },
} });
mock.module("@/lib/requestOrigin", { namedExports: {
  hasValidMutationOrigin: () => originAllowed,
} });

const routePromise = import(mod("app/api/admin/amux/ideas/session-budget-resolution/route.ts"));
const readSwitch = "TOMVERSE_AMUX_V19_SESSION_BUDGET_RESOLUTION_READ";
const writeSwitch = "TOMVERSE_AMUX_V19_SESSION_BUDGET_RESOLUTION_WRITE";
const priorRead = process.env[readSwitch];
const priorWrite = process.env[writeSwitch];
test.after(() => {
  if (priorRead === undefined) delete process.env[readSwitch];
  else process.env[readSwitch] = priorRead;
  if (priorWrite === undefined) delete process.env[writeSwitch];
  else process.env[writeSwitch] = priorWrite;
});

test("owner route refuses anonymous, non-owner and disabled requests before DB access", async () => {
  const route = await routePromise;
  readCount = 0;
  session = null;
  assert.equal((await route.GET(new Request(`${endpoint}?claimId=${claimId}`))).status, 404);
  session = { user: { id: "owner-id" } };
  role = "admin";
  assert.equal((await route.GET(new Request(`${endpoint}?claimId=${claimId}`))).status, 403);
  role = "owner";
  delete process.env[readSwitch];
  assert.equal((await route.GET(new Request(`${endpoint}?claimId=${claimId}`))).status, 409);
  assert.equal(readCount, 0);
});

test("owner GET requires one exact claim ID and returns content-free unknown readback", async () => {
  const route = await routePromise;
  readCount = 0;
  session = { user: { id: "owner-id" } };
  role = "owner";
  process.env[readSwitch] = "enabled";
  for (const query of ["", `?claimId=${claimId}&claimId=${claimId}`,
    `?claimId=${claimId}&extra=x`, "?claimId=invalid"]) {
    assert.equal((await route.GET(new Request(endpoint + query))).status, 400);
  }
  const response = await route.GET(new Request(`${endpoint}?claimId=${claimId}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0");
  assert.deepEqual(await response.json(), { state: "readback",
    readback: { claimId, status: "outcome_unknown",
      reservedMicroUsd: "5000", readbackDigest: "a".repeat(64) },
    retryAutomatically: false });
  assert.equal(readCount, 1);
});

test("owner POST is separately switched, same-origin and exact-body gated", async () => {
  const route = await routePromise;
  session = { user: { id: "owner-id" } };
  role = "owner";
  writeCount = 0;
  originAllowed = true;
  process.env[readSwitch] = "enabled";
  const body = { claimId, verification: "not_proven",
    localEvidenceDigest: "b".repeat(64), readbackDigest: "a".repeat(64),
    ownerConfirmed: true };
  const send = (headers, value = body) => route.POST(new Request(endpoint, {
    method: "POST", headers, body: JSON.stringify(value),
  }));
  delete process.env[writeSwitch];
  assert.equal((await send({ "content-type": "application/json" })).status, 409);
  process.env[writeSwitch] = "enabled";
  originAllowed = false;
  assert.equal((await send({ "content-type": "application/json" })).status, 403);
  originAllowed = true;
  assert.equal((await send({ "content-type": "text/plain" })).status, 415);
  assert.equal((await send({ "content-type": "application/json" },
    { ...body, readbackDigest: undefined })).status, 400);
  assert.equal(writeCount, 0);
  const response = await send({ "content-type": "application/json" });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).retryAutomatically, false);
  assert.equal(writeCount, 1);
  try {
    writeError = { code: "reauth" };
    const stepUp = await send({ "content-type": "application/json" });
    assert.equal(stepUp.status, 428);
  } finally { writeError = null; }
});

test("owner GET maps integrity failures without exposing claim content", async () => {
  const route = await routePromise;
  session = { user: { id: "owner-id" } };
  role = "owner";
  process.env[readSwitch] = "enabled";
  try {
    for (const [error, status] of [
      [new AmuxSessionBudgetResolutionError("integrity_unavailable"), 503],
      [new AmuxSessionBudgetResolutionError("not_resolvable"), 409],
    ]) {
      readError = error;
      const response = await route.GET(new Request(`${endpoint}?claimId=${claimId}`));
      assert.equal(response.status, status);
      assert.equal(JSON.stringify(await response.json()).includes("5000"), false);
    }
  } finally { readError = null; }
});

test("owner GET lists unresolved unknown claims only for the exact list query", async () => {
  const route = await routePromise;
  listCount = 0;
  readCount = 0;
  session = { user: { id: "owner-id" } };
  role = "admin";
  assert.equal((await route.GET(new Request(`${endpoint}?list=outcome_unknown`))).status, 403);
  role = "owner";
  delete process.env[readSwitch];
  const disabled = await route.GET(new Request(`${endpoint}?list=outcome_unknown`));
  assert.equal(disabled.status, 409);
  assert.equal((await disabled.json()).error, "session_budget_resolution_read_disabled");
  process.env[readSwitch] = "enabled";
  for (const query of ["?list=in_flight", "?list=outcome_unknown&list=outcome_unknown",
    `?list=outcome_unknown&claimId=${claimId}`]) {
    assert.equal((await route.GET(new Request(endpoint + query))).status, 400, query);
  }
  assert.equal(listCount, 0);
  const response = await route.GET(new Request(`${endpoint}?list=outcome_unknown`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0");
  assert.deepEqual(await response.json(), { state: "unknown_list",
    rows: [{ claimId, invocationOrdinal: 0, budgetMode: "max_shadow",
      createdAt: "2026-10-20T00:00:00.000Z" }], total: 1, limit: 20,
    retryAutomatically: false });
  assert.equal(listCount, 1);
  assert.equal(listSession, session);
  assert.equal(readCount, 0, "a list never reads one claim's ledger");
});
