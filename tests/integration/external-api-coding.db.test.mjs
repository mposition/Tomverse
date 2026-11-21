import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { getSingleAccountCostCeiling, providerBudgetEnvName } from "../../lib/providerCostBudget.ts";

/**
 * The coding API (owner decision 2026-11-21) end to end against a migrated
 * local database and the real shared credit ledger: a coding row chat does not
 * have (a dedicated row) runs as its own published row on the coding API, and
 * is charged its row's credit weight at its row's prices through the same
 * reservation, provider budget and settlement as every external request; the
 * general API never offers it. Only the provider is faked.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
test("the coding API over the real shared credit ledger", { skip: !databaseUrl }, async (t) => {
    const url = new URL(databaseUrl);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
    assert.match(url.pathname, /test/);
    Object.assign(process.env, {
        NEXTAUTH_SECRET: "external-api-local-synthetic-secret",
        ADMIN_AUDIT_INTEGRITY_KEY: "synthetic-external-api-audit",
        EXTERNAL_API_ENABLED: "true",
        EXTERNAL_API_ANTHROPIC_ENABLED: "true",
        ANTHROPIC_API_KEY: "sk-ant-fixture-server",
        EXTERNAL_API_ALLOWED_USER_IDS: "",
        CHAT_USER_PER_MINUTE: "1000",
        CHAT_IP_PER_MINUTE: "1000",
        EXTERNAL_API_REQUESTS_PER_MINUTE: "1000",
        EXTERNAL_API_READS_PER_MINUTE: "1000",
    });
    const floor = getSingleAccountCostCeiling();
    for (const period of ["day", "month"]) process.env[providerBudgetEnvName("anthropic", period)] = String(floor[period]);

    const root = resolve(import.meta.dirname, "../..");
    const mod = (path) => pathToFileURL(resolve(root, path)).href;
    const { PrismaClient } = await import("@prisma/client");
    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
    const db = new PrismaClient({ adapter: new PrismaPg(pool) });
    mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: db, prismaPoolUsage: () => ({ total: 1, idle: 0, waiting: 0 }) } });

    const sent = [];
    let reply = null;
    class NativeUpstreamUnavailable extends Error {}
    mock.module(mod("lib/externalApiNativeUpstream.ts"), {
        namedExports: {
            NativeUpstreamUnavailable,
            nativeUpstreamFetch: async (provider, path, init) => {
                sent.push({ provider, path, body: JSON.parse(init.body) });
                return reply();
            },
        },
    });
    // No router call is made here; the module is faked so none could be.
    mock.module(mod("lib/autoLlmRouter.ts"), { namedExports: { pickAutoModelWithLlm: async () => null } });

    const { handleNativeGeneration } = await import(mod("lib/externalApiNative.ts"));
    const { anthropicMessagesSpec } = await import(mod("lib/externalApiNativeSpecs.ts"));
    const { GET: codingModels } = await import(mod("app/api/code/anthropic/v1/models/route.ts"));
    const { GET: generalModels } = await import(mod("app/api/anthropic/v1/models/route.ts"));
    const { codingCreditFloor, loadCodingCatalog, servableCodingRows } = await import(mod("lib/modelCatalog.ts"));
    const { catalogContentHash } = await import(mod("lib/modelCatalogCore.ts"));
    const keys = await import(mod("lib/externalApiKeys.ts"));

    const MODEL_ID = `claude-coder-fixture-${randomUUID().slice(0, 8)}`;
    const today = new Date().toISOString().slice(0, 10);
    const profile = {
        source: "dedicated",
        name: "Claude Coder Fixture",
        provider: "anthropic",
        apiModelId: "claude-coder-fixture",
        minimumPlan: "Pro",
        capabilities: { toolCalling: "parallel", structuredOutput: "forced_tool_use", imageInput: false, maxContextTokens: 32_000, maxOutputTokens: 2_000 },
        pricing: { inputUsdPerMTok: 0.5, outputUsdPerMTok: 2, creditWeight: 1, verifiedAt: today, sources: ["https://docs.anthropic.com/en/docs/about-claude/pricing"] },
        terms: { allowsResaleAndCodingAgent: true, url: "https://www.anthropic.com/legal/commercial-terms", checkedAt: today },
        retention: { url: "https://docs.anthropic.com/en/docs/data-retention", checkedAt: today },
        processingRegion: "US",
        channels: ["code", "api"],
    };
    // A weight above the coding floor, and not any chat class's default.
    const creditWeight = codingCreditFloor(profile) + 4;
    profile.pricing.creditWeight = creditWeight;

    const sse = (events) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
    const anthropicStream = () =>
        sse([
            ["message_start", { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", content: [], usage: { input_tokens: 900, cache_creation_input_tokens: 300, output_tokens: 1 } } }],
            ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
            ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }],
            ["content_block_stop", { type: "content_block_stop", index: 0 }],
            ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 120 } }],
            ["message_stop", { type: "message_stop" }],
        ]);
    const body = (model) => ({
        model,
        max_tokens: 1_000,
        stream: true,
        system: [{ type: "text", text: "You are a coding agent.", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: [{ type: "text", text: "Fix src/sum.ts" }] }],
    });
    const messages = (surface, key, payload) =>
        handleNativeGeneration(
            new Request(`http://localhost/api/${surface === "coding" ? "code/anthropic" : "anthropic"}/v1/messages`, {
                method: "POST",
                headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "anthropic-version": "2023-06-01" },
                body: JSON.stringify(payload),
            }),
            anthropicMessagesSpec,
            { surface }
        );
    const modelIds = async (route, key) => {
        const response = await route(new Request("http://localhost/models", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } }));
        assert.equal(response.status, 200);
        return (await response.json()).data.map((entry) => entry.id);
    };

    const sessionFor = (userId) => ({ user: { id: userId, email: `${userId}@example.invalid` }, expires: new Date(Date.now() + 3_600_000).toISOString() });
    const newUser = async () => {
        const id = randomUUID();
        await db.user.create({ data: { id, email: `${id}@example.invalid`, plan: "Pro" } });
        return id;
    };
    const issueKey = async (userId) =>
        keys.createExternalApiKey(
            { userId, name: "fixture", creditCap: null, expiresAt: null },
            { session: sessionFor(userId), request: new Request("http://localhost/api/user/api-keys", { method: "POST" }) }
        );

    await db.modelCatalogEntry.create({ data: { category: "coding", modelId: MODEL_ID, enabled: true, profile } });
    // Published as the publish step would: the rows the judges admit now.
    const models = servableCodingRows(await loadCodingCatalog(db));
    assert.ok(models.some((row) => row.modelId === MODEL_ID), "the dedicated row is admitted on the coding API");
    const contentHash = catalogContentHash(models);
    const snapshot = await db.modelCatalogSnapshot.create({
        data: { category: "coding", contentHash, payload: { models }, coverageUntil: new Date(Date.now() + 86_400_000) },
    });

    t.after(async () => {
        delete process.env.CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED;
        await db.$disconnect();
        await pool.end();
    });

    await t.test("switched off, the coding API offers the general API's models and not the dedicated row", async () => {
        delete process.env.CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED;
        const userId = await newUser();
        process.env.EXTERNAL_API_ALLOWED_USER_IDS = userId;
        const { key } = await issueKey(userId);
        assert.deepEqual(await modelIds(codingModels, key), await modelIds(generalModels, key));
        assert.ok(!(await modelIds(codingModels, key)).includes(MODEL_ID));
        const before = sent.length;
        const refused = await messages("coding", key, body(MODEL_ID));
        assert.equal(refused.status, 404);
        assert.equal(sent.length, before, "nothing dispatched");
    });

    await t.test("switched on, the dedicated row runs on the coding API and is charged its own credit weight and prices", async () => {
        process.env.CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED = "true";
        const userId = await newUser();
        process.env.EXTERNAL_API_ALLOWED_USER_IDS = userId;
        const { key } = await issueKey(userId);
        assert.ok((await modelIds(codingModels, key)).includes(MODEL_ID));
        assert.ok(!(await modelIds(generalModels, key)).includes(MODEL_ID), "the general API never offers it");

        reply = () => new Response(anthropicStream(), { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_provider_1" } });
        const before = sent.length;
        const response = await messages("coding", key, body(MODEL_ID));
        assert.equal(response.status, 200);
        await response.text();
        assert.equal(sent.length, before + 1, "exactly one dispatch");
        const call = sent.at(-1);
        assert.equal(call.provider, "anthropic");
        assert.equal(call.body.model, "claude-coder-fixture", "the row's own API model id");
        assert.ok(call.body.max_tokens <= 2_000, "within the row's output limit");

        const reservations = await db.chatCreditReservation.findMany({ where: { userId } });
        assert.equal(reservations.length, 1);
        const [reservation] = reservations;
        assert.equal(reservation.source, "external_api");
        assert.equal(reservation.modelId, MODEL_ID);
        assert.equal(reservation.provider, "anthropic");
        assert.equal(reservation.reservedCredits, creditWeight, "held at the row's credit weight");
        assert.equal(reservation.status, "settled");
        assert.equal(reservation.outcome, "completed");
        assert.equal(reservation.settledCredits, creditWeight, "settled once, at the row's credit weight");
        assert.equal(reservation.settledInputTokens, 1_200);
        assert.equal(reservation.settledCacheWriteInputTokens, 300);
        assert.equal(reservation.settledOutputTokens, 120);
        // The row's prices: 900 input at 0.5, 300 written at 1.25 x 0.5, 120 output at 2 (USD per million).
        assert.equal(Number(reservation.settledCostMicroUsd), Math.ceil(900 * 0.5) + Math.ceil(300 * 0.625) + Math.ceil(120 * 2));
        // Which catalogue version priced it is on the reservation and its settlement.
        const payload = reservation.reservationPayload;
        assert.equal(payload.pricingVersion, `coding_catalog_snapshot:${snapshot.version}:${contentHash}`);
        assert.equal(payload.costSource, "coding_catalog_snapshot");
        assert.equal(reservation.pricingSnapshot.pricingVersion, `coding_catalog_snapshot:${snapshot.version}:${contentHash}`);
        assert.equal(reservation.pricingSnapshot.reservationCostSource, "coding_catalog_snapshot");
        const receipt = await db.externalApiRequest.findUnique({ where: { reservationId: reservation.id } });
        assert.equal(receipt.modelId, MODEL_ID);
        assert.equal(receipt.protocol, "anthropic_messages");
        // The provider budget holds what the request really cost, not the reservation.
        const bucket = await db.chatUsageBucket.findFirst({ where: { key: { contains: "anthropic" }, period: "provider-cost-day" } });
        assert.ok(bucket && Number(bucket.count) >= Number(reservation.settledCostMicroUsd));
    });

    await t.test("the general API refuses the dedicated row by name, with nothing sent or held", async () => {
        process.env.CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED = "true";
        const userId = await newUser();
        process.env.EXTERNAL_API_ALLOWED_USER_IDS = userId;
        const { key } = await issueKey(userId);
        const before = sent.length;
        const refused = await messages("general", key, body(MODEL_ID));
        assert.equal(refused.status, 404);
        assert.equal(sent.length, before);
        assert.equal(await db.chatCreditReservation.count({ where: { userId } }), 0);
    });

    await t.test("a row changed since publishing is not charged at the old price: it waits for the next publish", async () => {
        process.env.CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED = "true";
        await db.modelCatalogEntry.update({
            where: { category_modelId: { category: "coding", modelId: MODEL_ID } },
            data: { profile: { ...profile, pricing: { ...profile.pricing, creditWeight: creditWeight + 1 } } },
        });
        const userId = await newUser();
        process.env.EXTERNAL_API_ALLOWED_USER_IDS = userId;
        const { key } = await issueKey(userId);
        assert.ok(!(await modelIds(codingModels, key)).includes(MODEL_ID));
        const before = sent.length;
        assert.equal((await messages("coding", key, body(MODEL_ID))).status, 404);
        assert.equal(sent.length, before);
        assert.equal(await db.chatCreditReservation.count({ where: { userId } }), 0);
    });
});
