import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "one-shot-preregistration-route-test";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

let authenticated = true;
let role = "owner";
let recent = true;
let validOrigin = true;
let prepares = 0;
let writes = 0;
let reads = 0;
let recordFailure: string | null = null;
let readFailure: string | null = null;
let currentPinsMatch = true;
let mocksInstalled = false;
const pins = {
  sourceCommitSha: "a".repeat(40), sourceManifestDigest: "b".repeat(64),
  runnerDigest: "c".repeat(64), pricePinDigest: "d".repeat(64),
  confirmation: "PREREGISTER_VNEXT_ONE_SHOT_CANDIDATE",
};

async function loadRoute() {
  if (mocksInstalled) {
    return import(mod("app/api/admin/prompt-refiner/vnext-preregistration/route.ts"));
  }
  mocksInstalled = true;
  mock.module(mod("node_modules/next-auth/next/index.js"), { namedExports: {
    getServerSession: async () => authenticated ? { user: { id: "synthetic-owner" } } : null,
  } });
  mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
  mock.module(mod("lib/adminAuth.ts"), { namedExports: {
    isAdminSession: () => authenticated, getAdminRole: () => role,
  } });
  mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
    assertRecentAdminAuthentication: async () => {
      if (!recent) throw new Error("reauth");
    },
    isAdminReauthenticationError: (error: unknown) =>
      error instanceof Error && error.message === "reauth",
  } });
  mock.module(mod("lib/requestOrigin.ts"), { namedExports: {
    hasValidMutationOrigin: () => validOrigin,
  } });
  mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
    consumeApiRateLimit: async () => {},
    readLimitedJson: async (request: Request, limit: number, schema: {
      safeParse: (value: unknown) => { success: boolean; data?: unknown };
    }) => {
      assert.equal(limit, 1024);
      const parsed = schema.safeParse(await request.json());
      if (!parsed.success) throw Object.assign(new Error("bad body"),
        { status: 400, code: "INVALID_REQUEST" });
      return parsed.data;
    },
    apiSecurityResponse: (error: unknown) => {
      const problem = error as { status?: number; code?: string };
      return problem.status === 400 ? Response.json({ code: problem.code },
        { status: 400 }) : null;
    },
  } });
  mock.module(mod("lib/promptRefinerVnextOneShotPreregistration.ts"), { namedExports: {
    readPromptRefinerVnextOneShotPreregistration: async (owner: string) => {
      assert.equal(owner, "synthetic-owner");
      reads++;
      if (readFailure) throw new Error(readFailure);
      return { preregistrationRecorded: true,
        preregistrationAuditLogId: "opaque-audit-id", currentPinsMatch,
        dispatchAuthorized: false };
    },
    preparePromptRefinerVnextOneShotPreregistration: async (input: unknown) => {
      prepares++;
      assert.deepEqual(input, pins);
      return pins;
    },
    recordPromptRefinerVnextOneShotPreregistration: async () => {
      writes++;
      if (recordFailure) throw new Error(recordFailure);
      return { auditLogId: "opaque-audit-id", dispatchAuthorized: false };
    },
  } });
  return import(mod("app/api/admin/prompt-refiner/vnext-preregistration/route.ts"));
}

const request = (body: object = pins) => new Request(
  "http://127.0.0.1:3100/api/admin/prompt-refiner/vnext-preregistration",
  { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) },
);

test("preregistration is owner-only, recent-auth and default-off", async () => {
  const route = await loadRoute();
  delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_PREREGISTRATION_WRITE_ENABLED;
  authenticated = false;
  assert.equal((await route.POST(request())).status, 404);
  authenticated = true;
  role = "ops";
  assert.equal((await route.POST(request())).status, 403);
  role = "owner";
  recent = false;
  assert.equal((await route.POST(request())).status, 428);
  recent = true;
  validOrigin = false;
  assert.equal((await route.POST(request())).status, 403);
  validOrigin = true;
  const off = await route.POST(request());
  assert.equal(off.status, 409);
  assert.equal(off.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(prepares, 0);
  assert.equal(writes, 0);
});

test("strict pins record once through the server and reveal no candidate content", async () => {
  const route = await loadRoute();
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_PREREGISTRATION_WRITE_ENABLED = "1";
  const invalid = await route.POST(request({ ...pins, manifestRoot: "e".repeat(64) }));
  assert.equal(invalid.status, 400);
  assert.equal(writes, 0);
  const response = await route.POST(request());
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(await response.json(), {
    preregistrationAuditLogId: "opaque-audit-id", dispatchAuthorized: false,
  });
  assert.equal(prepares, 1);
  assert.equal(writes, 1);
  recordFailure = "vnext_one_shot_preregistration_already_recorded";
  const refused = await route.POST(request());
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { code: "PREREGISTRATION_REFUSED" });
  assert.equal(refused.headers.get("cache-control"), "private, no-store, max-age=0");
  recordFailure = null;
  delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_PREREGISTRATION_WRITE_ENABLED;
});

test("read-back is owner-only, recent-auth, no-store and available with writes off", async () => {
  const route = await loadRoute();
  const get = new Request(request().url);
  authenticated = false;
  assert.equal((await route.GET(get)).status, 404);
  authenticated = true;
  role = "ops";
  assert.equal((await route.GET(get)).status, 403);
  role = "owner";
  recent = false;
  assert.equal((await route.GET(get)).status, 428);
  recent = true;
  assert.equal(reads, 0);
  const writesBefore = writes;
  const response = await route.GET(get);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(await response.json(), { readback: {
    preregistrationRecorded: true, preregistrationAuditLogId: "opaque-audit-id",
    currentPinsMatch: true, dispatchAuthorized: false,
  } });
  assert.equal(reads, 1);
  assert.equal(writes, writesBefore);
  currentPinsMatch = false;
  const drift = await route.GET(get);
  assert.equal(drift.status, 200);
  assert.deepEqual(await drift.json(), { readback: {
    preregistrationRecorded: true, preregistrationAuditLogId: "opaque-audit-id",
    currentPinsMatch: false, dispatchAuthorized: false,
  } });
  currentPinsMatch = true;
  readFailure = "vnext_one_shot_preregistration_record_unverifiable";
  const corrupt = await route.GET(get);
  assert.equal(corrupt.status, 409);
  assert.deepEqual(await corrupt.json(), { code: "PREREGISTRATION_RECORD_UNVERIFIABLE" });
  readFailure = "vnext_one_shot_preregistration_source_unavailable";
  assert.equal((await route.GET(get)).status, 503);
  readFailure = "private database detail";
  const unavailable = await route.GET(get);
  assert.equal(unavailable.status, 503);
  const unavailableBody = await unavailable.json();
  assert.deepEqual(unavailableBody, {
    code: "PREREGISTRATION_READBACK_UNAVAILABLE",
  });
  assert.ok(!JSON.stringify(unavailableBody).includes("private database"));
  readFailure = null;
});
