import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// `/api/ready`, driven as the load balancer drives it.
//
// This endpoint decides whether a deployment receives traffic. Its contract is
// a conjunction -- four dependencies, any one of which must sink the verdict --
// and the failure mode is a check that gets computed and then not folded in:
// the body lists a dependency as broken while `ok` stays true and the platform
// keeps routing to it.
//
// Every individual check has unit tests. Nothing drove the route that combines
// them, which is where the combining happens.
//
// One of these cases is a regression the route's own comment records: the image
// budget was read as `status?.ready ?? true`, so the check *throwing* counted
// as healthy. A missing environment variable was fatal while the check that
// finds missing environment variables blowing up was fine -- the louder the
// failure, the quieter the endpoint. That is pinned below.
//
// Runs in its own process under scripts/run-db-integration-tests.mjs, because
// mock.module is process-global and this file replaces the readiness inputs,
// the operational reporter and `next/server`'s `after` for every module that
// imports them.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
    pathToFileURL(resolve(ROOT, relativePath)).href;

/** Deferred work the route schedules; run by hand so nothing escapes the test. */
let deferred: Array<() => unknown> = [];
mock.module("next/server", {
    namedExports: {
        after: (callback: () => unknown) => {
            deferred.push(callback);
        },
    },
});

let securityReady = true;
let securityChecks: Record<string, boolean> = { stripeLiveMode: true };
mock.module(mod("lib/securityEnvironment.ts"), {
    namedExports: {
        getSecurityEnvironmentStatus: () => ({
            ready: securityReady,
            checks: securityChecks,
        }),
    },
});

let providerBudgetReady = true;
mock.module(mod("lib/providerCostBudget.ts"), {
    namedExports: {
        getActiveProviders: () => ["openai"],
        getProviderBudgetReadiness: () => ({
            ready: providerBudgetReady,
            errors: providerBudgetReady
                ? []
                : [{ provider: "openai", message: "daily budget missing" }],
        }),
    },
});

/** `null` stands for "the derivation itself threw". */
let imageBudget: { ready: boolean; flagEnabled: boolean } | null = {
    ready: true,
    flagEnabled: false,
};
mock.module(mod("lib/imageProviderBudgetReadiness.ts"), {
    namedExports: {
        getImageProviderBudgetReadiness: async () => {
            if (!imageBudget) throw new Error("budget derivation exploded");
            return { ...imageBudget, providers: [] };
        },
    },
});

/** Dependency reports the route files after answering. */
let reported: Array<{ dependency: string; healthy: boolean }> = [];
mock.module(mod("lib/operationalMonitoring.ts"), {
    namedExports: {
        reportOperationalDependencyStatus: async (input: {
            dependency: string;
            healthy: boolean;
        }) => {
            reported.push({
                dependency: input.dependency,
                healthy: input.healthy,
            });
        },
    },
});

type RouteModule = {
    GET: () => Promise<Response>;
    HEAD: () => Promise<Response>;
};
let prisma: (typeof import("@/lib/prisma"))["prisma"];
let route: RouteModule;
const originalNodeEnv = process.env.NODE_ENV;
/**
 * `NODE_ENV` is typed read-only by Next's environment augmentation, and the
 * route reads it at request time. Writing through the record is the assignment
 * the type forbids and the runtime allows -- which is what the route observes.
 */
