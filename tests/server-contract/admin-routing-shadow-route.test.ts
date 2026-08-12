import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

/**
 * `/api/admin/routing-shadow`.
 *
 * Two things this route must get right, and both are about who sees what.
 *
 * A non-admin gets 404, not 403: the existence of an admin surface is itself
 * information, and the rest of the console answers the same way.
 *
 * And the payload carries no request content. The table is content-free by
 * construction, but a route is where that stops being true if someone widens a
 * `select`, so the assertion lives here as well as at the query layer.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

type World = {
    session: unknown;
    isAdmin: boolean;
    reportCalls: Array<{ windowDays?: number }>;
};

let world: World = { session: null, isAdmin: false, reportCalls: [] };
let installed = false;

const report = {
    windowDays: 30,
    since: "2026-07-07T00:00:00.000Z",
    truncated: false,
    rows: 2,
    decided: 2,
    undecided: 0,
    agreed: 1,
    agreementRate: 0.5,
    versions: {
        taskProfileVersions: ["task-profile-v1"],
        candidateFilterVersions: ["router-candidates-v1"],
        selectionVersions: ["router-selection-v1"],
        mixed: false,
    },
    switches: [{ from: "gpt-5-6-luna", to: "deepseek-v4-flash", count: 1 }],
    byTaskKind: [],
    byPlan: [],
    selectionReasons: { task_preference: 2 },
    rejectionReasons: { plan: 4 },
    decisionMicrosP50: 400,
    decisionMicrosP95: 900,
};

async function loadRoute(): Promise<{
    GET: (request: Request) => Promise<Response>;
}> {
    if (!installed) {
        installed = true;
        mock.module(mod("node_modules/next-auth/next/index.js"), {
            namedExports: { getServerSession: async () => world.session },
        });
        mock.module(mod("lib/adminAuth.ts"), {
            namedExports: { isAdminSession: () => world.isAdmin },
        });
        const { createRequire } = await import("node:module");
        const require = createRequire(import.meta.url);
        const realApiSecurity = require(
            resolve(ROOT, "lib/apiSecurity.ts")
        ) as Record<string, unknown>;
        mock.module(mod("lib/apiSecurity.ts"), {
            namedExports: {
                ...realApiSecurity,
                consumeApiRateLimit: async () => {},
            },
        });
        // The query layer is replaced so this exercises the route, not the
        // database. What it must still prove is that the route hands the window
        // through and returns the report unaltered.
        mock.module(mod("lib/routingShadowMetrics.ts"), {
            namedExports: {
                getRoutingShadowReport: async (input: { windowDays?: number }) => {
                    world.reportCalls.push(input ?? {});
                    return report;
                },
            },
        });
    }
    return import(mod("app/api/admin/routing-shadow/route.ts"));
}

const request = (url = "https://tomverse.app/api/admin/routing-shadow") =>
    new Request(url);

test("a signed-out visitor gets 404, and the report is never built", async () => {
    world = { session: null, isAdmin: false, reportCalls: [] };
    const { GET } = await loadRoute();
    const response = await GET(request());
    assert.equal(response.status, 404);
    assert.equal(world.reportCalls.length, 0);
});

test("a signed-in non-admin gets 404 rather than 403", async () => {
    // 403 would confirm the surface exists. The console answers 404 everywhere
    // for the same reason.
    world = {
        session: { user: { id: "u1", email: "someone@example.test" } },
        isAdmin: false,
        reportCalls: [],
    };
    const { GET } = await loadRoute();
    const response = await GET(request());
    assert.equal(response.status, 404);
    assert.equal(world.reportCalls.length, 0);
});

test("an admin receives the report", async () => {
    world = {
        session: { user: { id: "admin_1", email: "admin@tomverse.app" } },
        isAdmin: true,
        reportCalls: [],
    };
    const { GET } = await loadRoute();
    const response = await GET(request());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.rows, 2);
    assert.equal(body.agreementRate, 0.5);
    assert.equal(world.reportCalls.length, 1);
    assert.equal(world.reportCalls[0].windowDays, undefined);
});

test("the window is passed through, and a non-numeric one is refused", async () => {
    world = {
        session: { user: { id: "admin_1" } },
        isAdmin: true,
        reportCalls: [],
    };
    const { GET } = await loadRoute();

    const ok = await GET(
        request("https://tomverse.app/api/admin/routing-shadow?days=7")
    );
    assert.equal(ok.status, 200);
    assert.equal(world.reportCalls[0].windowDays, 7);

    // Refused rather than silently defaulted: a mistyped window that quietly
    // becomes 30 days is a number nobody asked for.
    const bad = await GET(
        request("https://tomverse.app/api/admin/routing-shadow?days=week")
    );
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "INVALID_WINDOW");
    assert.equal(world.reportCalls.length, 1);
});

test("the response carries versions and counts, and no request content", async () => {
    world = {
        session: { user: { id: "admin_1" } },
        isAdmin: true,
        reportCalls: [],
    };
    const { GET } = await loadRoute();
    const body = await (await GET(request())).json();

    // Model ids and rule versions are expected; anything resembling a message,
    // a trace or a subject key is not.
    assert.ok(body.versions.selectionVersions.includes("router-selection-v1"));
    const serialised = JSON.stringify(body);
    for (const forbidden of ["traceId", "subjectKey", "userId", "message"]) {
        assert.ok(
            !serialised.includes(forbidden),
            `payload mentions ${forbidden}`
        );
    }
});
