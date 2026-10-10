import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { beforeEach, mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const world = {
  session: { user: { id: "synthetic-owner" } } as
    { user: { id: string } } | null,
  role: "owner",
  recent: true,
  activationWrites: 0,
  auditWrites: 0,
  resumeWrites: 0,
  rateLimits: 0,
  activationOutcome: "ok" as "ok" | "refused" | "unknown",
  auditOutcome: "ok" as "ok" | "refused" | "unknown",
  resumeOutcome: "ok" as "ok" | "refused" | "unknown",
  activationInput: null as unknown,
  auditInput: null as unknown,
  resumeInput: null as unknown,
};

mock.module("next-auth/next", { namedExports: {
  getServerSession: async () => world.session,
} });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  isAdminSession: () => world.session !== null,
  getAdminRole: () => world.role,
} });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  assertRecentAdminAuthentication: async () => {
    if (!world.recent) throw new Error("synthetic-reauth-required");
  },
  isAdminReauthenticationError: (error: unknown) =>
    error instanceof Error && error.message === "synthetic-reauth-required",
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => { world.rateLimits += 1; },
  apiSecurityResponse: (error: unknown) =>
    error instanceof Error && error.message === "invalid request" ?
      Response.json({ code: "INVALID_REQUEST" }, { status: 400 }) : null,
  readLimitedJson: async (request: Request, limit: number, schema: {
    safeParse: (value: unknown) =>
      { success: true; data: unknown } | { success: false };
  }) => {
    const raw = await request.text();
    if (raw.length > limit) throw new Error("invalid request");
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new Error("invalid request"); }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error("invalid request");
    return parsed.data;
  },
} });
mock.module(mod("lib/requestOrigin.ts"), { namedExports: {
  hasValidMutationOrigin: (request: Request) =>
    request.headers.get("origin") === "https://tomverse.test",
} });
mock.module(mod("lib/promptRefinerVnextOneShotV5Recovery.ts"), {
  namedExports: {
    V4_STAGE_ID: "prompt-refiner-vnext-one-shot-v4",
    V5_STAGE_ID: "prompt-refiner-vnext-one-shot-v5",
  },
});
mock.module(mod("lib/promptRefinerProductReleaseStore.ts"), { namedExports: {
  activatePromptRefinerProductRelease: async (input: unknown) => {
    world.activationWrites += 1; world.activationInput = input;
    if (world.activationOutcome === "refused") {
      throw new Error("prompt_refiner_product_gate_invalid");
    }
    if (world.activationOutcome === "unknown") {
      throw new Error("synthetic database outcome unknown");
    }
    return { activationId: "synthetic-activation" };
  },
  recordPromptRefinerProductLimitedAudit: async (input: unknown) => {
    world.auditWrites += 1; world.auditInput = input;
    if (world.auditOutcome === "refused") {
      throw new Error("prompt_refiner_product_limited_audit_invalid");
    }
    if (world.auditOutcome === "unknown") {
      throw new Error("synthetic database outcome unknown");
    }
    return { receiptId: "synthetic-limited-audit" };
  },
  resumePromptRefinerProductAuto: async (input: unknown) => {
    world.resumeWrites += 1; world.resumeInput = input;
    if (world.resumeOutcome === "refused") {
      throw new Error("prompt_refiner_product_auto_resume_stale");
    }
    if (world.resumeOutcome === "unknown") {
      throw new Error("synthetic database outcome unknown");
    }
    return { resumeAuditLogId: "synthetic-resume", autoEnabled: true,
      generation: 8 };
  },
} });

const activationRoute = import(mod(
  "app/api/admin/prompt-refiner/product-activation/route.ts"));
const auditRoute = import(mod(
  "app/api/admin/prompt-refiner/product-limited-audit/route.ts"));
const resumeRoute = import(mod(
  "app/api/admin/prompt-refiner/product-auto-resume/route.ts"));

const activationBody = {
  stageId: "prompt-refiner-vnext-one-shot-v5",
  gateAuditLogId: "gate-audit",
  dispositionAuditLogId: "disposition-audit",
  limitedAuditReceiptId: "limited-audit",
  runtimeCommitSha: "a".repeat(40),
  runtimeDeploymentId: "11111111-1111-4111-8111-111111111111",
  confirmation: "ACTIVATE_EXACT_REFINER_PRODUCT_DEPLOYMENT",
};
const auditBody = {
  stageId: "prompt-refiner-vnext-one-shot-v5",
  gateAuditLogId: "gate-audit",
  dispositionAuditLogId: "disposition-audit",
  reviewedCaseCount: 3,
  confirmation: "RECORD_CONTENT_FREE_REFINER_LIMITED_AUDIT",
};
const resumeBody = {
  expectedGeneration: 7,
  expectedReasonCode: "unknown_dispatch_or_cost",
  expectedPauseAuditLogId: "pause-audit",
  confirmation: "RESUME_REFINER_PRODUCT_AUTO_AFTER_OPERATOR_REVIEW",
};
const request = (path: string, body: unknown, origin = "https://tomverse.test") =>
  new Request(`https://tomverse.test${path}`, { method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body) });