const setNodeEnv = (value: string | undefined) => {
    const env = process.env as Record<string, string | undefined>;
    if (value === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = value;
};

before(async () => {
    ({ prisma } = (await import(
        mod("lib/prisma.ts")
    )) as typeof import("@/lib/prisma"));
    route = (await import(mod("app/api/ready/route.ts"))) as RouteModule;
});

beforeEach(() => {
    deferred = [];
    reported = [];
    securityReady = true;
    securityChecks = { stripeLiveMode: true };
    providerBudgetReady = true;
    imageBudget = { ready: true, flagEnabled: false };
    setNodeEnv(originalNodeEnv);
});

after(async () => {
    setNodeEnv(originalNodeEnv);
    await prisma.$disconnect();
});

type ReadinessBody = {
    ok: boolean;
    checks: {
        database: boolean;
        securityEnvironment: boolean;
        providerBudgets: boolean;
        imageProviderBudget: boolean;
    };
    traceId: string;
};

const get = async () => {
    const response = await route.GET();
    return { response, body: (await response.json()) as ReadinessBody };
};

const runDeferred = async () => {
    for (const callback of deferred) await callback();
};

test("a healthy deployment is ready, and says which checks passed", async () => {
    // The database check is the real one: this suite runs against a live
    // PostgreSQL, so `SELECT 1` is genuinely answered.
    const { response, body } = await get();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.checks, {
        database: true,
        securityEnvironment: true,
        providerBudgets: true,
        imageProviderBudget: true,
    });
    assert.ok(body.traceId, "a trace id ties the answer to the reports");
    // Only sent when refusing traffic; a load balancer reads it.
    assert.equal(response.headers.get("Retry-After"), null);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("each dependency alone sinks the verdict, and the others still report", async () => {
    // The conjunction is the contract. A route that returned on the first
    // failure would answer 503 correctly and leave an operator unable to see
    // whether anything else is also broken.
    const cases: Array<{
        name: keyof ReadinessBody["checks"];
        arrange: () => void;
    }> = [
        {
            name: "securityEnvironment",
            arrange: () => {
                setNodeEnv("production");
                securityReady = false;
                securityChecks = { stripeLiveMode: false };
            },
        },
        {
            name: "providerBudgets",
            arrange: () => {
                providerBudgetReady = false;
            },
        },
        {
            name: "imageProviderBudget",
            arrange: () => {
                imageBudget = { ready: false, flagEnabled: true };
            },
        },
    ];

    for (const { name, arrange } of cases) {
        deferred = [];
        reported = [];
        securityReady = true;
        securityChecks = { stripeLiveMode: true };
        providerBudgetReady = true;
        imageBudget = { ready: true, flagEnabled: false };
        setNodeEnv(originalNodeEnv);
        arrange();

        const { response, body } = await get();
        assert.equal(response.status, 503, `${name} must refuse traffic`);
        assert.equal(body.ok, false);
        assert.equal(body.checks[name], false, `${name} is reported broken`);
        assert.equal(
            Object.values(body.checks).filter((passed) => !passed).length,
            1,
            `only ${name} should be false: ${JSON.stringify(body.checks)}`
        );
        assert.equal(response.headers.get("Retry-After"), "5");

        await runDeferred();
        assert.equal(
            reported.length,
            4,
            "every dependency is reported, not only the failing one"
        );
    }
});

test("the image budget check throwing is not ready", async () => {
    // The regression the route's comment records. `?? true` here meant the
    // check that finds missing environment variables could blow up and the
    // endpoint would call that healthy.
    imageBudget = null;

    const { response, body } = await get();
    assert.equal(response.status, 503);
    assert.equal(body.checks.imageProviderBudget, false);

    await runDeferred();
    assert.deepEqual(
        reported.find((entry) => entry.dependency === "image-provider-cost-budget"),
        { dependency: "image-provider-cost-budget", healthy: false }
    );
});

test("an image budget absent while the flag is off is still ready", async () => {
    // The legal intermediate state of the env-first deploy order: the
    // environment variable lands before the feature does. The function decides
    // this and answers ready, so the route must not second-guess it.
    imageBudget = { ready: true, flagEnabled: false };

    const { response, body } = await get();
    assert.equal(response.status, 200);
    assert.equal(body.checks.imageProviderBudget, true);
});

test("a failing security environment only sinks production", async () => {
    // Outside production the check is informational: a developer machine
    // without live Stripe keys is not an outage. In production it is fatal.
    securityReady = false;
    securityChecks = { stripeLiveMode: false };

    setNodeEnv("test");
    assert.equal((await get()).response.status, 200);

    setNodeEnv("production");
    const production = await get();
    assert.equal(production.response.status, 503);
    assert.equal(production.body.checks.securityEnvironment, false);
});

test("HEAD answers what GET answers", async () => {
    // The load balancer may use either. A HEAD saying 204 while GET says 503
    // means the platform and the operator disagree about the same deployment.
    assert.equal((await route.HEAD()).status, 204);

    providerBudgetReady = false;
    const refused = await route.HEAD();
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get("Retry-After"), "5");
    assert.equal(await refused.text(), "", "HEAD carries no body");
});

test("the body carries booleans and a trace id, nothing else", async () => {
    // This response is public and unauthenticated. Anything naming an
    // environment variable, a provider key or a host would be readable by
    // anyone who can reach the deployment.
    providerBudgetReady = false;
    const { body } = await get();

    assert.deepEqual(Object.keys(body).sort(), ["checks", "ok", "traceId"]);
    for (const value of Object.values(body.checks)) {
        assert.equal(typeof value, "boolean");
    }
    const serialized = JSON.stringify(body);
    for (const leak of ["daily budget missing", "openai", "stripeLiveMode"]) {
        assert.ok(
            !serialized.includes(leak),
            `${leak} must not reach an unauthenticated response: ${serialized}`
        );
    }
});
