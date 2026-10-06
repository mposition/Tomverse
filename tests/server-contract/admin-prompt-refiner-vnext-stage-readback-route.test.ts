import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "vnext-stage-readback-route-test";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

let authenticated = true;
let role = "owner";
let recent = true;
let reads = 0;
let rateLimits = 0;
let readError = false;
let installed = false;

async function loadRoute() {
  if (installed) return import(mod("app/api/admin/prompt-refiner/vnext-stage-readback/route.ts"));
  installed = true;
  mock.module(mod("node_modules/next-auth/next/index.js"), {
    namedExports: { getServerSession: async () =>
      authenticated ? { user: { id: "synthetic-owner" } } : null },
  });
  mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
  mock.module(mod("lib/adminAuth.ts"), { namedExports: {
    isAdminSession: () => authenticated,
    getAdminRole: () => role,
  } });
  mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
    assertRecentAdminAuthentication: async () => {
      if (!recent) throw new Error("reauth");
    },
    isAdminReauthenticationError: (error: unknown) =>
      error instanceof Error && error.message === "reauth",
  } });
  mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
    consumeApiRateLimit: async () => { rateLimits++; },
    apiSecurityResponse: () => null,
  } });
  mock.module(mod("lib/readOnlySnapshotTransaction.ts"), { namedExports: {
    readOnlySnapshotTransaction: async (
      work: (tx: object) => Promise<unknown>,
      options: { maxWait: number; timeout: number }
    ) => {
      assert.deepEqual(options, { maxWait: 5_000, timeout: 10_000 });
      if (readError) throw new Error("private database detail");
      return work({});
    },
  } });
  mock.module(mod("lib/promptRefinerVnextOneShotStageReadback.ts"), { namedExports: {
    readPromptRefinerVnextOneShotStage: async (_tx: object, stageId?: string) => {
      reads++;
      assert.equal(stageId, reads % 4 === 2 ?
        "prompt-refiner-vnext-one-shot-v3" :
        reads % 4 === 3 ? "prompt-refiner-vnext-one-shot-v2" :
        reads % 4 === 0 ? "prompt-refiner-vnext-one-shot-v1" : undefined);
      return { stagePresent: false, stageId: null, stageStatus: null,
        runtimeDeploymentId: null, runtimeCommitSha: null,
        stageApprovalAuditLogId: null, runApprovalAuditLogId: null,
        slotCount: 0,
        reservedSlots: 0, consumedSlots: 0, reservationShapeValid: false,
        approvalAuditsValid: false, dispatchAuthorized: false };
    },
  } });
  return import(mod("app/api/admin/prompt-refiner/vnext-stage-readback/route.ts"));
}

const request = () => new Request(
  "http://127.0.0.1:3100/api/admin/prompt-refiner/vnext-stage-readback",
  { method: "GET" }
);
const noStore = (response: Response) =>
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");

test("stage diagnostic is owner-only, recent-auth, rate-limited and GET-only", async () => {
  const route = await loadRoute();
  authenticated = false;
  const anonymous = await route.GET(request());
  assert.equal(anonymous.status, 404);
  noStore(anonymous);
  authenticated = true;
  role = "ops";
  const nonOwner = await route.GET(request());
  assert.equal(nonOwner.status, 403);
  noStore(nonOwner);
  role = "owner";
  recent = false;
  const stale = await route.GET(request());
  assert.equal(stale.status, 428);
  noStore(stale);
  assert.equal(rateLimits, 0);
  assert.equal(reads, 0);
  assert.equal(route.POST, undefined);
});

test("response is content-free; database failure does not leak details", async () => {
  const route = await loadRoute();
  recent = true;
  const response = await route.GET(request());
  assert.equal(response.status, 200);
  noStore(response);
  assert.equal(rateLimits, 1);
  assert.equal(reads, 4);
  const absent = {
    stagePresent: false, stageId: null, stageStatus: null,
    runtimeDeploymentId: null, runtimeCommitSha: null,
    stageApprovalAuditLogId: null, runApprovalAuditLogId: null,
    slotCount: 0,
    reservedSlots: 0, consumedSlots: 0, reservationShapeValid: false,
    approvalAuditsValid: false, dispatchAuthorized: false,
  };
  assert.deepEqual(await response.json(), {
    readback: absent, thirdStage: absent, previousStage: absent, firstStage: absent,
  });
  readError = true;
  const log = mock.method(console, "error", () => {});
  const unavailable = await route.GET(request());
  log.mock.restore();
  assert.equal(unavailable.status, 503);
  noStore(unavailable);
  assert.deepEqual(await unavailable.json(), { error: "Read-back unavailable." });
  assert.equal(reads, 4);
});