beforeEach(() => {
  world.session = { user: { id: "synthetic-owner" } };
  world.role = "owner"; world.recent = true;
  world.activationWrites = 0; world.auditWrites = 0; world.resumeWrites = 0;
  world.rateLimits = 0;
  world.activationOutcome = "ok"; world.auditOutcome = "ok";
  world.resumeOutcome = "ok";
  world.activationInput = null; world.auditInput = null; world.resumeInput = null;
  delete process.env.PROMPT_REFINER_PRODUCT_ACTIVATION_WRITE_ENABLED;
  delete process.env.PROMPT_REFINER_PRODUCT_LIMITED_AUDIT_WRITE_ENABLED;
  delete process.env.PROMPT_REFINER_PRODUCT_AUTO_RESUME_WRITE_ENABLED;
});

test("product release mutations require hidden owner, origin, recent auth and write gates", async () => {
  const activation = await activationRoute; const audit = await auditRoute;
  const resume = await resumeRoute;
  const cases = [
    { session: null, role: "owner", recent: true, origin: "https://tomverse.test", status: 404 },
    { session: { user: { id: "synthetic-owner" } }, role: "admin", recent: true,
      origin: "https://tomverse.test", status: 403 },
    { session: { user: { id: "synthetic-owner" } }, role: "owner", recent: true,
      origin: "https://cross-site.test", status: 403 },
    { session: { user: { id: "synthetic-owner" } }, role: "owner", recent: false,
      origin: "https://tomverse.test", status: 428 },
  ] as const;
  for (const route of [
    { post: activation.POST, path: "/api/admin/prompt-refiner/product-activation",
      body: activationBody },
    { post: audit.POST, path: "/api/admin/prompt-refiner/product-limited-audit",
      body: auditBody },
    { post: resume.POST, path: "/api/admin/prompt-refiner/product-auto-resume",
      body: resumeBody },
  ]) {
    for (const item of cases) {
      world.session = item.session; world.role = item.role;
      world.recent = item.recent;
      const response = await route.post(request(route.path, route.body, item.origin));
      assert.equal(response.status, item.status);
      assert.equal(response.headers.get("cache-control"),
        "private, no-store, max-age=0");
      assert.equal(world.activationWrites + world.auditWrites +
        world.resumeWrites, 0);
    }
    world.session = { user: { id: "synthetic-owner" } };
    world.role = "owner"; world.recent = true;
    const disabled = await route.post(request(route.path, route.body));
    assert.equal(disabled.status, 409);
    assert.equal(world.activationWrites + world.auditWrites +
      world.resumeWrites, 0);
  }
});

test("only strict content-free activation and limited-audit bodies reach writers", async () => {
  const activation = await activationRoute; const audit = await auditRoute;
  process.env.PROMPT_REFINER_PRODUCT_ACTIVATION_WRITE_ENABLED = "1";
  process.env.PROMPT_REFINER_PRODUCT_LIMITED_AUDIT_WRITE_ENABLED = "1";
  for (const invalid of [
    { ...activationBody, runtimeCommitSha: "not-a-sha" },
    { ...activationBody, confirmation: "yes" },
    { ...activationBody, extra: true },
  ]) {
    assert.equal((await activation.POST(request(
      "/api/admin/prompt-refiner/product-activation", invalid))).status, 400);
  }
  for (const invalid of [
    { ...auditBody, reviewedCaseCount: 9 },
    { ...auditBody, confirmation: "yes" },
    { ...auditBody, rawCase: "must never cross this boundary" },
  ]) {
    assert.equal((await audit.POST(request(
      "/api/admin/prompt-refiner/product-limited-audit", invalid))).status, 400);
  }
  assert.equal(world.activationWrites + world.auditWrites, 0);
  assert.equal(world.rateLimits, 0);

  const activated = await activation.POST(request(
    "/api/admin/prompt-refiner/product-activation", activationBody));
  assert.equal(activated.status, 201);
  assert.deepEqual(await activated.json(), { activationId: "synthetic-activation" });
  const audited = await audit.POST(request(
    "/api/admin/prompt-refiner/product-limited-audit", auditBody));
  assert.equal(audited.status, 201);
  assert.deepEqual(await audited.json(), { receiptId: "synthetic-limited-audit" });
  assert.equal(world.activationWrites, 1); assert.equal(world.auditWrites, 1);
  assert.equal(world.rateLimits, 2);
  assert.equal(JSON.stringify(world.activationInput).includes("confirmation"), false);
  assert.equal(JSON.stringify(world.auditInput).includes("confirmation"), false);
  assert.equal(JSON.stringify(world.auditInput).includes("rawCase"), false);
});

