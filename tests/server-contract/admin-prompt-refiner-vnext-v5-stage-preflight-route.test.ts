import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { beforeEach, mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "one-shot-v5-preflight-route-test";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

let owner = true;
let recent = true;
let validOrigin = true;
let bindingFailure: string | null = null;
let predecessorValid = true;
let priceReadFailure = false;
let priceMatches = true;
let auditKeysPresent = true;
let prepared = 0;
let readbacks = 0;
const pins = {
  sourceCommitSha: "a".repeat(40),
  sourceManifestDigest: "b".repeat(64),
  runnerDigest: "c".repeat(64),
  manifestRoot: "d".repeat(64),
  runtimeDeploymentId: "12345678-1234-1234-1234-123456789abc",
  runtimeCommitSha: "a".repeat(40),
  pricePinDigest: "e".repeat(64),
};
const controls = Object.freeze({ rootPinMatches: true,
  runnerPinMatches: true, shadowSignerValid: true, gateSignerValid: true,
  controlsValid: true, runnerTokenValid: true, providerKeyAbsent: true,
  paidGuardValid: true });

mock.module(mod("node_modules/next-auth/next/index.js"), { namedExports: {
  getServerSession: async () => ({ user: { id: "synthetic-owner" } }),
} });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuditIntegrityCore.ts"), { namedExports: {
  adminAuditIntegrityKeys: () => auditKeysPresent ? ["synthetic-test-key"] : [],
} });
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  isAdminSession: () => true,
  getAdminRole: () => owner ? "owner" : "ops",
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
  readLimitedJson: async (request: Request, _limit: number, schema: {
    safeParse: (input: unknown) => { success: boolean; data?: unknown };
  }) => {
    const result = schema.safeParse(await request.json());
    if (!result.success) throw Object.assign(new Error("invalid"),
      { status: 400, code: "INVALID_REQUEST" });
    return result.data;
  },
  apiSecurityResponse: (error: unknown) => {
    const problem = error as { status?: number; code?: string };
    return problem.status === 400 ? Response.json({ code: problem.code },
      { status: 400 }) : null;
  },
} });
mock.module(mod("lib/promptRefinerVnextOneShotStageAdmission.ts"), { namedExports: {
  inspectPromptRefinerVnextOneShotStageControls: () => controls,
  preparePromptRefinerVnextOneShotStageBinding: async () => {
    prepared++;
    if (bindingFailure) throw new Error(bindingFailure);
    return { id: "prompt-refiner-vnext-one-shot-v5" };
  },
} });
mock.module(mod("lib/promptRefinerVnextOneShotV5PredecessorReadback.ts"), { namedExports: {
  inspectPromptRefinerVnextOneShotV5Predecessor: async () => {
    readbacks++;
    return predecessorValid ? { stopAuditLogId: "synthetic-stop" } : null;
  },
} });
mock.module(mod("lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback.ts"), {
  namedExports: { readPromptRefinerVnextOneShotPrice: async () => {
    if (priceReadFailure) throw new Error("vnext_one_shot_price_read_failed");
    return { pricePinMatchesRegistry: priceMatches,
      problems: priceMatches ? [] : ["price_pin_mismatch"] };
  } },
});
mock.module(mod("lib/readOnlySnapshotTransaction.ts"), { namedExports: {
  readOnlySnapshotTransaction: async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({ promptRefinerVnextOneShotStage: {
      findUnique: async () => null,
    } }),
} });

const loadRoute = () => import(mod(
  "app/api/admin/prompt-refiner/vnext-v5-stage-preflight/route.ts"));
const request = (body: object = pins) => new Request(
  "http://127.0.0.1:3100/api/admin/prompt-refiner/vnext-v5-stage-preflight",
  { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) });

beforeEach(() => {
  owner = true;
  recent = true;
  validOrigin = true;
  bindingFailure = null;
  predecessorValid = true;
  priceReadFailure = false;
  priceMatches = true;
  auditKeysPresent = true;
  prepared = 0;
  readbacks = 0;
});

test("preflight requires a recently authenticated owner and strict pins", async () => {
  const route = await loadRoute();
  owner = false;
  assert.equal((await route.POST(request())).status, 403);
  owner = true;
  recent = false;
  assert.equal((await route.POST(request())).status, 428);
  recent = true;
  validOrigin = false;
  assert.equal((await route.POST(request())).status, 403);
  validOrigin = true;
  assert.equal((await route.POST(request({ ...pins, extra: true }))).status, 400);
  assert.equal(prepared, 0);
  assert.equal(readbacks, 0);
});

test("preflight classifies a definite binding refusal without a stage write", async () => {
  const route = await loadRoute();
  bindingFailure = "vnext_one_shot_stage_custody_pin_mismatch";
  const response = await route.POST(request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.bindingValid, false);
  assert.equal(body.bindingFailureClass, bindingFailure);
  assert.equal(body.predecessorValid, null);
  assert.equal(body.retryAuthorized, false);
  assert.equal(body.dispatchAuthorized, false);
  assert.equal(JSON.stringify(body).includes(pins.manifestRoot), false);
  assert.equal(readbacks, 0);
  bindingFailure = null;
});

test("preflight reads predecessor and price without creating stage or slots", async () => {
  const route = await loadRoute();
  const response = await route.POST(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"),
    "private, no-store, max-age=0");
  const body = await response.json();
  assert.equal(body.bindingValid, true);
  assert.equal(body.predecessorValid, true);
  assert.equal(body.priceValid, true);
  assert.equal(body.priceReadAvailable, true);
  assert.equal(body.auditKeyAvailable, true);
  assert.equal(body.stageWriteEnabled, false);
  assert.equal(body.v5Absent, true);
  assert.deepEqual(body.controls, controls);
  assert.equal(body.dispatchAuthorized, false);
  assert.equal(JSON.stringify(body).includes(pins.manifestRoot), false);
  assert.equal(prepared, 1);
  assert.equal(readbacks, 1);
});

test("preflight distinguishes predecessor and price refusal from read failure", async () => {
  const route = await loadRoute();
  predecessorValid = false;
  priceMatches = false;
  let response = await route.POST(request());
  let body = await response.json();
  assert.equal(body.predecessorValid, false);
  assert.equal(body.priceValid, false);
  assert.equal(body.priceReadAvailable, true);
  priceMatches = true;
  priceReadFailure = true;
  response = await route.POST(request());
  body = await response.json();
  assert.equal(body.priceValid, false);
  assert.equal(body.priceReadAvailable, false);
  assert.equal(body.retryAuthorized, false);
  predecessorValid = true;
  priceReadFailure = false;
});

test("preflight reports the stage switch and audit key without disclosing them", async () => {
  const route = await loadRoute();
  const prior = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_V5_STAGE_WRITE_ENABLED;
  try {
    process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_V5_STAGE_WRITE_ENABLED = "1";
    auditKeysPresent = false;
    const body = await (await route.POST(request())).json();
    assert.equal(body.stageWriteEnabled, true);
    assert.equal(body.auditKeyAvailable, false);
    assert.equal(body.retryAuthorized, false);
    assert.equal(JSON.stringify(body).includes("synthetic-test-key"), false);
  } finally {
    if (prior === undefined) {
      delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_V5_STAGE_WRITE_ENABLED;
    } else {
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_V5_STAGE_WRITE_ENABLED = prior;
    }
  }
});
