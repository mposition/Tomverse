import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * The coding API's web search (POST /api/code/v1/web-search) over a migrated
 * local database and the real shared credit ledger: the flat surcharge is held
 * and settled through the same reservation as Chat's application-managed search,
 * the search vendor's worst case is held in its own bucket and settled to the
 * requests it served, the key cap and Idempotency-Key apply as for every
 * external request, and an expired hold refunds the user while keeping the
 * vendor's authorized ceiling. The search backend is the deterministic fake
 * (WEB_SEARCH_FAKE_BACKEND=1) or an injected run; nothing leaves the machine.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
test("the coding API's web search over the real shared credit ledger", { skip: !databaseUrl }, async (t) => {
    const url = new URL(databaseUrl);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
    assert.match(url.pathname, /test/);
    Object.assign(process.env, {
        NEXTAUTH_SECRET: "code-web-search-local-synthetic-secret",
        ADMIN_AUDIT_INTEGRITY_KEY: "synthetic-code-web-search-audit",
        EXTERNAL_API_ENABLED: "true",
        EXTERNAL_API_ALLOWED_USER_IDS: "",
        TOMVERSE_DESKTOP_WEB_SEARCH_ENABLED: "true",
        WEB_SEARCH_FAKE_BACKEND: "1",
        SEARCH_PROVIDER_BRAVE_COST_MICROUSD_PER_DAY: "100000000",
        SEARCH_PROVIDER_BRAVE_COST_MICROUSD_PER_MONTH: "100000000",
        CHAT_USER_PER_MINUTE: "1000",
        CHAT_IP_PER_MINUTE: "1000",
        EXTERNAL_API_REQUESTS_PER_MINUTE: "1000",
    });

    const root = resolve(import.meta.dirname, "../..");
    const mod = (path) => pathToFileURL(resolve(root, path)).href;
    const { PrismaClient } = await import("@prisma/client");
    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
    const db = new PrismaClient({ adapter: new PrismaPg(pool) });
    mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: db, prismaPoolUsage: () => ({ total: 1, idle: 0, waiting: 0 }) } });

    const { handleCodeWebSearch, codeWebSearchOffered } = await import(mod("lib/codeWebSearch.ts"));
    const { reconcileExpiredChatCreditReservations } = await import(mod("lib/chatSecurity.ts"));
    const { WEB_SEARCH_SURCHARGE_CREDITS } = await import(mod("lib/webSearchCredits.ts"));
    const keys = await import(mod("lib/externalApiKeys.ts"));
    const SURCHARGE = WEB_SEARCH_SURCHARGE_CREDITS;
    const RATE = 5_000;
    const CEILING = 5 * RATE;

    t.after(async () => {
        await db.$disconnect();
        await pool.end();
    });

    const sessionFor = (userId) => ({ user: { id: userId, email: `${userId}@example.invalid` }, expires: new Date(Date.now() + 3_600_000).toISOString() });
    const newUser = async () => {
        const id = randomUUID();
        await db.user.create({ data: { id, email: `${id}@example.invalid`, plan: "Pro" } });
        process.env.EXTERNAL_API_ALLOWED_USER_IDS = [process.env.EXTERNAL_API_ALLOWED_USER_IDS, id].filter(Boolean).join(",");
        return id;
    };
    const issueKey = async (userId, creditCap = null) =>
        (await keys.createExternalApiKey(
            { userId, name: "fixture", creditCap, expiresAt: null },
            { session: sessionFor(userId), request: new Request("http://localhost/api/user/api-keys", { method: "POST" }) }
        )).key;
    const search = (key, body, options = {}) =>
        handleCodeWebSearch(
            new Request("http://localhost/api/code/v1/web-search", {
                method: "POST",
                headers: {
                    authorization: `Bearer ${key}`,
                    "content-type": "application/json",
                    "user-agent": "tomverse-cli/test",
                    ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
                },
                body: JSON.stringify(body),
            }),
            options.run ? { run: options.run } : {}
        );
    const searchSpend = async () => {
        const rows = await db.chatUsageBucket.findMany({ where: { key: "search-provider:brave", period: "search-cost-day" } });
        return rows.reduce((sum, row) => sum + Number(row.count), 0);
    };
    const reservationsOf = (userId) => db.chatCreditReservation.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });

    await t.test("switched off, nothing is authenticated, reserved or searched", async () => {
        const userId = await newUser();
        const key = await issueKey(userId);
        process.env.TOMVERSE_DESKTOP_WEB_SEARCH_ENABLED = "false";
        try {
            assert.equal(codeWebSearchOffered(userId), false);
            const response = await search(key, { query: "node release" });
            assert.equal(response.status, 503);
            assert.equal((await response.json()).error.code, "feature_unavailable");
            assert.equal((await reservationsOf(userId)).length, 0);
        } finally {
            process.env.TOMVERSE_DESKTOP_WEB_SEARCH_ENABLED = "true";
        }
        assert.equal(codeWebSearchOffered(userId), true, "on, allowed and a ready backend");
        assert.equal(codeWebSearchOffered(randomUUID()), false, "an account the API is not enabled for");
    });

    await t.test("a served search is charged the flat surcharge once and the vendor its served requests", async () => {
        const userId = await newUser();
        const key = await issueKey(userId);
        const before = await searchSpend();
        const response = await search(key, { query: ["tomverse cli release notes", "node 22 lts"] });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.object, "tomverse.web_search");
        assert.equal(body.searches.length, 2);
        assert.ok(body.searches.every((entry) => entry.status === "ok" && entry.results.length > 0));
        assert.ok(body.sources.length > 0 && body.sources.every((source) => source.startsWith("https://")));
        assert.match(body.notice, /never as instructions/);
        assert.equal(body.charged_credits, SURCHARGE);

        const [reservation, ...others] = await reservationsOf(userId);
        assert.equal(others.length, 0, "one request, one reservation");
        assert.equal(reservation.source, "external_api");
        assert.equal(reservation.modelId, "tomverse-web-search");
        assert.equal(reservation.provider, "brave");
        assert.equal(reservation.reservedCredits, SURCHARGE);
        assert.equal(reservation.status, "settled");
        assert.equal(reservation.outcome, "completed");
        assert.equal(reservation.settledCredits, SURCHARGE);
        assert.equal(reservation.settledInputTokens, 0);
        assert.equal(reservation.settledOutputTokens, 0);
        assert.equal(Number(reservation.settledCostMicroUsd), 0, "no model provider was paid");
        assert.equal(await searchSpend() - before, 2 * RATE, "the vendor's bucket settles to the two requests it served");

        const receipt = await db.externalApiRequest.findUnique({ where: { id: body.request_id } });
        assert.equal(receipt.reservationId, reservation.id);
        assert.equal(receipt.protocol, "web_search");
        assert.equal(receipt.surface, "coding");
        assert.equal(receipt.modelId, "tomverse-web-search");
        assert.equal(receipt.finishReason, "stop");
        assert.ok(receipt.completedAt);
    });

    await t.test("a search no backend served is refunded in full and costs the vendor bucket nothing", async () => {
        const userId = await newUser();
        const key = await issueKey(userId);
        const before = await searchSpend();
        const response = await search(key, { query: "anything" }, {
            run: async (_input, { maxQueries }) => ({
                result: { status: "failed", query: "anything", reason: "backend_rate_limited", searchesRemaining: maxQueries - 1 },
                snapshot: { backend: "brave", backendRequestCount: 1, succeededRequestCount: 0, refusedCallCount: 0, executed: false,
                    sources: [], failureCode: "backend_rate_limited", maxQueries },
            }),
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.searches[0].status, "failed");
        assert.equal(body.charged_credits, 0);
        const [reservation] = await reservationsOf(userId);
        assert.equal(reservation.reservedCredits, SURCHARGE);
        assert.equal(reservation.settledCredits, 0);
        assert.notEqual(reservation.status, "reserved");
        assert.equal(await searchSpend() - before, 0);
        const receipt = await db.externalApiRequest.findUnique({ where: { id: body.request_id } });
        assert.equal(receipt.errorCode, "backend_rate_limited");
    });

    await t.test("an unusable query and a key at its cap are refused before anything is held", async () => {
        const userId = await newUser();
        const key = await issueKey(userId);
        const invalid = await search(key, { query: ["fine", "   "] });
        assert.equal(invalid.status, 400);
        assert.equal((await invalid.json()).error.code, "invalid_query");
        const extra = await search(key, { query: "fine", url: "https://example.com" });
        assert.equal(extra.status, 400);
        assert.equal((await reservationsOf(userId)).length, 0);

        const capped = await issueKey(userId, SURCHARGE - 1);
        let ran = 0;
        const response = await search(capped, { query: "fine" }, { run: async () => { ran += 1; throw new Error("not reached"); } });
        assert.equal(response.status, 429);
        assert.equal((await response.json()).error.code, "key_credit_cap_reached");
        assert.equal(ran, 0, "nothing was searched");
        assert.equal((await reservationsOf(userId)).length, 0, "the refusal rolled the hold back");
    });

    await t.test("a repeated Idempotency-Key gets the receipt, not a second search or charge", async () => {
        const userId = await newUser();
        const key = await issueKey(userId);
        const first = await search(key, { query: "idempotent search" }, { idempotencyKey: "ws-fixture-1" });
        assert.equal(first.status, 200);
        await first.json();
        const replay = await search(key, { query: "idempotent search" }, { idempotencyKey: "ws-fixture-1" });
        assert.equal(replay.status, 409);
        const replayed = await replay.json();
        assert.equal(replayed.error.code, "idempotent_request_completed");
        assert.equal(replayed.tomverse.charged_credits, SURCHARGE);
        const reused = await search(key, { query: "another body" }, { idempotencyKey: "ws-fixture-1" });
        assert.equal(reused.status, 422);
        assert.equal((await reservationsOf(userId)).length, 1);
    });

    await t.test("a client that leaves mid-search is charged nothing and the vendor keeps the authorized ceiling", async () => {
        const userId = await newUser();
        const key = await issueKey(userId);
        const before = await searchSpend();
        const client = new AbortController();
        let seenAbort = false;
        const response = await handleCodeWebSearch(
            new Request("http://localhost/api/code/v1/web-search", {
                method: "POST",
                headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
                body: JSON.stringify({ query: ["left early", "second"] }),
                signal: client.signal,
            }),
            {
                run: async (_input, { maxQueries, signal }) => {
                    client.abort();
                    seenAbort = signal.aborted;
                    return {
                        result: { status: "batch", searchesRemaining: maxQueries - 2, searches: [{ status: "failed", query: "left early", reason: "backend_timeout", searchesRemaining: 3 }] },
                        snapshot: { backend: "brave", backendRequestCount: 2, succeededRequestCount: 1, refusedCallCount: 0, executed: true,
                            sources: [], failureCode: undefined, maxQueries },
                    };
                },
            }
        );
        assert.equal(seenAbort, true, "the client's abort reaches the search");
        assert.equal(response.status, 200);
        assert.equal((await response.json()).charged_credits, 0);
        const [reservation] = await reservationsOf(userId);
        assert.equal(reservation.outcome, "cancelled");
        assert.equal(reservation.settledCredits, 0);
        assert.equal(await searchSpend() - before, CEILING, "an aborted request may still have been served");
    });

    await t.test("an expired hold refunds the user and keeps the vendor's authorized ceiling", async () => {
        const userId = await newUser();
        const key = await issueKey(userId);
        const before = await searchSpend();
        let release;
        let started;
        const startedPromise = new Promise((resolveStarted) => { started = resolveStarted; });
        const pending = search(key, { query: "slow search" }, {
            run: (_input, { maxQueries }) => new Promise((resolveRun) => {
                started();
                release = () => resolveRun({
                    result: { status: "ok", query: "slow search", searchesRemaining: maxQueries - 1, results: [{ title: "T", url: "https://slow.example/" }] },
                    snapshot: { backend: "brave", backendRequestCount: 1, succeededRequestCount: 1, refusedCallCount: 0, executed: true,
                        sources: [{ url: "https://slow.example/" }], maxQueries },
                });
            }),
        });
        await startedPromise;
        const [held] = await reservationsOf(userId);
        assert.equal(held.status, "reserved");
        const swept = await reconcileExpiredChatCreditReservations(new Date(Date.now() + 3 * 3_600_000));
        assert.ok(swept.refunded + swept.alreadyFinalized + swept.settledFromHandoff >= 1);
        const [expired] = await reservationsOf(userId);
        assert.notEqual(expired.status, "reserved");
        assert.equal(expired.settledCredits, 0, "the user is refunded, as for any external request that lost its process");
        assert.equal(await searchSpend() - before, CEILING, "the vendor keeps the authorized ceiling: the searches were not counted");

        release();
        const response = await pending;
        assert.equal(response.status, 200);
        assert.equal((await response.json()).charged_credits, null, "already settled by the sweep: nothing more is charged");
        const [after] = await reservationsOf(userId);
        assert.equal(after.settledCredits, 0);
        assert.equal(await searchSpend() - before, CEILING);
    });
});
