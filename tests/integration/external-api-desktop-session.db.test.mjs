import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { MockLanguageModelV4 } from "ai/test";
import { getSingleAccountCostCeiling, providerBudgetEnvName } from "../../lib/providerCostBudget.ts";

/**
 * Desktop Code on the signed-in Desktop session instead of an API key (owner decision 2026-11-27,
 * docs/policy/external-api.md section 11.2), end to end against a migrated local database and the real shared
 * credit ledger. Only the model provider and the search backend are faked; the Desktop access tokens are real ones
 * minted by the Desktop sign-in service.
 *
 * What this fixes: a Desktop session request is the same account caller a key is -- the same plan check, the same
 * reservation, the same settlement and refund to the credit, the same receipt, with no key cap and its own
 * Idempotency-Key scope; only the Desktop origin on the engine's exact coding API paths, with the switch on, is read
 * as a session; an expired, revoked, wrong-audience or signed-out session is a 401 with nothing held; the account's
 * concurrency and cost limits bound it; and its receipts go with the account.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
test("Desktop Code on the Desktop session over the real shared credit ledger", { skip: !databaseUrl }, async (t) => {
    const url = new URL(databaseUrl);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
    assert.match(url.pathname, /test/);
    const MODEL_ID = "gpt-6-luna";
    const ed25519 = () => generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    Object.assign(process.env, {
        NEXTAUTH_SECRET: "external-api-desktop-session-synthetic-secret",
        ADMIN_AUDIT_INTEGRITY_KEY: "synthetic-external-api-desktop-session-audit",
        EXTERNAL_API_ENABLED: "true",
        OPENAI_API_KEY: "sk-fixture-not-a-key",
        EXTERNAL_API_ALLOWED_USER_IDS: "",
        CHAT_USER_PER_MINUTE: "1000",
        CHAT_IP_PER_MINUTE: "1000",
        EXTERNAL_API_REQUESTS_PER_MINUTE: "1000",
        EXTERNAL_API_READS_PER_MINUTE: "1000",
        // The Desktop sign-in service, with synthetic keys.
        MOBILE_AUTH_SIGNING_KEYS: `sign-1:${ed25519()}`,
        MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-1",
        MOBILE_AUTH_REFRESH_PEPPERS: `pep-1:${randomBytes(32).toString("base64url")}`,
        MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "pep-1",
        MOBILE_AUTH_TOKEN_ISSUER: "https://tomverse.test",
        MOBILE_AUTH_TOKEN_AUDIENCE: "tomverse-mobile-api",
        TOMVERSE_DESKTOP_AUTH_ENABLED: "true",
        TOMVERSE_DESKTOP_CODE_SESSION_ENABLED: "true",
        // The coding API's web search, on the deterministic fake backend.
        TOMVERSE_DESKTOP_WEB_SEARCH_ENABLED: "true",
        WEB_SEARCH_FAKE_BACKEND: "1",
        SEARCH_PROVIDER_BRAVE_COST_MICROUSD_PER_DAY: "100000000",
        SEARCH_PROVIDER_BRAVE_COST_MICROUSD_PER_MONTH: "100000000",
    });
    const floor = getSingleAccountCostCeiling();
    for (const period of ["day", "month"]) process.env[providerBudgetEnvName("openai", period)] = String(floor[period]);

    const root = resolve(import.meta.dirname, "../..");
    const mod = (path) => pathToFileURL(resolve(root, path)).href;
    const { PrismaClient } = await import("@prisma/client");
    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
    const db = new PrismaClient({ adapter: new PrismaPg(pool) });
    let beforeReservationTransaction;
    const prisma = new Proxy(db, {
        get(target, key) {
            if (key === "$transaction") {
                return async (callback, ...rest) => {
                    if (beforeReservationTransaction && typeof callback === "function" && String(callback).includes("lockCreditAccount")) {
                        const hook = beforeReservationTransaction;
                        beforeReservationTransaction = undefined;
                        await hook();
                    }
                    return target.$transaction(callback, ...rest);
                };
            }
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    mock.module(mod("lib/prisma.ts"), { namedExports: { prisma, prismaPoolUsage: () => ({ total: 1, idle: 0, waiting: 0 }) } });

    let dispatches = 0;
    let script;
    mock.module(mod("lib/activeAiModel.ts"), {
        namedExports: {
            getActiveAiModel: () => new MockLanguageModelV4({
                doStream: async (options) => {
                    dispatches += 1;
                    return script(options);
                },
            }),
            QWEN_GROUNDED_THINKING_BUDGET: 128,
            qwenLookupStep: () => undefined,
            createCohereResearchFetch: (f) => f,
        },
    });
    mock.module(mod("lib/autoLlmRouter.ts"), { namedExports: { pickAutoModelWithLlm: async () => null } });

    const { handleChatCompletions } = await import(mod("lib/externalApiInference.ts"));
    const { handleCodeWebSearch } = await import(mod("lib/codeWebSearch.ts"));
    const { GET: codingModels } = await import(mod("app/api/code/v1/models/route.ts"));
    const { GET: codingUsage } = await import(mod("app/api/code/v1/usage/route.ts"));
    const { GET: codingStatus } = await import(mod("app/api/code/v1/requests/status/route.ts"));
    const { issueMobileSession } = await import(mod("lib/mobileAuthService.ts"));
    const { POST: codeTokenRoute } = await import(mod("app/api/auth/desktop/code-token/route.ts"));
    const { mintMobileAccessToken } = await import(mod("lib/mobileAccessToken.ts"));
    const { resetMobileSessionSnapshotsForTesting } = await import(mod("lib/mobileSessionAuthorization.ts"));
    const { WEB_SEARCH_SURCHARGE_CREDITS } = await import(mod("lib/webSearchCredits.ts"));
    const keys = await import(mod("lib/externalApiKeys.ts"));

    t.after(async () => {
        await db.$disconnect();
        await pool.end();
    });

    const usage = (input = 120, output = 30) => ({
        inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: output, text: output, reasoning: 0 },
    });
    const streamOf = (parts) => ({
        stream: new ReadableStream({
            start(controller) {
                for (const part of parts) {
                    if (part instanceof Error) {
                        controller.error(part);
                        return;
                    }
                    controller.enqueue(part);
                }
                controller.close();
            },
        }),
    });
    const textScript = () => () =>
        streamOf([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "Hello from the fixture." },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
        ]);
    script = textScript();

    const DESKTOP = "tomverse://desktop";
    const sessionFor = (userId) => ({ user: { id: userId, email: `${userId}@example.invalid` }, expires: new Date(Date.now() + 3_600_000).toISOString() });
    const newUser = async (plan = "Pro") => {
        const id = randomUUID();
        await db.user.create({ data: { id, email: `${id}@example.invalid`, plan } });
        process.env.EXTERNAL_API_ALLOWED_USER_IDS = [process.env.EXTERNAL_API_ALLOWED_USER_IDS, id].filter(Boolean).join(",");
        return id;
    };
    const issueKey = async (userId, extra = {}) =>
        keys.createExternalApiKey({ userId, name: "fixture", creditCap: null, expiresAt: null, ...extra },
            { session: sessionFor(userId), request: new Request("http://localhost/api/user/api-keys", { method: "POST" }) });
    const signIn = async (userId, platform = "desktop") => {
        const issued = await issueMobileSession({
            request: new Request("https://tomverse.test/api/auth/desktop/exchange", { method: "POST" }),
            userId, platform, deviceLabel: platform === "desktop" ? "Work PC" : "Phone",
        });
        assert.equal(issued.ok, true);
        const family = await db.mobileTokenFamily.findFirstOrThrow({ where: { userId, deviceId: issued.tokens.deviceId } });
        // A Desktop's Code runtimes carry the short Code token minted for its session, never the session token itself.
        const minted = platform === "desktop" ? await mintCodeToken(issued.tokens.accessToken) : null;
        return { ...issued.tokens, familyId: family.id, desktopToken: issued.tokens.accessToken, token: minted?.accessToken ?? issued.tokens.accessToken };
    };
    const askCodeToken = (bearer, headers = {}) =>
        codeTokenRoute(new Request("http://localhost/api/auth/desktop/code-token", { method: "POST", headers: { authorization: `Bearer ${bearer}`, ...headers } }));
    const mintCodeToken = async (bearer) => {
        const response = await askCodeToken(bearer);
        assert.equal(response.status, 200, await response.clone().text());
        const minted = await response.json();
        assert.equal(minted.ok, true);
        assert.ok(minted.expiresIn > 0 && minted.expiresIn <= 600);
        return minted;
    };
    const body = (extra = {}) => ({ model: MODEL_ID, messages: [{ role: "user", content: "Say hello" }], ...extra });
    /** The engine's own request: the coding API, its user agent, a bearer; the Desktop origin only when `desktop`. */
    const complete = (bearer, payload = body(), { desktop = false, path = "/api/code/v1/chat/completions", headers = {} } = {}) =>
        handleChatCompletions(new Request(`http://localhost${path}`, {
            method: "POST",
            headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "user-agent": "tomverse-desktop",
                ...(desktop ? { origin: DESKTOP } : {}), ...headers },
            body: JSON.stringify(payload),
        }), { surface: path.startsWith("/api/code/") ? "coding" : "general" });
    const read = (route, path, bearer, { desktop = true, headers = {} } = {}) =>
        route(new Request(`http://localhost${path}`, {
            headers: { authorization: `Bearer ${bearer}`, ...(desktop ? { origin: DESKTOP } : {}), ...headers },
        }));
    const search = (bearer, { desktop = true, idempotencyKey } = {}) =>
        handleCodeWebSearch(new Request("http://localhost/api/code/v1/web-search", {
            method: "POST",
            headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "user-agent": "tomverse-desktop",
                ...(desktop ? { origin: DESKTOP } : {}), ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
            body: JSON.stringify({ query: "node 22 lts" }),
        }));
    const reservationsFor = (userId) => db.chatCreditReservation.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
    const receiptOf = (reservation) => db.externalApiRequest.findUnique({ where: { reservationId: reservation.id } });

    await t.test("a Desktop session request is charged, settled and receipted exactly as a key request is", { timeout: 120_000 }, async () => {
        const userId = await newUser();
        const { key, summary } = await issueKey(userId);
        const session = await signIn(userId);
        const before = dispatches;
        const byKey = await complete(key);
        assert.equal(byKey.status, 200);
        const bySession = await complete(session.token, body(), { desktop: true });
        assert.equal(bySession.status, 200, await bySession.clone().text());
        assert.equal((await bySession.json()).choices[0].message.content, "Hello from the fixture.");
        assert.equal(dispatches - before, 2);

        const [keyHold, sessionHold, ...others] = await reservationsFor(userId);
        assert.equal(others.length, 0);
        for (const hold of [keyHold, sessionHold]) {
            assert.equal(hold.source, "external_api");
            assert.equal(hold.status, "settled");
            assert.equal(hold.outcome, "completed");
        }
        // The same price and the same settlement rule: one account, one ledger, the same amounts.
        assert.equal(sessionHold.reservedCredits, keyHold.reservedCredits);
        assert.equal(sessionHold.settledCredits, keyHold.settledCredits);
        assert.ok(sessionHold.settledCredits > 0);
        assert.equal(sessionHold.settledCostMicroUsd, keyHold.settledCostMicroUsd);
        assert.equal(sessionHold.subjectKey, keyHold.subjectKey, "the same account subject");

        const keyReceipt = await receiptOf(keyHold);
        const sessionReceipt = await receiptOf(sessionHold);
        assert.equal(keyReceipt.keyId, summary.id);
        assert.equal(keyReceipt.desktopUserId, null);
        assert.equal(sessionReceipt.keyId, null, "no key");
        assert.equal(sessionReceipt.desktopUserId, userId, "the Desktop session of this account");
        assert.equal(sessionReceipt.userId, userId);
        assert.equal(sessionReceipt.surface, "coding");
        assert.equal(sessionReceipt.protocol, "chat_completions");
        assert.equal(sessionReceipt.finishReason, "stop");
        assert.equal(bySession.headers.get("x-request-id"), sessionReceipt.id);
        const stored = JSON.stringify(sessionReceipt);
        assert.ok(!stored.includes(session.token) && !stored.includes("Say hello"), "content-free, and no token");
        // The key is untouched by a session request: its own totals count only its own request.
        const [keySummary] = await keys.listExternalApiKeys(userId);
        assert.equal(keySummary.committedCredits, keyHold.settledCredits);
        assert.equal(keySummary.requestCount, 1);
    });

    await t.test("a provider refusal is refunded on the session as on a key", { timeout: 120_000 }, async () => {
        const userId = await newUser();
        const { key } = await issueKey(userId);
        const session = await signIn(userId);
        const { APICallError } = await import("ai");
        script = () => streamOf([new APICallError({ message: "rate limited", url: "https://provider.invalid", requestBodyValues: {}, statusCode: 429, isRetryable: true })]);
        try {
            assert.equal((await complete(key)).status, 502);
            assert.equal((await complete(session.token, body(), { desktop: true })).status, 502);
        } finally {
            script = textScript();
        }
        const [keyHold, sessionHold] = await reservationsFor(userId);
        for (const hold of [keyHold, sessionHold]) {
            assert.equal(hold.outcome, "failed");
            assert.equal(hold.settledCredits, 0, "a refusal costs nothing");
        }
        assert.equal(sessionHold.settledCostMicroUsd, keyHold.settledCostMicroUsd);
        assert.equal((await receiptOf(sessionHold)).desktopUserId, userId);
    });

    await t.test("the session's receipts, status lookup and Idempotency-Key are its own, apart from the key's", { timeout: 120_000 }, async () => {
        const userId = await newUser();
        const { key } = await issueKey(userId);
        const session = await signIn(userId);
        const headers = { "idempotency-key": "step-1" };
        const first = await complete(session.token, body(), { desktop: true, headers });
        assert.equal(first.status, 200);
        const firstId = first.headers.get("x-request-id");
        // The same header on a key request is that key's own, not a replay of the session's.
        const byKey = await complete(key, body(), { headers });
        assert.equal(byKey.status, 200);
        const keyRequestId = byKey.headers.get("x-request-id");
        assert.notEqual(keyRequestId, firstId);

        const before = dispatches;
        const replay = await complete(session.token, body(), { desktop: true, headers });
        assert.equal(replay.status, 409);
        const replayed = await replay.json();
        assert.equal(replayed.error.code, "idempotent_request_completed");
        assert.equal(replayed.tomverse.request_id, firstId);
        const reuse = await complete(session.token, body({ messages: [{ role: "user", content: "Something else" }] }), { desktop: true, headers });
        assert.equal(reuse.status, 422);
        assert.equal(dispatches, before, "neither dispatches");

        const report = await (await read(codingUsage, "/api/code/v1/usage?limit=10", session.token)).json();
        assert.equal(report.key, null, "a session has no key");
        assert.deepEqual(report.requests.map((r) => r.requestId), [firstId]);
        assert.equal(report.requests[0].source, "desktop_session");
        const keyReport = await (await read(codingUsage, "/api/code/v1/usage?limit=10", key, { desktop: false })).json();
        assert.deepEqual(keyReport.requests.map((r) => r.requestId), [keyRequestId]);
        assert.equal(keyReport.requests[0].source, "api_key");

        const byHeader = await read(codingStatus, "/api/code/v1/requests/status", session.token, { headers });
        assert.equal(byHeader.status, 200);
        assert.equal((await byHeader.json()).request.requestId, firstId);
        const byId = await read(codingStatus, `/api/code/v1/requests/status?request_id=${firstId}`, session.token);
        assert.equal((await byId.json()).request.requestId, firstId);
        const keysRequest = await read(codingStatus, `/api/code/v1/requests/status?request_id=${keyRequestId}`, session.token);
        assert.equal(keysRequest.status, 404, "a session never reads the key's requests");
        const sessionsRequest = await read(codingStatus, `/api/code/v1/requests/status?request_id=${firstId}`, key, { desktop: false });
        assert.equal(sessionsRequest.status, 404, "nor a key the session's");
    });

    await t.test("only the Desktop origin, on the engine's coding paths, with the switch on, is read as a session", { timeout: 120_000 }, async () => {
        const userId = await newUser();
        const { key } = await issueKey(userId);
        const session = await signIn(userId);
        const before = dispatches;
        const refusals = [
            ["no Desktop origin", await complete(session.token)],
            ["the general API", await complete(session.token, body(), { desktop: true, path: "/api/v1/chat/completions" })],
            ["a key from the Desktop origin", await complete(key, body(), { desktop: true })],
            ["a cookie beside the session", await complete(session.token, body(), { desktop: true, headers: { cookie: "next-auth.session-token=x" } })],
        ];
        process.env.TOMVERSE_DESKTOP_CODE_SESSION_ENABLED = "false";
        try {
            refusals.push(["the switch off", await complete(session.token, body(), { desktop: true })]);
            refusals.push(["the model list with the switch off", await read(codingModels, "/api/code/v1/models", session.token)]);
        } finally {
            process.env.TOMVERSE_DESKTOP_CODE_SESSION_ENABLED = "true";
        }
        process.env.TOMVERSE_DESKTOP_AUTH_ENABLED = "false";
        try {
            refusals.push(["Desktop sign-in off", await complete(session.token, body(), { desktop: true })]);
        } finally {
            process.env.TOMVERSE_DESKTOP_AUTH_ENABLED = "true";
        }
        for (const [label, response] of refusals) assert.equal(response.status, 401, label);
        assert.equal(dispatches, before, "nothing dispatched");
        assert.equal((await reservationsFor(userId)).length, 0, "nothing held");
        // The same token, the same switch, the right origin and path: accepted.
        const models = await read(codingModels, "/api/code/v1/models", session.token);
        assert.equal(models.status, 200);
        assert.ok((await models.json()).data.some((entry) => entry.id === MODEL_ID));
    });

    await t.test("an expired, revoked, mobile or suspended session is a 401 with nothing held", { timeout: 120_000 }, async () => {
        const userId = await newUser();
        const session = await signIn(userId);
        const family = await db.mobileTokenFamily.findUniqueOrThrow({ where: { id: session.familyId } });
        const expired = mintMobileAccessToken({ userId, deviceId: family.deviceId, familyId: family.id, client: "desktop-code",
            now: new Date(Date.now() - 3_600_000) }).token;
        const mobile = await signIn(userId, "ios");
        const before = dispatches;
        for (const [label, token] of [["expired", expired], ["a mobile token", mobile.accessToken], ["not a token", "tvs_" + "x".repeat(40)],
            // The Desktop session token itself is not a Code token: a runtime cannot be handed it in place of one.
            ["the Desktop session token", session.desktopToken]]) {
            const response = await complete(token, body(), { desktop: true });
            assert.equal(response.status, 401, label);
            assert.equal((await response.json()).error.code, "invalid_desktop_session", label);
        }
        await db.mobileTokenFamily.update({ where: { id: family.id }, data: { revokedAt: new Date(), revokedReason: "logout" } });
        resetMobileSessionSnapshotsForTesting();
        assert.equal((await complete(session.token, body(), { desktop: true })).status, 401, "signed out");
        const other = await signIn(userId);
        await db.user.update({ where: { id: userId }, data: { accountStatus: "suspended" } });
        resetMobileSessionSnapshotsForTesting();
        assert.equal((await complete(other.token, body(), { desktop: true })).status, 401, "a suspended account");
        assert.equal(dispatches, before);
        assert.equal((await reservationsFor(userId)).length, 0);
    });

    await t.test("only a live Desktop session gets a Code token, and a Code token gets nothing else", { timeout: 120_000 }, async () => {
        const userId = await newUser();
        const session = await signIn(userId);
        const mobile = await signIn(userId, "ios");
        // The Code token cannot mint another, a mobile token cannot mint one, and neither can a Code key.
        const { key } = await issueKey(userId);
        for (const [label, bearer] of [["a Code token", session.token], ["a mobile token", mobile.accessToken], ["a Code key", key]]) {
            assert.equal((await askCodeToken(bearer)).status, 401, label);
        }
        // Bearer only: an Origin or a cookie beside it is refused.
        assert.equal((await askCodeToken(session.desktopToken, { origin: "https://attacker.invalid" })).status, 403);
        assert.equal((await askCodeToken(session.desktopToken, { cookie: "next-auth.session-token=x" })).status, 403);
        // Off: not available, nothing minted.
        process.env.TOMVERSE_DESKTOP_CODE_SESSION_ENABLED = "false";
        try {
            assert.equal((await askCodeToken(session.desktopToken)).status, 503);
        } finally {
            process.env.TOMVERSE_DESKTOP_CODE_SESSION_ENABLED = "true";
        }
        // A fresh one for a live session works; once the session is signed out, neither it nor a new one does.
        const fresh = await mintCodeToken(session.desktopToken);
        assert.equal((await complete(fresh.accessToken, body(), { desktop: true })).status, 200);
        await db.mobileTokenFamily.update({ where: { id: session.familyId }, data: { revokedAt: new Date(), revokedReason: "logout" } });
        resetMobileSessionSnapshotsForTesting();
        assert.equal((await complete(fresh.accessToken, body(), { desktop: true })).status, 401);
        assert.equal((await askCodeToken(session.desktopToken)).status, 401);
    });

    await t.test("a session signed out between authentication and reservation admits nothing", { timeout: 120_000 }, async () => {
        const userId = await newUser();
        const session = await signIn(userId);
        const before = dispatches;
        beforeReservationTransaction = () =>
            db.mobileTokenFamily.update({ where: { id: session.familyId }, data: { revokedAt: new Date(), revokedReason: "logout" } });
        const response = await complete(session.token, body(), { desktop: true });
        assert.equal(response.status, 401);
        assert.equal((await response.json()).error.code, "invalid_desktop_session");
        assert.equal(dispatches, before);
        assert.equal((await reservationsFor(userId)).length, 0, "the hold rolled back with the refusal");
        assert.equal(await db.externalApiRequest.count({ where: { userId } }), 0);
    });

    await t.test("a sign-out still committing when the reservation starts is waited for, then refused", { timeout: 120_000 }, async () => {
        const userId = await newUser();
        const session = await signIn(userId);
        const before = dispatches;
        let signOut;
        // A sign-out that holds the family row while the admission reaches it, and commits the revocation half a second later.
        beforeReservationTransaction = async () => {
            let locked;
            const holding = new Promise((resolve) => (locked = resolve));
            signOut = db.$transaction(async (tx) => {
                await tx.$executeRaw`SELECT "id" FROM "MobileTokenFamily" WHERE "id" = ${session.familyId} FOR UPDATE`;
                await tx.mobileTokenFamily.update({ where: { id: session.familyId }, data: { revokedAt: new Date(), revokedReason: "logout" } });
                locked();
                await new Promise((settle) => setTimeout(settle, 500));
            });
            await holding;
        };
        const started = Date.now();
        const response = await complete(session.token, body(), { desktop: true });
        await signOut;
        assert.equal(response.status, 401);
        assert.equal((await response.json()).error.code, "invalid_desktop_session");
        assert.ok(Date.now() - started >= 400, "the admission waited for the sign-out to commit");
        assert.equal(dispatches, before);
        assert.equal((await reservationsFor(userId)).length, 0);
    });

    await t.test("Code is Pro and above on the session as with a key", { timeout: 120_000 }, async () => {
        const free = await newUser("Free");
        const session = await signIn(free);
        const refused = await complete(session.token, body(), { desktop: true });
        assert.equal(refused.status, 403);
        assert.equal((await refused.json()).error.code, "plan_not_eligible");
        const models = await read(codingModels, "/api/code/v1/models", session.token);
        assert.equal(models.status, 403);
        assert.equal((await models.json()).error.code, "plan_not_eligible");
        assert.equal((await search(session.token)).status, 403);
        assert.equal((await reservationsFor(free)).length, 0);
        // Read per request: on a paid plan the same session works.
        await db.user.update({ where: { id: free }, data: { plan: "Pro" } });
        assert.equal((await complete(session.token, body(), { desktop: true })).status, 200);
    });

    await t.test("no key cap reaches a session; the account's concurrency and cost limits do", { timeout: 120_000 }, async () => {
        const userId = await newUser();
        const session = await signIn(userId);
        assert.equal((await complete(session.token, body(), { desktop: true })).status, 200);
        const perRequest = (await reservationsFor(userId))[0].settledCredits;
        // A key capped at one request, used up: the key is refused, the session is not.
        const capped = await issueKey(userId, { creditCap: perRequest });
        assert.equal((await complete(capped.key)).status, 200);
        const atCap = await complete(capped.key);
        assert.equal(atCap.status, 429);
        assert.equal((await atCap.json()).error.code, "key_credit_cap_reached");
        for (let i = 0; i < 2; i += 1) assert.equal((await complete(session.token, body(), { desktop: true })).status, 200);

        // One account's concurrency: with the account's slots held (here by its own Chat), a session request is refused as a key's is.
        const { key } = await issueKey(userId);
        const security = await import(mod("lib/chatSecurity.ts"));
        const { getRuntimeModel } = await import(mod("lib/modelRegistry.ts"));
        const { getUserBillingPlan } = await import(mod("lib/billingEntitlements.ts"));
        const plan = await getUserBillingPlan(userId);
        const model = await getRuntimeModel(MODEL_ID);
        const access = security.identifyChatCaller(new Request("http://localhost/api/chat"), userId, plan.tier, {
            dailyMessageLimit: plan.dailyMessageLimit, monthlyMessageLimit: plan.monthlyMessageLimit,
        });
        process.env.CHAT_USER_CONCURRENT = "2";
        const held = [];
        try {
            for (let i = 0; i < 2; i += 1) held.push(await security.acquireChatAccess(access, security.createChatBudget("user", model, 10), { source: "chat" }));
            const before = dispatches;
            for (const response of [await complete(session.token, body(), { desktop: true }), await complete(key)]) {
                assert.equal(response.status, 429);
                assert.equal((await response.json()).error.code, "CHAT_CONCURRENCY_EXCEEDED");
            }
            assert.equal(dispatches, before, "refused before dispatch");
            for (const grant of held.splice(0)) await security.releaseChatAccess(grant.leaseId);
            assert.equal((await complete(session.token, body(), { desktop: true })).status, 200, "a free slot admits it");
        } finally {
            for (const grant of held) await security.releaseChatAccess(grant.leaseId).catch(() => undefined);
            delete process.env.CHAT_USER_CONCURRENT;
        }

        // The provider cost ceiling: with the provider's day spent, a request is refused before dispatch, on the session as on a key.
        const { providerBucketKey } = await import(mod("lib/chatProviderHolds.ts"));
        const bucket = await db.chatUsageBucket.findFirstOrThrow({
            where: { key: providerBucketKey("openai"), period: "provider-cost-day" }, orderBy: { periodStart: "desc" },
        });
        const where = { key_period_periodStart: { key: bucket.key, period: bucket.period, periodStart: bucket.periodStart } };
        await db.chatUsageBucket.update({ where, data: { count: BigInt(process.env[providerBudgetEnvName("openai", "day")]) } });
        const before = dispatches;
        try {
            const bySession = await complete(session.token, body(), { desktop: true });
            const byKey = await complete(key);
            assert.equal(bySession.status, byKey.status);
            assert.ok(bySession.status >= 400, String(bySession.status));
            assert.equal((await bySession.json()).error.code, (await byKey.json()).error.code);
        } finally {
            await db.chatUsageBucket.update({ where, data: { count: bucket.count } });
        }
        assert.equal(dispatches, before, "the ceiling dispatches nothing");
    });

    await t.test("web search on the session: the same surcharge, hold and receipt as a key", { timeout: 120_000 }, async () => {
        const userId = await newUser();
        const { key } = await issueKey(userId);
        const session = await signIn(userId);
        const byKey = await search(key, { desktop: false });
        assert.equal(byKey.status, 200);
        const bySession = await search(session.token, { idempotencyKey: "search-1" });
        assert.equal(bySession.status, 200, await bySession.clone().text());
        const answer = await bySession.json();
        assert.equal(answer.charged_credits, WEB_SEARCH_SURCHARGE_CREDITS);
        assert.equal(answer.charged_credits, (await byKey.json()).charged_credits);
        const receipt = await db.externalApiRequest.findUnique({ where: { id: answer.request_id } });
        assert.equal(receipt.keyId, null);
        assert.equal(receipt.desktopUserId, userId);
        assert.equal(receipt.protocol, "web_search");
        const [keyHold, sessionHold] = await reservationsFor(userId);
        assert.equal(sessionHold.settledCredits, keyHold.settledCredits);
        assert.equal(sessionHold.status, "settled");
        // Never sent twice: the same Idempotency-Key is a receipt.
        const replay = await search(session.token, { idempotencyKey: "search-1" });
        assert.equal(replay.status, 409);
        assert.equal((await reservationsFor(userId)).length, 2);
        assert.equal((await search(session.token, { desktop: false })).status, 401, "not without the Desktop origin");
    });

    await t.test("database guards, and the session's receipts go with the account", { timeout: 120_000 }, async () => {
        const userId = await newUser();
        const session = await signIn(userId);
        assert.equal((await complete(session.token, body(), { desktop: true })).status, 200);
        const [hold] = await reservationsFor(userId);
        const receipt = await receiptOf(hold);
        const { key, summary } = await issueKey(userId);
        assert.ok(key);
        // Exactly one credential, and only the row's own account as its session.
        await assert.rejects(db.externalApiRequest.update({ where: { id: receipt.id }, data: { keyId: summary.id } }));
        await assert.rejects(db.externalApiRequest.update({ where: { id: receipt.id }, data: { desktopUserId: null } }));
        const other = await newUser();
        await assert.rejects(db.externalApiRequest.update({ where: { id: receipt.id }, data: { desktopUserId: other } }));
        assert.equal((await receiptOf(hold)).desktopUserId, userId, "unchanged");

        await db.user.delete({ where: { id: userId } });
        assert.equal(await db.externalApiRequest.count({ where: { id: receipt.id } }), 0, "removed with the account");
        const kept = await db.chatCreditReservation.findUnique({ where: { id: hold.id } });
        assert.equal(kept.userId, null, "the shared ledger keeps its row, detached from the person");
    });
});
