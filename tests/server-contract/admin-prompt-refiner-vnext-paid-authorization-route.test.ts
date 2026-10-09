import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "one-shot-paid-route-test";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

let authenticated = true;
let role = "owner";
let recent = true;
let validOrigin = true;
let failure: string | null = null;
let writes = 0;
let rateLimits = 0;
const pins = {
  stageApprovalAuditLogId: "synthetic-stage-audit",
  runApprovalAuditLogId: "synthetic-run-audit",
  shadowAuditLogId: "synthetic-shadow-audit",
  sourceCommitSha: "a".repeat(40), sourceManifestDigest: "b".repeat(64),
  runnerDigest: "c".repeat(64), manifestRoot: "d".repeat(64),
  runtimeDeploymentId: "33333333-3333-4333-8333-333333333333",
  runtimeCommitSha: "e".repeat(40), pricePinDigest: "f".repeat(64),
};
const body = { ...pins,
  confirmation: "AUTHORIZE_VNEXT_ONE_SHOT_V3_PAID_DISPATCH_AFTER_B06" };

mock.module(mod("node_modules/next-auth/next/index.js"), { namedExports: {
  getServerSession: async () => authenticated ?
    { user: { id: "synthetic-owner" } } : null,
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
  consumeApiRateLimit: async () => { rateLimits++; },
  readLimitedJson: async (request: Request, _limit: number,
    schema: { parse: (value: unknown) => unknown }) => schema.parse(await request.json()),
  apiSecurityResponse: (error: unknown) => error instanceof z.ZodError
    ? Response.json({ code: "INVALID_REQUEST" }, { status: 400 }) : null,
} });
mock.module(mod("lib/promptRefinerVnextOneShotPaidAuthorization.ts"), {
  namedExports: { approvePromptRefinerVnextOneShotPaidDispatch: async (input: {
    expected: Record<string, unknown>;
    stageId?: string;
  }) => {
    writes++;
    assert.deepEqual(input.expected, pins);
    if (failure) throw new Error(failure);
    return { stageId: input.stageId ?? "prompt-refiner-vnext-one-shot-v4",
      paidAuthorizationAuditLogId: "synthetic-paid-audit",
      dispatchAuthorized: false };
  } },
});
const loadRoute = () => import(
  mod("app/api/admin/prompt-refiner/vnext-paid-authorization/route.ts"));
const request = (value: object = body) => new Request(
  "http://127.0.0.1:3100/api/admin/prompt-refiner/vnext-paid-authorization",
  { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(value) });

test("paid approval route is owner-only, step-up, origin and switch guarded", async () => {
  const route = await loadRoute();
  delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_PAID_APPROVAL_WRITE_ENABLED;
  authenticated = false;
  assert.equal((await route.POST(request())).status, 404);
  authenticated = true; role = "ops";
  assert.equal((await route.POST(request())).status, 403);
  role = "owner"; recent = false;
  assert.equal((await route.POST(request())).status, 428);
  recent = true; validOrigin = false;
  assert.equal((await route.POST(request())).status, 403);
  validOrigin = true;
  assert.equal((await route.POST(request())).status, 409);
  assert.equal(writes, 0);
  assert.equal(rateLimits, 0);
});

test("paid approval requires exact confirmation and maps definite and unknown outcomes", async () => {
  const route = await loadRoute();
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_PAID_APPROVAL_WRITE_ENABLED = "1";
  assert.equal((await route.POST(request({ ...body, confirmation: true }))).status, 400);
  assert.equal((await route.POST(request({ ...body, sourceText: "forbidden" }))).status, 400);
  assert.equal(writes, 0);
  assert.equal(rateLimits, 0);
  const accepted = await route.POST(request());
  assert.equal(accepted.status, 201);
  assert.deepEqual(await accepted.json(), { stageId: "prompt-refiner-vnext-one-shot-v4",
    paidAuthorizationAuditLogId: "synthetic-paid-audit", dispatchAuthorized: false });
  failure = "vnext_one_shot_paid_approval_shadow_unavailable";
  const refused = await route.POST(request());
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).retryAuthorized, false);
  failure = "synthetic ambiguous commit";
  const unknown = await route.POST(request());
  assert.equal(unknown.status, 503);
  assert.deepEqual(await unknown.json(), { code: "PAID_APPROVAL_OUTCOME_UNKNOWN",
    retryAuthorized: false, humanReviewRequired: true });
  assert.equal(writes, 3);
  assert.equal(rateLimits, 3);
});

test("v5 paid approval cannot reuse the v4 confirmation", async () => {
  const route = await loadRoute();
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_PAID_APPROVAL_WRITE_ENABLED = "1";
  failure = null;
  const before = writes;
  const stageId = "prompt-refiner-vnext-one-shot-v5";
  assert.equal((await route.POST(request({ ...body, stageId }))).status, 400);
  assert.equal((await route.POST(request({ ...body,
    confirmation: "AUTHORIZE_VNEXT_ONE_SHOT_NEW_V5_PAID_DISPATCH_80_SLOTS" }))).status, 400);
  assert.equal(writes, before);
  const approved = await route.POST(request({ ...body, stageId,
    confirmation: "AUTHORIZE_VNEXT_ONE_SHOT_NEW_V5_PAID_DISPATCH_80_SLOTS" }));
  assert.equal(approved.status, 201);
  assert.equal((await approved.json()).stageId, stageId);
  assert.equal(writes, before + 1);
  delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_PAID_APPROVAL_WRITE_ENABLED;
});
