import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { requiresMutationOriginCheck } from "../../lib/requestOrigin.ts";
import {
    PROMPT_REFINER_SHADOW_RUN_CONFIRMATION,
} from "../../lib/promptRefinerShadowRunContract.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||=
    "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.NEXTAUTH_SECRET ||= "prompt-refiner-run-route-test";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const preview = {
    status: "ready_for_explicit_cost_approval",
    runId: "prompt-refiner-shadow-run-v4",
    stageId: "prompt-refiner-shadow-v2",
    stageRuntimeSourceManifestDigest: digest("1"),
    runSourceManifestDigest: digest("2"),
    environment: "staging",
    deploymentId: "deployment-1",
    commitSha: "a".repeat(40),
    stageApprovalExpiresAt: "2026-09-20T03:00:00.000Z",
    runContractDigest: digest("3"),
    corpusDigest: "b".repeat(64),
    evidenceSpecDigest: "c".repeat(64),
    adapterVersion: "prompt-refiner-openai-sdk-adapter-v1",
    provider: "openai",
    modelId: "gpt-5-6-luna",
    apiModelId: "gpt-5.6-luna",
    timeoutMs: 15_000,
    retryCount: 0,
    tokenizerPackage: "js-tiktoken",
    tokenizerPackageVersion: "1.0.21",
    tokenizerEncoding: "o200k_base",
    maxInputTokens: 100_000,
    maxDispatches: 16,
    perRequestCostMicroUsd: 24_916,
    costCeilingMicroUsd: 398_656,
    unknownOutcomePolicy: "stop_no_redispatch",
    executionAdmitted: true,
    productAdapterReady: false,
    previewBindingDigest: digest("4"),
    confirmation: PROMPT_REFINER_SHADOW_RUN_CONFIRMATION,
    approvalEnabled: false,
} as const;

type World = {
    authenticated: boolean;
    role: string;
    recent: boolean;
    previewCalls: number;
    createCalls: number;
    rateLimitCalls: number;
    lastCreate: unknown;
};

const fresh = (): World => ({
    authenticated: true,
    role: "owner",
    recent: true,
    previewCalls: 0,
    createCalls: 0,
    rateLimitCalls: 0,
    lastCreate: null,
});
let world = fresh();
let installed = false;

const fakeRun = {
    id: preview.runId,
    status: "approved",
    runContractDigest: preview.runContractDigest,
    corpusDigest: preview.corpusDigest,
    evidenceSpecDigest: preview.evidenceSpecDigest,
    adapterVersion: preview.adapterVersion,
    runtimeDeploymentId: preview.deploymentId,
    runtimeCommitSha: preview.commitSha,
    perRequestCostMicroUsd: BigInt(preview.perRequestCostMicroUsd),
    maxDispatches: preview.maxDispatches,
    costCeilingMicroUsd: BigInt(preview.costCeilingMicroUsd),
    approvedAt: new Date("2026-09-20T02:00:00.000Z"),
    approvalExpiresAt: new Date(preview.stageApprovalExpiresAt),
    authorizationAuditLogId: "audit-run-1",
};

async function loadRoute() {
    if (!installed) {
        installed = true;
        mock.module(mod("node_modules/next-auth/next/index.js"), {
            namedExports: {
                getServerSession: async () =>
                    world.authenticated
                        ? {
                              user: {
                                  id: "owner-1",
                                  email: "owner@example.com",
                                  authenticatedAt: new Date().toISOString(),
                              },
                          }
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
        const realSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<
            string,
            unknown
        >;
        mock.module(mod("lib/apiSecurity.ts"), {
            namedExports: {
                ...realSecurity,
                consumeApiRateLimit: async () => {
                    world.rateLimitCalls += 1;
                },
            },
        });
        mock.module(mod("lib/promptRefinerShadowRunStore.ts"), {
            namedExports: {
                promptRefinerShadowRunPreview: async () => {
                    world.previewCalls += 1;
                    return preview;
                },
                createPromptRefinerShadowRun: async (input: unknown) => {
                    world.createCalls += 1;
                    world.lastCreate = input;
                    return { created: true, replayed: false, run: fakeRun };
                },
                promptRefinerShadowRunErrorResponse: () => null,
            },
        });
        mock.module(mod("lib/promptRefinerStageAdmission.ts"), {
            namedExports: { promptRefinerStageAdmissionErrorResponse: () => null },
        });
    }
    return import(mod("app/api/admin/prompt-refiner/shadow-run/route.ts"));
}

const post = (body: unknown) =>
    new Request("http://127.0.0.1:3100/api/admin/prompt-refiner/shadow-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

const validBody = () => ({
    runContractDigest: preview.runContractDigest,
    stageRuntimeSourceManifestDigest: preview.stageRuntimeSourceManifestDigest,
    runSourceManifestDigest: preview.runSourceManifestDigest,
    previewBindingDigest: preview.previewBindingDigest,
    confirmation: PROMPT_REFINER_SHADOW_RUN_CONFIRMATION,
});
test.beforeEach(() => {
    world = fresh();
});

test("origin guard covers approval POST while preview GET remains read-only", () => {
    const path = "/api/admin/prompt-refiner/shadow-run";
    assert.equal(requiresMutationOriginCheck("POST", path), true);
    assert.equal(requiresMutationOriginCheck("GET", path), false);
});

test("run approval surface is hidden, owner-only and recently authenticated", async () => {
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

test("GET is a no-write, no-rate-limit exact preview", async () => {
    const route = await loadRoute();
    const response = await route.GET();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.deepEqual(await response.json(), { preview });
    assert.equal(world.previewCalls, 1);
    assert.equal(world.createCalls, 0);
    assert.equal(world.rateLimitCalls, 0);
});

test("POST accepts only the fixed 4 KiB approval binding", async () => {
    const route = await loadRoute();
    assert.equal(
        (await route.POST(post({ ...validBody(), confirmation: "yes" }))).status,
        400
    );
    assert.equal(
        (await route.POST(post({ ...validBody(), approvedBy: "attacker" }))).status,
        400
    );
    assert.equal(
        (
            await route.POST(
                post({ ...validBody(), confirmation: "x".repeat(5000) })
            )
        ).status,
        413
    );
    assert.equal(world.createCalls, 0);
});

test("POST records the exact v4 execution authority without calling a provider", async () => {
    const route = await loadRoute();
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        throw new Error("approval route must not call a provider");
    };
    try {
        const response = await route.POST(post(validBody()));
        assert.equal(response.status, 201);
        assert.equal(world.rateLimitCalls, 1);
        assert.equal(world.createCalls, 1);
        const forwarded = world.lastCreate as Record<string, unknown>;
        assert.deepEqual(forwarded.expected, {
            runContractDigest: preview.runContractDigest,
            stageRuntimeSourceManifestDigest:
                preview.stageRuntimeSourceManifestDigest,
            runSourceManifestDigest: preview.runSourceManifestDigest,
            previewBindingDigest: preview.previewBindingDigest,
        });
        assert.equal("confirmation" in forwarded, false);
        const body = await response.json();
        assert.equal(body.run.executionAdmitted, true);
        assert.equal(body.run.productAdapterReady, false);
    } finally {
        globalThis.fetch = oldFetch;
    }
});
