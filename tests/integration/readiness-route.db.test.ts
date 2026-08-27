import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// `/api/ready`, driven as the load balancer drives it.
//
// This endpoint decides whether a deployment receives traffic. Its contract is
// a conjunction -- five dependencies, any one of which must sink the verdict --
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

/**
 * The sending-identity readiness the route folds in.
 *
 * Mocked rather than driven through the real environment: the resolver falls
 * back to a compiled address when nothing is configured, so a live read is
 * always ready and the refusal branch would never be exercised here.
 */
let sendingIdentityReady = true;
mock.module(mod("lib/emailSendingIdentity.ts"), {
    namedExports: {
        getSendingIdentityReadiness: () => ({
            ready: sendingIdentityReady,
            errors: sendingIdentityReady
                ? []
                : [
                      {
                          severity: "error",
                          code: "STREAMS_SHARE_A_DOMAIN",
                          message: "marketing shares the transactional domain",
                      },
                  ],
            warnings: [],
        }),
    },
});

/**
 * The snapshot keyring readiness the route folds in.
 *
 * Mocked for the same reason as the sending identity above, and for the
 * opposite one too: a live read of this container's environment has no
 * `EMAIL_SNAPSHOT_KEYS`, so the *ready* branch would never be exercised here.
 */
let snapshotKeyringReady = true;
mock.module(mod("lib/emailSnapshotCrypto.ts"), {
    namedExports: {
        snapshotKeyringReadiness: () => ({
            ready: snapshotKeyringReady,
            errors: snapshotKeyringReady
                ? []
                : [
                      {
                          severity: "error",
                          code: "SNAPSHOT_KEYS_MISSING",
                          message: "EMAIL_SNAPSHOT_KEYS is not set",
                      },
                  ],
            warnings: [],
            versionCount: snapshotKeyringReady ? 1 : 0,
        }),
    },
});

/**
 * The search backend readiness the route folds in.
 *
 * `null` stands for "the derivation itself threw", exactly as the image budget
 * above does -- the route wraps this call in the same try/catch and answers
 * `false` rather than `true` when it explodes, and that branch is worth pinning
 * for the same reason it was worth pinning there.
 *
 * Mocked rather than driven through the real environment because the live read
 * depends on the compiled capability register: it needs a credential for every
 * backend an enabled model searches through, and this container has none. A
 * live read would therefore be stuck on one branch, and which branch would
 * depend on `NODE_ENV` -- which several cases below set for unrelated reasons.
 */
