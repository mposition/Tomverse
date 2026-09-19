import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  PROMPT_REFINER_STAGE_CONFIRMATION,
  promptRefinerStagePreviewBindingDigest,
} from "../../lib/promptRefinerStageAdmissionCore.ts";
import { requiresMutationOriginCheck } from "../../lib/requestOrigin.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.NEXTAUTH_SECRET ||= "prompt-refiner-route-test";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

type World = {
  authenticated: boolean;
  role: string;
  recent: boolean;
  rateLimitCalls: number;
  previewCalls: number;
  createCalls: number;
  auditWrites: number;
  stageWrites: number;
  lastCreate: unknown;
  runtimeDeploymentId: string;
};

const fresh = (): World => ({
  authenticated: true,
  role: "owner",
  recent: true,
  rateLimitCalls: 0,
  previewCalls: 0,
  createCalls: 0,
  auditWrites: 0,
  stageWrites: 0,
  lastCreate: null,
  runtimeDeploymentId: "deployment-1",
});
let world = fresh();
let installed = false;

const previewFacts = {
  stageId: "prompt-refiner-shadow-v1",
  status: "ready_for_explicit_cost_approval",
  proposalDigest: `sha256:${"1".repeat(64)}`,
  runtimeSourceManifestDigest: `sha256:${"2".repeat(64)}`,
  executionManifestDigest: `sha256:${"3".repeat(64)}`,
  environment: "staging",
  deploymentId: "deployment-1",
  commitSha: "a".repeat(40),
  perRequestCostMicroUsd: 24916,
  maxReservations: 100,
  costCeilingMicroUsd: 2491600,
  approvalTtlMinutes: 60,
} as const;

const preview = {
  ...previewFacts,
  previewBindingDigest: promptRefinerStagePreviewBindingDigest({
    environment: previewFacts.environment,
    deploymentId: previewFacts.deploymentId,
    commitSha: previewFacts.commitSha,
    proposalDigest: previewFacts.proposalDigest,
    runtimeSourceManifestDigest: previewFacts.runtimeSourceManifestDigest,
    executionManifestDigest: previewFacts.executionManifestDigest,
    perRequestCostMicroUsd: previewFacts.perRequestCostMicroUsd,
    maxReservations: previewFacts.maxReservations,
    costCeilingMicroUsd: previewFacts.costCeilingMicroUsd,
    approvalTtlMinutes: previewFacts.approvalTtlMinutes,
  }),
  confirmation: PROMPT_REFINER_STAGE_CONFIRMATION,
  executionAdmitted: false,
  productAdapterReady: false,
};

const fakeStage = {
  id: preview.stageId,
  status: "approved",
  proposalDigest: preview.proposalDigest,
  runtimeSourceManifestDigest: preview.runtimeSourceManifestDigest,
  executionManifestDigest: preview.executionManifestDigest,
  runtimeEnvironment: "staging",
  runtimeDeploymentId: "deployment-1",
  runtimeCommitSha: "a".repeat(40),
  approvedAt: new Date("2026-09-17T00:00:00.000Z"),
  approvalExpiresAt: new Date("2026-09-17T01:00:00.000Z"),
  authorizationAuditLogId: "audit-1",
};

async function loadRoute() {
  if (!installed) {
    installed = true;
    mock.module(mod("node_modules/next-auth/next/index.js"), {
      namedExports: {
        getServerSession: async () =>
          world.authenticated
            ? { user: { id: "owner-1", email: "owner@example.com", authenticatedAt: new Date().toISOString() } }
            : null,
      },
    });
    mock.module(mod("lib/auth.ts"), {
      namedExports: { authOptions: {} },
    });
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
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        ...realSecurity,
        consumeApiRateLimit: async () => {
          world.rateLimitCalls += 1;
        },
      },
    });
    mock.module(mod("lib/promptRefinerStageAdmission.ts"), {
      namedExports: {
        promptRefinerStagePreview: async () => {
          world.previewCalls += 1;
          return preview;
        },
        createPromptRefinerReservationStage: async (input: unknown) => {
          world.createCalls += 1;
          world.lastCreate = input;
          const expected = (input as { expected: { previewBindingDigest: string } }).expected;
          const currentBindingDigest = promptRefinerStagePreviewBindingDigest({
            environment: preview.environment,
            deploymentId: world.runtimeDeploymentId,
            commitSha: preview.commitSha,
            proposalDigest: preview.proposalDigest,
            runtimeSourceManifestDigest: preview.runtimeSourceManifestDigest,
            executionManifestDigest: preview.executionManifestDigest,
            perRequestCostMicroUsd: preview.perRequestCostMicroUsd,
            maxReservations: preview.maxReservations,
            costCeilingMicroUsd: preview.costCeilingMicroUsd,
            approvalTtlMinutes: preview.approvalTtlMinutes,
          });
          if (expected.previewBindingDigest !== currentBindingDigest) {
            throw Object.assign(new Error("Approval preview no longer matches this deployment."), {
              status: 409,
              code: "PROMPT_REFINER_STAGE_PREVIEW_STALE",
            });
          }
          world.auditWrites += 1;
          world.stageWrites += 1;
          return { created: true, replayed: false, stage: fakeStage };
        },
        promptRefinerStageAdmissionErrorResponse: (error: unknown) => {
          if (
            !error ||
            typeof error !== "object" ||
            !("status" in error) ||
            !("code" in error) ||
            !(error instanceof Error)
          ) {
            return null;
          }
          return Response.json(
            { error: error.message, code: error.code },
            { status: Number(error.status) }
          );
        },
      },
    });
  }
  return import(mod("app/api/admin/prompt-refiner/shadow-stage/route.ts"));
}

