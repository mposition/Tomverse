import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * `POST /api/imports/external` against a real database, for the boundary the
 * provider set is written on both sides of.
 *
 * docs/policy/external-import-gemini-a2.md §3.
 *
 * The Gemini adapter shipped and this route's request schema did not change,
 * so the browser parsed a Takeout export, offered its conversations, and the
 * first server call refused the import. Nothing caught it: the value crosses
 * as JSON, so no type compared the two, and every test written for the parser
 * stopped short of the upload.
 *
 * What is proved here is only reachable through the route -- that an
 * authenticated request with the flag on gets as far as creating a row, and
 * that a provider nobody has a parser for still does not.
 *
 * Its own process under scripts/run-db-integration-tests.mjs: mock.module is
 * process-global and this file replaces next-auth for every module that
 * imports it.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
    pathToFileURL(resolve(ROOT, relativePath)).href;

let sessionOverride: { user: { id: string; email: string } } | null = null;

mock.module("next-auth/next", {
    namedExports: { getServerSession: async () => sessionOverride },
});

type CreateRoute = { POST: (request: Request) => Promise<Response> };

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let route: CreateRoute;
let providers: readonly string[];
let flagKey: string;

before(async () => {
    ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));
    ({ EXTERNAL_IMPORT_PROVIDERS: providers } = (await import(
        mod("lib/externalImportProviders.ts")
    )) as typeof import("@/lib/externalImportProviders"));
    ({ EXTERNAL_IMPORT_FLAG_KEY: flagKey } = (await import(
        mod("lib/externalImportAccess.ts")
    )) as typeof import("@/lib/externalImportAccess"));
    route = (await import(mod("app/api/imports/external/route.ts"))) as CreateRoute;
});

const resetData = () =>
    prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "ExternalConversation", "ExternalImport", "ChatUsageBucket",
                   "AppSetting", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
    await resetData();
    sessionOverride = null;
});

after(async () => {
    await resetData();
    await prisma.$disconnect();
});

/** The feature is a rollout flag: off unless a row says otherwise (§15). */
const enableImport = () =>
    prisma.appSetting.create({ data: { key: flagKey, value: "true" } });

const signIn = async () => {
    const user = await prisma.user.create({
        data: { email: `importer-${Math.random().toString(36).slice(2)}@example.test` },
    });
    sessionOverride = { user: { id: user.id, email: user.email! } };
    return user;
};

const post = (body: unknown) =>
    route.POST(
        new Request("https://tomverse.test/api/imports/external", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        })
    );

test("every provider that has an adapter can start an import", async () => {
    // The regression itself. One of these is Gemini, and before the canon it
    // was the one the route refused.
    const user = await signIn();
    await enableImport();

    for (const provider of providers) {
        const response = await post({ provider, parserVersion: "v3" });
        assert.equal(response.status, 201, `${provider} must be accepted`);
        const body = (await response.json()) as { importId: string };
        const row = await prisma.externalImport.findUniqueOrThrow({
            where: { id: body.importId },
        });
        assert.equal(row.provider, provider);
        assert.equal(row.userId, user.id);
    }
    assert.equal(await prisma.externalImport.count(), providers.length);
});

test("a provider nobody has a parser for is refused, and writes nothing", async () => {
    await signIn();
    await enableImport();

    for (const provider of ["copilot", "GEMINI", "gemini ", "", null]) {
        const response = await post({ provider, parserVersion: "v3" });
        assert.equal(response.status, 400, `${String(provider)} must be refused`);
    }
    assert.equal(await prisma.externalImport.count(), 0);
});

test("the flag still gates Gemini, like every other provider", async () => {
    // A new provider must not arrive with its own way past the rollout flag.
    await signIn();
    const response = await post({ provider: "gemini", parserVersion: "v3" });
    assert.equal(response.status, 403);
    assert.equal(await prisma.externalImport.count(), 0);
});

test("an unauthenticated Gemini import is refused before the flag is even read", async () => {
    sessionOverride = null;
    const response = await post({ provider: "gemini", parserVersion: "v3" });
    assert.equal(response.status, 401);
    assert.equal(await prisma.externalImport.count(), 0);
});
