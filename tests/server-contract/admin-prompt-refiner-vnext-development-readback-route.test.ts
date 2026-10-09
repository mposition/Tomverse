import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "vnext-development-readback-route-test";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

type World = {
    authenticated: boolean;
    role: string;
    recent: boolean;
    sessionFailure: boolean;
    rateLimitError: Error | null;
    sourceError: Error | null;
    deploymentError: Error | null;
    priceError: Error | null;
    rateLimitCalls: number;
    sourceReads: number;
    deploymentReads: number;
    priceReads: number;
    snapshotCalls: number;
};
const fresh = (): World => ({
    authenticated: true, role: "owner", recent: true, sessionFailure: false,
    rateLimitError: null, sourceError: null, deploymentError: null, priceError: null,
    rateLimitCalls: 0, sourceReads: 0, deploymentReads: 0, priceReads: 0,
    snapshotCalls: 0,
});
let world = fresh();
let installed = false;
let apiSecurityErrorClass: new (
    status: number, code: string, message: string, retryAfter?: number
) => Error;

async function loadRoute() {
    if (!installed) {
        installed = true;
        mock.module(mod("node_modules/next-auth/next/index.js"), {
            namedExports: { getServerSession: async () => {
                if (world.sessionFailure) throw new Error("private session failure");
                return world.authenticated ? { user: { id: "owner-1" } } : null;
            } },
        });
        mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
        mock.module(mod("lib/adminAuth.ts"), { namedExports: {
            isAdminSession: () => world.authenticated,
            getAdminRole: () => world.role,
        } });
        mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
            assertRecentAdminAuthentication: async () => {
                if (!world.recent) throw new Error("reauth");
            },
            isAdminReauthenticationError: (error: unknown) =>
                error instanceof Error && error.message === "reauth",
        } });
        const realSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<string, unknown>;
        apiSecurityErrorClass = realSecurity.ApiSecurityError as typeof apiSecurityErrorClass;
        mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
            ...realSecurity,
            consumeApiRateLimit: async () => {
                world.rateLimitCalls += 1;
                if (world.rateLimitError) throw world.rateLimitError;
            },
        } });
        mock.module(mod("lib/promptRefinerQualityEvaluationVnextOneShotSource.ts"), {
            namedExports: { verifyPromptRefinerVnextOneShotDevelopmentSource: async (root: string) => {
                assert.equal(root, process.cwd());
                world.sourceReads += 1;
                if (world.sourceError) throw world.sourceError;
                return { dispatchAuthorized: false };
            } },
        });
        mock.module(mod("lib/promptRefinerQualityEvaluationVnextOneShotDeploymentReadback.ts"), {
            namedExports: { observePromptRefinerVnextOneShotDeployment: async () => {
                world.deploymentReads += 1;
                if (world.deploymentError) throw world.deploymentError;
                return { runtimeAndRailwayAgree: true,
                    activeDeploymentConfirmed: true, problems: [] };
            } },
        });
        mock.module(mod("lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback.ts"), {
            namedExports: { readPromptRefinerVnextOneShotPrice: async () => {
                world.priceReads += 1;
                if (world.priceError) throw world.priceError;
                return { pricePinMatchesRegistry: true, problems: [] };
            } },
        });
        mock.module(mod("lib/readOnlySnapshotTransaction.ts"), { namedExports: {
            readOnlySnapshotTransaction: async (
                work: (tx: object) => Promise<unknown>,
                options: { maxWait: number; timeout: number }
            ) => {
                world.snapshotCalls += 1;
                assert.deepEqual(options, { maxWait: 5_000, timeout: 10_000 });
                return work({});
            },
        } });
    }
    return import(mod("app/api/admin/prompt-refiner/vnext-development-readback/route.ts"));
}

const get = () => new Request(
    "http://127.0.0.1:3100/api/admin/prompt-refiner/vnext-development-readback",
    { method: "GET" }
);
const assertNoStore = (response: Response) =>
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");

test.beforeEach(() => { world = fresh(); });

test("GET is owner-only, recent-auth and read-only", async () => {
    const route = await loadRoute();
    world.authenticated = false;
    const anonymous = await route.GET(get());
    assert.equal(anonymous.status, 404);
    assertNoStore(anonymous);
    world.authenticated = true;
    world.role = "ops";
    const nonOwner = await route.GET(get());
    assert.equal(nonOwner.status, 403);
    assertNoStore(nonOwner);
    world.role = "owner";
    world.recent = false;
    const stale = await route.GET(get());
    assert.equal(stale.status, 428);
    assertNoStore(stale);
    assert.equal(world.rateLimitCalls, 0);
    assert.equal(world.sourceReads, 0);
    assert.equal(route.POST, undefined);
});

test("rate limit returns no-store 429 before external or database reads", async () => {
    const route = await loadRoute();
    world.rateLimitError = new apiSecurityErrorClass(429, "API_RATE_LIMITED", "Too many requests.", 60);
    const response = await route.GET(get());
    assert.equal(response.status, 429);
    assertNoStore(response);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal(world.rateLimitCalls, 1);
    assert.equal(world.sourceReads + world.deploymentReads + world.priceReads, 0);
});

test("matching direct reads remain development-only and content-free", async () => {
    const route = await loadRoute();
    const response = await route.GET(get());
    assert.equal(response.status, 200);
    assertNoStore(response);
    assert.equal(world.sourceReads, 1);
    assert.equal(world.deploymentReads, 1);
    assert.equal(world.priceReads, 1);
    assert.equal(world.snapshotCalls, 1);
    const body = await response.json();
    assert.equal(body.readback.developmentSourceVerified, true);
    assert.equal(body.readback.deploymentVerified, true);
    assert.equal(body.readback.pricePinMatchesRegistry, true);
    for (const key of ["finalSourceClosureVerified", "reservationVerified",
        "stageApproved", "runApproved", "dispatchAuthorized"]) {
        assert.equal(body.readback[key], false);
    }
    assert.doesNotMatch(JSON.stringify(body), /sourceText|rubric|manifestRoot|token/i);
});

test("source drift and unexpected session failure return closed no-store responses", async () => {
    const route = await loadRoute();
    world.sourceError = new Error("vnext_one_shot_source_drift");
    const drift = await route.GET(get());
    assert.equal(drift.status, 200);
    assertNoStore(drift);
    assert.deepEqual((await drift.json()).readback.problems, ["vnext_one_shot_source_drift"]);
    world.sourceError = null;
    world.priceError = new Error("vnext_one_shot_price_read_failed");
    const priceFailure = await route.GET(get());
    assert.deepEqual((await priceFailure.json()).readback.problems,
        ["vnext_one_shot_price_read_failed"]);
    world.priceError = null;
    world.deploymentError = new Error("railway_deployment_unavailable");
    const deploymentFailure = await route.GET(get());
    assert.deepEqual((await deploymentFailure.json()).readback.problems,
        ["railway_deployment_unavailable"]);
    world.deploymentError = null;
    world.sessionFailure = true;
    const log = mock.method(console, "error", () => {});
    const failure = await route.GET(get());
    assert.equal(log.mock.callCount(), 1);
    assert.deepEqual(log.mock.calls[0].arguments,
        ["Prompt Refiner vNext development read-back unexpectedly failed"]);
    log.mock.restore();
    assert.equal(failure.status, 503);
    assertNoStore(failure);
    assert.deepEqual(await failure.json(), { error: "Read-back unavailable." });
});