const post = (body: unknown) =>
  new Request("http://127.0.0.1:3100/api/admin/prompt-refiner/shadow-stage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const validBody = () => ({
  proposalDigest: preview.proposalDigest,
  runtimeSourceManifestDigest: preview.runtimeSourceManifestDigest,
  executionManifestDigest: preview.executionManifestDigest,
  previewBindingDigest: preview.previewBindingDigest,
  confirmation: PROMPT_REFINER_STAGE_CONFIRMATION,
});

test.beforeEach(() => {
  world = fresh();
});

test("the global origin guard covers the POST while GET remains read-only", () => {
  const path = "/api/admin/prompt-refiner/shadow-stage";
  assert.equal(requiresMutationOriginCheck("POST", path), true);
  assert.equal(requiresMutationOriginCheck("GET", path), false);
});

test("admin surface stays hidden and owner-only with recent authentication", async () => {
  const route = await loadRoute();
  world.authenticated = false;
  assert.equal((await route.GET()).status, 404);
  world.authenticated = true;
  world.role = "ops";
  assert.equal((await route.GET()).status, 403);
  world.role = "owner";
  world.recent = false;
  assert.equal((await route.GET()).status, 428);
  assert.equal(world.previewCalls, 0);
});

test("GET is a no-write content-free preview", async () => {
  const route = await loadRoute();
  const response = await route.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(world.rateLimitCalls, 0);
  assert.equal(world.createCalls, 0);
  assert.equal(world.auditWrites, 0);
  assert.equal(world.stageWrites, 0);
  assert.deepEqual(await response.json(), { preview });
});

test("POST requires the fixed confirmation and strict 4 KiB schema", async () => {
  const route = await loadRoute();
  const wrong = await route.POST(post({ ...validBody(), confirmation: "yes" }));
  assert.equal(wrong.status, 400);
  const extra = await route.POST(post({ ...validBody(), approvedBy: "attacker" }));
  assert.equal(extra.status, 400);
  const callerReason = await route.POST(post({ ...validBody(), reason: "caller-controlled" }));
  assert.equal(callerReason.status, 400);
  const missingBinding = { ...validBody() };
  delete (missingBinding as { previewBindingDigest?: string }).previewBindingDigest;
  assert.equal((await route.POST(post(missingBinding))).status, 400);
  const oversized = await route.POST(post({ ...validBody(), confirmation: "x".repeat(5000) }));
  assert.equal(oversized.status, 413);
  assert.equal(world.createCalls, 0);
});

test("POST forwards only frozen digests and server session to the dedicated writer", async () => {
  const route = await loadRoute();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network must not be called");
  };
  try {
    const response = await route.POST(post(validBody()));
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.equal(world.rateLimitCalls, 1);
    assert.equal(world.createCalls, 1);
    const forwarded = world.lastCreate as Record<string, unknown>;
    assert.deepEqual(forwarded.expected, {
      proposalDigest: preview.proposalDigest,
      runtimeSourceManifestDigest: preview.runtimeSourceManifestDigest,
      executionManifestDigest: preview.executionManifestDigest,
      previewBindingDigest: preview.previewBindingDigest,
    });
    assert.equal("approvedBy" in forwarded, false);
    assert.equal("approvedAt" in forwarded, false);
    const body = await response.json();
    assert.equal(body.stage.executionAdmitted, false);
    assert.equal(body.stage.productAdapterReady, false);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("same commit and source from a different deployment rejects the stale preview before writes", async () => {
  const route = await loadRoute();
  world.runtimeDeploymentId = "deployment-2";
  const response = await route.POST(post(validBody()));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Approval preview no longer matches this deployment.",
    code: "PROMPT_REFINER_STAGE_PREVIEW_STALE",
  });
  assert.equal(world.createCalls, 1);
  assert.equal(world.auditWrites, 0);
  assert.equal(world.stageWrites, 0);
});