let searchBudget: { ready: boolean } | null = { ready: true };
mock.module(mod("lib/searchProviderBudgetReadiness.ts"), {
    namedExports: {
        getSearchProviderBudgetReadiness: () => {
            if (!searchBudget) throw new Error("search budget derivation exploded");
            return {
                ...searchBudget,
                configuredBackends: searchBudget.ready ? ["brave"] : [],
                requiredBackends: ["brave"],
                budgets: [],
                problems: searchBudget.ready
                    ? []
                    : [
                          {
                              code: "no_backend_configured",
                              backend: "brave",
                              message: "no credential for brave",
                          },
                      ],
            };
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

/**
 * The footer's business identity, complete.
 *
 * Set for every case rather than left unset, because an incomplete identity is
 * fatal exactly when marketing has a sending address -- and several cases below
 * set one to exercise the unsubscribe keyring. Without this they would fail two
 * checks and the "only this one is false" assertion would stop meaning anything.
 */
const IDENTITY_ENV = {
    EMAIL_BUSINESS_LEGAL_NAME: "Tomverse Pty Ltd",
    EMAIL_BUSINESS_POSTAL_ADDRESS: "1 Example Street, Brisbane QLD 4000",
    EMAIL_BUSINESS_CONTACT_EMAIL: "support@tomverse.app",
};
const setBusinessIdentity = (complete: boolean) => {
    const env = process.env as Record<string, string | undefined>;
    for (const [key, value] of Object.entries(IDENTITY_ENV)) {
        if (complete) env[key] = value;
        else delete env[key];
    }
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
    searchBudget = { ready: true };
    setBusinessIdentity(true);
    sendingIdentityReady = true;
    snapshotKeyringReady = true;
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
        emailSendingIdentity: boolean;
        emailSnapshotKeyring: boolean;
        emailUnsubscribeKeyring: boolean;
        emailBusinessIdentity: boolean;
        searchProviderBudget: boolean;
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
        emailSendingIdentity: true,
        emailSnapshotKeyring: true,
        emailUnsubscribeKeyring: true,
        emailBusinessIdentity: true,
        searchProviderBudget: true,
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
        {
            name: "emailSendingIdentity",
            arrange: () => {
                sendingIdentityReady = false;
            },
        },
        {
            // A deployment that would offer the web-search switch with no
            // credential behind it, or spend at a search vendor whose
            // operational cap could not be read. Unlike the image budget there
            // is no flag to be off: the capability register is compiled in, so
            // a build shipping models that search through a backend has already
            // decided that the backend is required.
            name: "searchProviderBudget",
            arrange: () => {
                searchBudget = { ready: false };
            },
        },
        {
            // Without this the endpoint answers ready while every welcome
            // email, receipt and deletion notice is dropped -- the lane's
            // callers swallow the throw, so nothing else says so.
            name: "emailSnapshotKeyring",
            arrange: () => {
                snapshotKeyringReady = false;
            },
        },
        {
            // Driven through the real environment rather than mocked, because
            // this one is conditional and the condition is the interesting
            // part: the keys are only required once marketing has a sending
            // identity of its own, and that is what setting this reproduces.
            name: "emailUnsubscribeKeyring",
            arrange: () => {
                process.env.MARKETING_EMAIL_FROM = "Tomverse <news@news.tomverse.app>";
                delete process.env.EMAIL_UNSUBSCRIBE_KEYS;
            },
        },
        {
            // Conditional in the same shape, and driven through the real
            // environment for the same reason. The keys are supplied here so
            // the only thing wrong is the identity -- otherwise turning
            // marketing on would break two checks and prove neither.
            name: "emailBusinessIdentity",
            arrange: () => {
                process.env.MARKETING_EMAIL_FROM = "Tomverse <news@news.tomverse.app>";
                process.env.EMAIL_UNSUBSCRIBE_KEYS =
                    "v1:0123456789abcdef0123456789abcdef";
                setBusinessIdentity(false);
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
        searchBudget = { ready: true };
        sendingIdentityReady = true;
        snapshotKeyringReady = true;
        delete process.env.MARKETING_EMAIL_FROM;
        delete process.env.EMAIL_UNSUBSCRIBE_KEYS;
        setBusinessIdentity(true);
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
        // Counted from the body rather than written down. A literal here has
        // now been wrong three times -- at four dependencies, at five, and at
        // six -- each time because a dependency was added to the route and to
        // every other assertion in this file except this one. What the route
        // actually couples is that each check it answers with is also a check
        // it reports on, so that is what this asserts.
        assert.equal(
            reported.length,
            Object.keys(body.checks).length,
            "every dependency is reported, not only the failing one"
        );
    }
});

test("the unsubscribe keyring is required only once marketing can send", async () => {
    // EM-10's whole point, at the route. Gating on the keys unconditionally
    // would refuse today's deployment over a capability nobody has turned on;
    // not gating at all is how the endpoint answered ready while every
    // marketing message would be refused for having no unsubscribe link.
    delete process.env.MARKETING_EMAIL_FROM;
    delete process.env.EMAIL_UNSUBSCRIBE_KEYS;
    const withoutMarketing = await get();
    assert.equal(withoutMarketing.body.checks.emailUnsubscribeKeyring, true);
    assert.equal(withoutMarketing.body.ok, true);

    // Configure the marketing address and the same missing key is now fatal.
    process.env.MARKETING_EMAIL_FROM = "Tomverse <news@news.tomverse.app>";
    const withMarketing = await get();
    assert.equal(withMarketing.body.checks.emailUnsubscribeKeyring, false);
    assert.equal(withMarketing.response.status, 503);

    // Supplying the keys clears it, so the refusal names something an operator
    // can actually act on rather than a permanent state.
    process.env.EMAIL_UNSUBSCRIBE_KEYS = "v1:0123456789abcdef0123456789abcdef";
    const configured = await get();
    assert.equal(configured.body.checks.emailUnsubscribeKeyring, true);
    assert.equal(configured.body.ok, true);

    delete process.env.MARKETING_EMAIL_FROM;
    delete process.env.EMAIL_UNSUBSCRIBE_KEYS;
});

test("the footer identity is required only once marketing can send", async () => {
    // An unset value drops the whole footer rather than one line of it, and
    // transactional mail is deliberately not held for that -- an
    // account-deletion notice is the message least able to wait for an
    // environment variable. So it is a warning until marketing has an address,
    // and fatal after, because from then on every marketing send is refused
    // for having no business identity while this endpoint answers yes.
    delete process.env.MARKETING_EMAIL_FROM;
    process.env.EMAIL_UNSUBSCRIBE_KEYS = "v1:0123456789abcdef0123456789abcdef";
    setBusinessIdentity(false);
    const withoutMarketing = await get();
    assert.equal(withoutMarketing.body.checks.emailBusinessIdentity, true);
    assert.equal(withoutMarketing.body.ok, true);

    process.env.MARKETING_EMAIL_FROM = "Tomverse <news@news.tomverse.app>";
    const withMarketing = await get();
    assert.equal(withMarketing.body.checks.emailBusinessIdentity, false);
    assert.equal(withMarketing.response.status, 503);

    // And it names something an operator can act on rather than a permanent
    // state: supplying the values clears it.
    setBusinessIdentity(true);
    const configured = await get();
    assert.equal(configured.body.checks.emailBusinessIdentity, true);
    assert.equal(configured.body.ok, true);

    delete process.env.MARKETING_EMAIL_FROM;
    delete process.env.EMAIL_UNSUBSCRIBE_KEYS;
});

test("the search budget check throwing is not ready", async () => {
    // The same regression, guarded on the same shape. The search check derives
    // a spend floor from the price list and the plan grants, and that
    // derivation throws rather than returning a verdict when an enabled model
    // has no price -- so `?? true` here would let a build that cannot price its
    // own search answer healthy.
    searchBudget = null;

    const { response, body } = await get();
    assert.equal(response.status, 503);
    assert.equal(body.checks.searchProviderBudget, false);

    await runDeferred();
    assert.deepEqual(
        reported.find((entry) => entry.dependency === "search-provider-cost-budget"),
        { dependency: "search-provider-cost-budget", healthy: false }
    );
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