test("refused and unknown release writes are non-retryable safe failures", async () => {
  const activation = await activationRoute; const audit = await auditRoute;
  process.env.PROMPT_REFINER_PRODUCT_ACTIVATION_WRITE_ENABLED = "1";
  process.env.PROMPT_REFINER_PRODUCT_LIMITED_AUDIT_WRITE_ENABLED = "1";
  for (const item of [
    { post: activation.POST, path: "/api/admin/prompt-refiner/product-activation",
      body: activationBody, outcome: "activationOutcome" as const,
      counter: "activationWrites" as const, prefix: "PROMPT_REFINER_PRODUCT_ACTIVATION" },
    { post: audit.POST, path: "/api/admin/prompt-refiner/product-limited-audit",
      body: auditBody, outcome: "auditOutcome" as const,
      counter: "auditWrites" as const, prefix: "PROMPT_REFINER_LIMITED_AUDIT" },
  ]) {
    world[item.outcome] = "refused";
    const refused = await item.post(request(item.path, item.body));
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { code: `${item.prefix}_REFUSED`,
      retryAuthorized: false, humanReviewRequired: true });
    assert.equal(world[item.counter], 1);

    world[item.outcome] = "unknown";
    const unknown = await item.post(request(item.path, item.body));
    assert.equal(unknown.status, 503);
    assert.deepEqual(await unknown.json(), { code: `${item.prefix}_OUTCOME_UNKNOWN`,
      retryAuthorized: false, humanReviewRequired: true });
    assert.equal(world[item.counter], 2);
  }
});

test("Auto resume binds exact paused evidence and never retries an unknown write", async () => {
  const resume = await resumeRoute;
  assert.equal((await resume.POST(request(
    "/api/admin/prompt-refiner/product-auto-resume", resumeBody))).status, 409);
  assert.equal(world.resumeWrites, 0);
  process.env.PROMPT_REFINER_PRODUCT_AUTO_RESUME_WRITE_ENABLED = "1";
  for (const invalid of [
    { ...resumeBody, expectedGeneration: 0 },
    { ...resumeBody, expectedReasonCode: "something_else" },
    { ...resumeBody, expectedPauseAuditLogId: "" },
    { ...resumeBody, confirmation: "yes" },
    { ...resumeBody, operatorObserved: true },
  ]) {
    assert.equal((await resume.POST(request(
      "/api/admin/prompt-refiner/product-auto-resume", invalid))).status, 400);
  }
  assert.equal(world.resumeWrites, 0);
  const accepted = await resume.POST(request(
    "/api/admin/prompt-refiner/product-auto-resume", resumeBody));
  assert.equal(accepted.status, 201);
  assert.deepEqual(await accepted.json(), { resumeAuditLogId: "synthetic-resume",
    autoEnabled: true, generation: 8 });
  assert.equal(world.resumeWrites, 1);
  assert.equal(JSON.stringify(world.resumeInput).includes("confirmation"), false);

  world.resumeOutcome = "refused";
  const refused = await resume.POST(request(
    "/api/admin/prompt-refiner/product-auto-resume", resumeBody));
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), {
    code: "PROMPT_REFINER_PRODUCT_AUTO_RESUME_REFUSED",
    retryAuthorized: false, humanReviewRequired: true });
  world.resumeOutcome = "unknown";
  const unknown = await resume.POST(request(
    "/api/admin/prompt-refiner/product-auto-resume", resumeBody));
  assert.equal(unknown.status, 503);
  assert.deepEqual(await unknown.json(), {
    code: "PROMPT_REFINER_PRODUCT_AUTO_RESUME_OUTCOME_UNKNOWN",
    retryAuthorized: false, humanReviewRequired: true });
  assert.equal(world.resumeWrites, 3);
});
