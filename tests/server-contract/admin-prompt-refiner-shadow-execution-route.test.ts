import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { requiresMutationOriginCheck } from "../../lib/requestOrigin.ts";
import {
    PROMPT_REFINER_SHADOW_EXECUTION_CONFIRMATION,
    PROMPT_REFINER_SHADOW_EXECUTION_FLAG,
    PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST,
    PROMPT_REFINER_SHADOW_RUN_ID,
} from "../../lib/promptRefinerShadowRunContract.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||=
    "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "prompt-refiner-execution-route-test";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

const state = {
    observedAt: "2026-09-20T09:00:00.000Z",
    runId: PROMPT_REFINER_SHADOW_RUN_ID,
    status: "approved",
    dispatchCount: 0,
    terminalCount: 0,
    nextCaseIndex: 0,
    nextCaseId: "general-short-ko",
    inFlightAttemptId: null,
    approvalExpiresAt: "2026-09-20T10:00:00.000Z",
};
const executed = {
    status: "completed",
    attemptedThisInvocation: 16,
    dispatchCount: 16,
    terminalCount: 16,
    inFlightAttemptId: null,
    observedAt: "2026-09-20T09:01:00.000Z",
    retryCount: 0,
    redispatched: 0,
};

type World = {
    authenticated: boolean;
    role: string;
    recent: boolean;
    stateCalls: number;
    executeCalls: number;
    rateLimitCalls: number;
};
const fresh = (): World => ({
    authenticated: true,
    role: "owner",
    recent: true,
    stateCalls: 0,
    executeCalls: 0,
    rateLimitCalls: 0,
});
let world = fresh();
let installed = false;

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
                readPromptRefinerShadowExecutionState: async () => {
                    world.stateCalls += 1;
                    return state;
                },
                promptRefinerShadowRunErrorResponse: () => null,
            },
        });
        mock.module(mod("lib/promptRefinerShadowRunner.ts"), {
            namedExports: {
                runPromptRefinerShadowExecution: async () => {
                    world.executeCalls += 1;
                    return executed;
                },
                promptRefinerShadowRunnerErrorResponse: () => null,
            },
        });
        mock.module(mod("lib/promptRefinerStageAdmission.ts"), {
            namedExports: { promptRefinerStageAdmissionErrorResponse: () => null },
        });
    }
    return import(
        mod("app/api/admin/prompt-refiner/shadow-run/execute/route.ts")
    );
}

const post = (body: unknown) =>
    new Request(
        "http://127.0.0.1:3100/api/admin/prompt-refiner/shadow-run/execute",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }
    );
const get = () =>
    new Request(
        "http://127.0.0.1:3100/api/admin/prompt-refiner/shadow-run/execute",
        { method: "GET" }
    );
const validBody = () => ({
    runId: PROMPT_REFINER_SHADOW_RUN_ID,
    runContractDigest: PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST,
    confirmation: PROMPT_REFINER_SHADOW_EXECUTION_CONFIRMATION,
});

test.beforeEach(() => {
    world = fresh();
    delete process.env[PROMPT_REFINER_SHADOW_EXECUTION_FLAG];
});

test("origin guard covers execution POST while preview GET remains read-only", () => {
    const path = "/api/admin/prompt-refiner/shadow-run/execute";
    assert.equal(requiresMutationOriginCheck("POST", path), true);
    assert.equal(requiresMutationOriginCheck("GET", path), false);
});

test("execution preview is hidden, owner-only and recently authenticated", async () => {
    const route = await loadRoute();
    world.authenticated = false;
    assert.equal((await route.GET(get())).status, 404);
    world.authenticated = true;
    world.role = "ops";
    assert.equal((await route.GET(get())).status, 403);
    world.role = "owner";
    world.recent = false;
    assert.equal((await route.GET(get())).status, 428);
    assert.equal(world.stateCalls, 0);
    assert.equal(world.rateLimitCalls, 0);
});

test("GET is content-free, no-write and shows the default-off flag", async () => {
    const route = await loadRoute();
    const response = await route.GET(get());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    const body = await response.json();
    assert.equal(body.execution.enabled, false);
    assert.equal(body.execution.runContractDigest, PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST);
    assert.equal(body.execution.confirmation, PROMPT_REFINER_SHADOW_EXECUTION_CONFIRMATION);
    assert.equal(body.execution.productAdapterReady, false);
    assert.equal(world.stateCalls, 1);
    assert.equal(world.executeCalls, 0);
    assert.equal(world.rateLimitCalls, 1);
});

test("POST accepts only the exact 4 KiB execution binding", async () => {
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
    assert.equal(world.executeCalls, 0);
    assert.equal(world.rateLimitCalls, 0);
});

test("POST delegates exactly once and returns no prompt or model output", async () => {
    const route = await loadRoute();
    process.env[PROMPT_REFINER_SHADOW_EXECUTION_FLAG] = "true";
    const response = await route.POST(post(validBody()));
    assert.equal(response.status, 200);
    assert.equal(world.rateLimitCalls, 1);
    assert.equal(world.executeCalls, 1);
    const body = await response.json();
    assert.deepEqual(body, { execution: executed, productAdapterReady: false });
    assert.doesNotMatch(JSON.stringify(body), /sourceText|refinedPrompt|responseBody/i);
});
