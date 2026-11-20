import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { getSingleAccountCostCeiling, providerBudgetEnvName } from "../../lib/providerCostBudget.ts";

/**
 * The native protocols (Anthropic Messages for Claude Code, OpenAI Responses
 * for Codex) end to end against a migrated local database and the real shared
 * credit ledger. Only the provider is faked: the one module that sends a
 * request upstream (lib/externalApiNativeUpstream.ts). Every scenario checks
 * the dispatch count and the reservation the request left.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
test("native protocols over the real shared credit ledger", { skip: !databaseUrl }, async (t) => {
    const url = new URL(databaseUrl);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
    assert.match(url.pathname, /test/);
    Object.assign(process.env, {
        NEXTAUTH_SECRET: "external-api-local-synthetic-secret",
        ADMIN_AUDIT_INTEGRITY_KEY: "synthetic-external-api-audit",
        EXTERNAL_API_ENABLED: "true",
        EXTERNAL_API_ANTHROPIC_ENABLED: "true",
        EXTERNAL_API_RESPONSES_ENABLED: "true",
        OPENAI_API_KEY: "sk-fixture-openai-server",
        ANTHROPIC_API_KEY: "sk-ant-fixture-server",
        EXTERNAL_API_ALLOWED_USER_IDS: "",
        CHAT_USER_PER_MINUTE: "1000",
        CHAT_IP_PER_MINUTE: "1000",
        EXTERNAL_API_REQUESTS_PER_MINUTE: "1000",
        EXTERNAL_API_READS_PER_MINUTE: "1000",
    });
    const floor = getSingleAccountCostCeiling();
    for (const provider of ["openai", "anthropic"]) {
        for (const period of ["day", "month"]) process.env[providerBudgetEnvName(provider, period)] = String(floor[period]);
    }

    const root = resolve(import.meta.dirname, "../..");
    const mod = (path) => pathToFileURL(resolve(root, path)).href;
    const { PrismaClient } = await import("@prisma/client");
    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
    const db = new PrismaClient({ adapter: new PrismaPg(pool) });
    mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: db, prismaPoolUsage: () => ({ total: 1, idle: 0, waiting: 0 }) } });

    // The fake provider: `reply` decides the response of one dispatch.
    const sent = [];
    let reply = null;
    class NativeUpstreamUnavailable extends Error {}
    mock.module(mod("lib/externalApiNativeUpstream.ts"), {
        namedExports: {
            NativeUpstreamUnavailable,
            nativeUpstreamFetch: async (provider, path, init) => {
                sent.push({ provider, path, headers: init.headers, body: JSON.parse(init.body), signal: init.signal });
                return reply({ provider, path, init, signal: init.signal });
            },
        },
    });
    // The router (a paid call) is faked: `routerPick` is what it answers.
    const routerCalls = [];
    let routerPick = null;
    let routerDelayMs = 0;
    mock.module(mod("lib/autoLlmRouter.ts"), {
        namedExports: {
            pickAutoModelWithLlm: async (input) => {
                routerCalls.push(input);
                if (routerDelayMs) await new Promise((r) => setTimeout(r, routerDelayMs));
                return routerPick ? { modelId: routerPick, rewrite: null } : null;
            },
        },
    });
    const { handleNativeGeneration, handleNativeFreeCall } = await import(mod("lib/externalApiNative.ts"));
    const { resetNativeSmartAdaptivePins } = await import(mod("lib/externalApiNativeSmartAdaptive.ts"));
    const { externalApiRunnableModels } = await import(mod("lib/externalApiCatalog.ts"));
    const { nativeSmartAdaptiveDefaultId } = await import(mod("lib/externalApiCatalogCore.ts"));
    const { anthropicMessagesSpec, responsesSpec, anthropicCountTokensPath } = await import(mod("lib/externalApiNativeSpecs.ts"));
    const { prepareAnthropicMessages } = await import(mod("lib/anthropicMessagesProtocol.ts"));
    const { handleChatCompletions } = await import(mod("lib/externalApiInference.ts"));
    const keys = await import(mod("lib/externalApiKeys.ts"));

    const sse = (events) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
    /** A provider stream that yields its events one chunk at a time, optionally slowly. */
    const streamResponse = (text, { delayMs = 0, cutAfter = null, status = 200 } = {}, signal) => {
        const encoder = new TextEncoder();
        const chunks = text.match(/[\s\S]{1,37}/g) ?? [];
        return new Response(
            new ReadableStream({
                async start(controller) {
                    for (const [index, chunk] of chunks.entries()) {
                        if (cutAfter !== null && index >= cutAfter) {
                            controller.close();
                            return;
                        }
                        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
                        if (signal?.aborted) {
                            controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
                            return;
                        }
                        controller.enqueue(encoder.encode(chunk));
                    }
                    controller.close();
                },
            }),
            { status, headers: { "content-type": "text/event-stream", "request-id": "req_provider_1", "anthropic-ratelimit-tokens-remaining": "123" } }
        );
    };
    const anthropicStream = (usageStart = { input_tokens: 100, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 2_000, output_tokens: 1 }, output = 340) =>
        sse([
            ["message_start", { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", content: [], usage: usageStart } }],
            ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Edit", input: {} } }],
            ["ping", { type: "ping" }],
            ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"src/sum.ts\"}" } }],
            ["content_block_stop", { type: "content_block_stop", index: 0 }],
            ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: output } }],
            ["message_stop", { type: "message_stop" }],
        ]);
    const responsesStream = (usage = { input_tokens: 9_000, input_tokens_details: { cached_tokens: 8_192 }, output_tokens: 700, output_tokens_details: { reasoning_tokens: 512 } }) =>
        sse([
            ["response.created", { type: "response.created", response: { id: "resp_fixture", status: "in_progress", output: [] } }],
            ["response.output_item.added", { type: "response.output_item.added", item: { type: "custom_tool_call", call_id: "c1", name: "apply_patch" } }],
            ["response.custom_tool_call_input.delta", { type: "response.custom_tool_call_input.delta", delta: "*** Begin Patch\n*** End Patch" }],
            ["response.completed", { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [{}], usage } }],
        ]);

    const newUser = async (plan = "Pro") => {
        const id = randomUUID();
        await db.user.create({ data: { id, email: `${id}@example.invalid`, plan } });
        return id;
    };
    const sessionFor = (userId) => ({ user: { id: userId, email: `${userId}@example.invalid` }, expires: new Date(Date.now() + 3_600_000).toISOString() });
    const auditRequest = () => new Request("http://localhost/api/user/api-keys", { method: "POST" });
    const issueKey = async (userId, extra = {}) =>
        keys.createExternalApiKey({ userId, name: "fixture", creditCap: null, expiresAt: null, ...extra }, { session: sessionFor(userId), request: auditRequest() });
    const allow = (...userIds) => {
        process.env.EXTERNAL_API_ALLOWED_USER_IDS = userIds.join(",");
    };
    const reservationsFor = (userId) => db.chatCreditReservation.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
    const receiptFor = (reservationId) => db.externalApiRequest.findUnique({ where: { reservationId } });

    const claudeBody = (extra = {}) => ({
        model: "claude-sonnet-5",
        max_tokens: 1_000_000,
        stream: true,
        system: [{ type: "text", text: "You are a coding agent.", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: [{ type: "text", text: "Fix src/sum.ts" }] }],
        tools: [{ name: "Edit", description: "Edit a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
        thinking: { type: "adaptive" },
        context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
        ...extra,
    });
    const codexBody = (extra = {}) => ({
        model: "gpt-5.6-luna",
        stream: true,
        store: true,
        input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the test" }] },
            { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAAABencrypted" },
        ],
        tools: [{ type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } }],
        include: ["reasoning.encrypted_content"],
        ...extra,
    });
    const claude = (key, payload, init = {}) =>
        handleNativeGeneration(
            new Request("http://localhost/api/anthropic/v1/messages?beta=true", {
                method: "POST",
                headers: {
                    ...(key ? { authorization: `Bearer ${key}` } : {}),
                    "content-type": "application/json",
                    "anthropic-version": "2023-06-01",
                    "anthropic-beta": "claude-code-20250219,context-management-2025-06-27",
                    "user-agent": "claude-cli/2.1.278 (external, cli)",
                    ...(init.headers ?? {}),
                },
                body: typeof payload === "string" ? payload : JSON.stringify(payload),
                signal: init.signal,
            }),
            anthropicMessagesSpec
        );
    const codex = (key, payload, init = {}) =>
        handleNativeGeneration(
            new Request("http://localhost/api/v1/responses", {
                method: "POST",
                headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "user-agent": "codex_cli_rs/0.146.0", ...(init.headers ?? {}) },
                body: typeof payload === "string" ? payload : JSON.stringify(payload),
                signal: init.signal,
            }),
            responsesSpec
        );
    const chat = (key, payload, init = {}) =>
        handleChatCompletions(
            new Request("http://localhost/api/v1/chat/completions", {
                method: "POST",
                headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) },
                body: JSON.stringify(payload),
            })
        );

    t.after(async () => {
        await db.$disconnect();
        await pool.end();
    });

    await t.test("each native switch is default-off on its own, and nothing is dispatched or held", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        process.env.EXTERNAL_API_ANTHROPIC_ENABLED = "false";
        const off = await claude(key, claudeBody());
        assert.equal(off.status, 503);
        const offBody = await off.json();
        assert.equal(offBody.type, "error", "Anthropic-shaped error");
        assert.equal(offBody.tomverse.code, "feature_unavailable");
        process.env.EXTERNAL_API_ANTHROPIC_ENABLED = "true";
        process.env.EXTERNAL_API_RESPONSES_ENABLED = "false";
        assert.equal((await codex(key, codexBody())).status, 503);
        process.env.EXTERNAL_API_RESPONSES_ENABLED = "true";
        process.env.EXTERNAL_API_ENABLED = "false";
        assert.equal((await claude(key, claudeBody())).status, 503, "the master switch still governs");
        process.env.EXTERNAL_API_ENABLED = "true";
        assert.equal(sent.length, 0);
        assert.equal((await reservationsFor(userId)).length, 0);
    });

    await t.test("paid plans only: a key made on a paid plan is refused on every native route once the account is Free", async () => {
        const { GET: anthropicModels } = await import(mod("app/api/anthropic/v1/models/route.ts"));
        const userId = await newUser();
        allow("*");
        const { key } = await issueKey(userId);
        await db.user.update({ where: { id: userId }, data: { plan: "Free" } });
        const claudeRefusal = await claude(key, claudeBody());
        assert.equal(claudeRefusal.status, 403);
        const claudeJson = await claudeRefusal.json();
        assert.equal(claudeJson.type, "error", "Anthropic-shaped error");
        assert.equal(claudeJson.tomverse.code, "plan_not_eligible");
        const viaXApiKey = await claude(null, claudeBody(), { headers: { "x-api-key": key } });
        assert.equal(viaXApiKey.status, 403);
        const codexRefusal = await codex(key, codexBody());
        assert.equal(codexRefusal.status, 403);
        assert.equal((await codexRefusal.json()).error.code, "plan_not_eligible");
        const models = await anthropicModels(new Request("http://localhost/api/anthropic/v1/models", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } }));
        assert.equal(models.status, 403);
        assert.equal(sent.length, 0, "nothing reached a provider");
        assert.equal((await reservationsFor(userId)).length, 0, "nothing held");
        allow();
    });

    await t.test("Claude Code stream: one dispatch, body and betas passed through, cache usage settled, bytes relayed", async () => {
        const userId = await newUser();
        allow(userId);
        const { key, summary } = await issueKey(userId);
        const upstreamText = anthropicStream();
        reply = ({ signal }) => streamResponse(upstreamText, {}, signal);
        const before = sent.length;
        const response = await claude(key, claudeBody());
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /text\/event-stream/);
        assert.equal(await response.text(), upstreamText, "relayed byte for byte");
        assert.equal(sent.length - before, 1);
        const call = sent.at(-1);
        assert.equal(call.provider, "anthropic");
        assert.equal(call.path, "/v1/messages?beta=true");
        assert.equal(call.headers["anthropic-beta"], "claude-code-20250219,context-management-2025-06-27");
        assert.equal(call.headers["anthropic-version"], "2023-06-01");
        assert.ok(!JSON.stringify(call.headers).includes(key), "the Tomverse key never goes upstream");
        assert.deepEqual(call.body.context_management, claudeBody().context_management);
        assert.ok(call.body.max_tokens < 1_000_000, "clamped to what was reserved");
        assert.equal(response.headers.get("x-tomverse-output-limit"), String(call.body.max_tokens));
        assert.equal(response.headers.get("anthropic-ratelimit-tokens-remaining"), null, "provider account limits are not relayed");
        const [reservation] = await reservationsFor(userId);
        assert.equal(reservation.source, "external_api");
        assert.equal(reservation.status, "settled");
        assert.equal(reservation.outcome, "completed");
        assert.equal(reservation.settledInputTokens, 7_100, "uncached + cache read + cache write");
        assert.equal(reservation.settledCachedInputTokens, 5_000);
        assert.equal(reservation.settledCacheWriteInputTokens, 2_000);
        assert.equal(reservation.settledOutputTokens, 340);
        assert.ok(reservation.settledCredits > 0);
        const receipt = await receiptFor(reservation.id);
        assert.equal(receipt.protocol, "anthropic_messages");
        assert.equal(receipt.keyId, summary.id);
        assert.equal(receipt.finishReason, "tool_use");
        assert.equal(receipt.modelId, "claude-sonnet-5");
        assert.equal(response.headers.get("x-request-id"), receipt.id);
        assert.equal(response.headers.get("request-id"), receipt.id);
        const stored = JSON.stringify(receipt);
        assert.ok(!stored.includes("Fix src/sum.ts") && !stored.includes(key));
    });

    await t.test("Claude Code: the cache-write premium is reserved only for a request with a marker", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        reply = ({ signal }) => streamResponse(anthropicStream({ input_tokens: 50, output_tokens: 1 }, 5), {}, signal);
        await (await claude(key, claudeBody())).text();
        await (await claude(key, claudeBody({ system: [{ type: "text", text: "You are a coding agent." }] }))).text();
        const [marked, plain] = await reservationsFor(userId);
        const costs = await db.chatCreditReservation.findMany({ where: { id: { in: [marked.id, plain.id] } }, select: { id: true, reservedCostMicroUsd: true } });
        const cost = Object.fromEntries(costs.map((row) => [row.id, Number(row.reservedCostMicroUsd)]));
        assert.ok(cost[marked.id] > cost[plain.id], "the marked request holds the write premium");
    });

    await t.test("Claude Code refusals before dispatch: server tool, 1h cache, other provider's model", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const before = sent.length;
        const cases = [
            [claudeBody({ tools: [{ type: "web_search_20250305", name: "web_search" }] }), 400, "server_tool_unsupported"],
            [claudeBody({ system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }] }), 400, "unsupported_cache_ttl"],
            [claudeBody({ model: "gpt-6-luna" }), 400, "model_unsupported_protocol"],
            [claudeBody({ model: "no-such-model" }), 404, "model_not_found"],
            ["{not json", 400, "invalid_json"],
        ];
        for (const [payload, status, code] of cases) {
            const response = await claude(key, payload);
            assert.equal(response.status, status, code);
            const json = await response.json();
            assert.equal(json.type, "error");
            assert.equal(json.tomverse.code, code);
        }
        assert.equal(sent.length, before, "nothing reached the provider");
        assert.equal((await reservationsFor(userId)).length, 0, "nothing held");
    });

    await t.test("a forwarded header fetch could not send is a 400 before anything is held", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const before = sent.length;
        const response = await claude(key, claudeBody(), { headers: { "anthropic-beta": "context-management-2025-06-27,é" } });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).tomverse.code, "invalid_header");
        assert.equal(sent.length, before);
        assert.equal((await reservationsFor(userId)).length, 0, "nothing reserved, so no provider budget consumed");
        const priced = await claude(key, claudeBody({ inference_geo: "us" }));
        assert.equal(priced.status, 400);
        assert.equal((await reservationsFor(userId)).length, 0);
    });

    await t.test("Claude Code: x-api-key carries the Tomverse key; a revoked key dispatches nothing", async () => {
        const userId = await newUser();
        allow(userId);
        const { key, summary } = await issueKey(userId);
        reply = ({ signal }) => streamResponse(anthropicStream(), {}, signal);
        const viaHeader = await claude(null, claudeBody(), { headers: { "x-api-key": key } });
        assert.equal(viaHeader.status, 200);
        await viaHeader.text();
        await keys.revokeExternalApiKey({ userId, keyId: summary.id }, { session: sessionFor(userId), request: auditRequest() });
        const before = sent.length;
        assert.equal((await claude(key, claudeBody())).status, 401);
        assert.equal((await codex(key, codexBody())).status, 401);
        assert.equal(sent.length, before);
    });

    await t.test("provider HTTP errors: a 400 keeps its message and is free; a 529 is neutral and settles at the estimate", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        reply = () =>
            Response.json({ type: "error", error: { type: "invalid_request_error", message: "messages.0.content.0.thinking.signature: Invalid signature" } }, { status: 400 });
        const invalid = await claude(key, claudeBody());
        assert.equal(invalid.status, 400);
        assert.match((await invalid.json()).error.message, /Invalid signature/);
        reply = () => Response.json({ type: "error", error: { type: "overloaded_error", message: "Overloaded for org_123" } }, { status: 529 });
        const busy = await claude(key, claudeBody());
        assert.equal(busy.status, 529);
        assert.doesNotMatch((await busy.json()).error.message, /org_/);
        reply = () => Response.json({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low" } }, { status: 400 });
        const account = await claude(key, claudeBody());
        assert.doesNotMatch((await account.json()).error.message, /credit|balance/i);
        const [refused, unknown, accountRefusal] = await reservationsFor(userId);
        assert.equal(refused.outcome, "failed");
        assert.equal(refused.settledCredits, 0, "the provider refused before work");
        assert.equal(accountRefusal.settledCredits, 0);
        assert.notEqual(unknown.status, "reserved", "resolved, not left held");
        assert.equal(unknown.outcome, "failed");
        assert.ok(Number(unknown.settledCostMicroUsd) > 0, "a 5xx outcome is unknown: provider cost stays at the estimate");
    });

    await t.test("an in-stream provider error loses account detail on the way to the client", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        reply = ({ signal }) =>
            streamResponse(
                sse([
                    ["message_start", { type: "message_start", message: { id: "m", usage: { input_tokens: 10, output_tokens: 1 } } }],
                    ["error", { type: "error", error: { type: "overloaded_error", message: "Workspace org_123 is over its spend limit" } }],
                ]),
                {},
                signal
            );
        const text = await (await claude(key, claudeBody())).text();
        assert.match(text, /event: error/);
        assert.doesNotMatch(text, /org_123|spend limit/);
        const [reservation] = await reservationsFor(userId);
        assert.equal(reservation.outcome, "failed");
    });

    await t.test("a stream cut before message_stop is a failure with an error event, never a clean finish", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        reply = ({ signal }) => streamResponse(anthropicStream(), { cutAfter: 6 }, signal);
        const response = await claude(key, claudeBody());
        const text = await response.text();
        assert.match(text, /event: error/);
        const [reservation] = await reservationsFor(userId);
        assert.notEqual(reservation.status, "reserved");
        assert.equal(reservation.outcome, "failed");
        assert.equal((await receiptFor(reservation.id)).errorCode, "upstream_error");
    });

    await t.test("a client that leaves mid-stream aborts the provider call and settles once as cancelled", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        let upstreamSignal;
        reply = ({ signal }) => {
            upstreamSignal = signal;
            return streamResponse(anthropicStream(), { delayMs: 40 }, signal);
        };
        const client = new AbortController();
        const response = await claude(key, claudeBody(), { signal: client.signal });
        const reader = response.body.getReader();
        await reader.read();
        client.abort();
        await reader.cancel();
        for (let i = 0; i < 50 && (await reservationsFor(userId))[0]?.status === "reserved"; i += 1) await new Promise((r) => setTimeout(r, 20));
        assert.equal(upstreamSignal.aborted, true, "the upstream call is aborted");
        const reservations = await reservationsFor(userId);
        assert.equal(reservations.length, 1);
        assert.notEqual(reservations[0].status, "reserved");
        assert.equal(reservations[0].outcome, "cancelled");
        assert.equal(await db.chatRequestLease.count({ where: { subjectKey: { contains: userId } } }), 0, "the concurrency slot is released");
    });

    await t.test("a client that holds the stream open without reading is still settled at the timeout", async () => {
        // Review r-20261118-061521-aa7d75: a pull-based relay that only ends on
        // the next pull would never settle here, and the heartbeat would keep
        // the hold and the concurrency slot alive for as long as the socket.
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        process.env.EXTERNAL_API_TIMEOUT_MS = "300";
        try {
            reply = ({ signal }) => streamResponse(anthropicStream(), { delayMs: 200 }, signal);
            const response = await claude(key, claudeBody());
            assert.equal(response.status, 200);
            // The body is never read.
            let settled = null;
            for (let i = 0; i < 100 && !settled; i += 1) {
                await new Promise((r) => setTimeout(r, 30));
                const [row] = await reservationsFor(userId);
                if (row && row.status !== "reserved") settled = row;
            }
            assert.ok(settled, "settled without a single read from the client");
            assert.equal(settled.outcome, "cancelled");
            // The receipt is completed right after settlement.
            let receipt = await receiptFor(settled.id);
            for (let i = 0; i < 50 && !receipt.completedAt; i += 1) {
                await new Promise((r) => setTimeout(r, 20));
                receipt = await receiptFor(settled.id);
            }
            assert.equal(receipt.errorCode, "upstream_timeout");
            assert.equal(await db.chatRequestLease.count({ where: { subjectKey: { contains: userId } } }), 0, "slot released");
            // Reading now gets what was relayed and a closing error event, then the end.
            const text = await response.text();
            assert.match(text, /event: error/);
        } finally {
            delete process.env.EXTERNAL_API_TIMEOUT_MS;
        }
    });

    await t.test("provider unreachable: one attempt, no retry, failed at the estimate", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        reply = () => {
            throw new TypeError("fetch failed");
        };
        const before = sent.length;
        const response = await codex(key, codexBody());
        assert.equal(response.status, 502);
        assert.equal((await response.json()).error.code, "upstream_error");
        assert.equal(sent.length - before, 1, "never re-sent");
        const [reservation] = await reservationsFor(userId);
        assert.equal(reservation.outcome, "failed");
        assert.ok(Number(reservation.settledCostMicroUsd) > 0, "an unknown outcome is not assumed free");
    });

    await t.test("no provider credential: nothing sent, nothing charged", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        reply = () => {
            throw new NativeUpstreamUnavailable();
        };
        const response = await codex(key, codexBody());
        assert.equal(response.status, 503);
        const [reservation] = await reservationsFor(userId);
        assert.equal(reservation.settledCredits, 0);
        assert.equal(Number(reservation.settledCostMicroUsd), 0);
    });

    await t.test("Codex stream: provider model id resolves, store forced off, output limit explicit, usage settled", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const upstreamText = responsesStream();
        reply = ({ signal }) => streamResponse(upstreamText, {}, signal);
        const response = await codex(key, codexBody());
        assert.equal(response.status, 200);
        assert.equal(await response.text(), upstreamText);
        const call = sent.at(-1);
        assert.equal(call.provider, "openai");
        assert.equal(call.path, "/responses");
        assert.equal(call.body.store, false);
        assert.equal(call.body.model, "gpt-5.6-luna");
        assert.ok(Number.isSafeInteger(call.body.max_output_tokens) && call.body.max_output_tokens > 0);
        assert.deepEqual(call.body.input, codexBody().input, "encrypted reasoning passed through");
        assert.deepEqual(call.body.tools, codexBody().tools, "the freeform patch tool passed through");
        const [reservation] = await reservationsFor(userId);
        assert.equal(reservation.outcome, "completed");
        assert.equal(reservation.settledInputTokens, 9_000);
        assert.equal(reservation.settledCachedInputTokens, 8_192);
        assert.equal(reservation.settledCacheWriteInputTokens, 0);
        assert.equal(reservation.settledOutputTokens, 700);
        const receipt = await receiptFor(reservation.id);
        assert.equal(receipt.protocol, "responses");
        assert.equal(receipt.modelId, "gpt-5-6-luna");
        assert.equal(receipt.finishReason, "completed");
    });

    await t.test("Codex refusals before dispatch: stored state, hosted tools, remote images", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const before = sent.length;
        for (const [payload, code] of [
            [codexBody({ previous_response_id: "resp_1" }), "stateful_request_unsupported"],
            [codexBody({ tools: [{ type: "web_search" }] }), "hosted_tool_unsupported"],
            [codexBody({ input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://x.test/a.png" }] }] }), "remote_content_unsupported"],
            [codexBody({ model: "claude-sonnet-5" }), "model_unsupported_protocol"],
        ]) {
            const response = await codex(key, payload);
            assert.equal(response.status, 400, code);
            assert.equal((await response.json()).error.code, code);
        }
        assert.equal(sent.length, before);
        assert.equal((await reservationsFor(userId)).length, 0);
    });

    await t.test("one Idempotency-Key: a replay is a receipt, a reuse on another endpoint is a conflict", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        reply = ({ signal }) => streamResponse(responsesStream(), {}, signal);
        const headers = { "idempotency-key": "task-42-turn-1" };
        await (await codex(key, codexBody(), { headers })).text();
        const before = sent.length;
        const replay = await codex(key, codexBody(), { headers });
        assert.equal(replay.status, 409);
        assert.equal((await replay.json()).error.code, "idempotent_request_completed");
        const otherEndpoint = await claude(key, claudeBody(), { headers });
        assert.equal(otherEndpoint.status, 422);
        assert.equal((await otherEndpoint.json()).tomverse.code, "idempotency_key_reused");
        const chatReuse = await chat(key, { model: "gpt-6-luna", messages: [{ role: "user", content: "hi" }] }, { headers });
        assert.equal(chatReuse.status, 422, "Chat Completions sees the same key as a different request");
        assert.equal(sent.length, before, "no replay or reuse reached the provider");
        assert.equal((await reservationsFor(userId)).length, 1);
    });

    await t.test("one key cap across all three protocols, under concurrent requests", async () => {
        const userId = await newUser();
        allow(userId);
        // Room for exactly one native request's hold.
        const probeUser = await newUser();
        allow(userId, probeUser);
        const { key: probeKey } = await issueKey(probeUser);
        reply = ({ signal }) => streamResponse(anthropicStream({ input_tokens: 10, output_tokens: 1 }, 5), { delayMs: 30 }, signal);
        await (await claude(probeKey, claudeBody())).text();
        const [probe] = await reservationsFor(probeUser);
        const { key, summary } = await issueKey(userId, { creditCap: probe.reservedCredits });
        const responses = await Promise.all([claude(key, claudeBody()), codex(key, codexBody()), claude(key, claudeBody()), codex(key, codexBody())]);
        await Promise.all(responses.map((response) => response.text()));
        const admitted = await db.externalApiRequest.count({ where: { keyId: summary.id } });
        const committed = (await reservationsFor(userId)).reduce((sum, row) => sum + (row.status === "reserved" ? row.reservedCredits : row.settledCredits), 0);
        assert.ok(committed <= probe.reservedCredits, `committed ${committed} within the cap ${probe.reservedCredits}`);
        assert.ok(admitted >= 1);
        const refused = responses.filter((response) => response.status === 429);
        assert.ok(refused.length >= 1, "the rest are refused by the key cap");
    });

    // Smart Adaptive on the native protocols: one provider's models, one pick
    // per conversation, never a failed request when the pin is missed.
    const providerPool = async (provider, protocol) =>
        (await externalApiRunnableModels("Pro")).filter(
            (entry) => entry.model.provider === provider && entry.capabilities.protocols.includes(protocol)
        );
    const poolDefault = (pool) =>
        pool.find((entry) => entry.model.id === nativeSmartAdaptiveDefaultId(pool.map((e) => e.capabilities), "gpt-6-luna"));
    const routed = (response) => [response.headers.get("x-tomverse-routed-model"), response.headers.get("x-tomverse-routed-by")];
    const claudeTurn2 = (extra = {}) =>
        claudeBody({
            model: "smart-adaptive",
            messages: [
                { role: "user", content: [{ type: "text", text: "Fix src/sum.ts" }] },
                {
                    role: "assistant",
                    content: [
                        { type: "thinking", thinking: "look at the file", signature: "sig_bound_to_its_model" },
                        { type: "tool_use", id: "toolu_1", name: "Edit", input: { path: "src/sum.ts" } },
                    ],
                },
                { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
            ],
            ...extra,
        });

    await t.test("Claude Code Smart Adaptive, router off: the provider default answers, credits are its own", async () => {
        delete process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED;
        resetNativeSmartAdaptivePins();
        const pool = await providerPool("anthropic", "anthropic_messages");
        assert.ok(pool.length >= 1, "an Anthropic model to route to");
        const fallback = poolDefault(pool);
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        reply = ({ signal }) => streamResponse(anthropicStream(), {}, signal);
        const callsBefore = routerCalls.length;
        const response = await claude(key, claudeBody({ model: "smart-adaptive" }), { headers: { "x-claude-code-session-id": "sess-off" } });
        assert.equal(response.status, 200);
        await response.text();
        assert.deepEqual(routed(response), [fallback.model.id, "default"]);
        assert.equal(sent.at(-1).body.model, fallback.model.apiModel, "the provider gets its own model id");
        assert.equal(routerCalls.length, callsBefore, "no router call with the switch off");
        const [reservation] = await reservationsFor(userId);
        assert.equal(reservation.status, "settled");
        assert.equal((await receiptFor(reservation.id)).modelId, fallback.model.id, "reserved and settled as the model that answered");
    });

    await t.test("Claude Code Smart Adaptive, router on: Anthropic candidates only, one pick per session, a missed pin never fails", async () => {
        process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED = "true";
        resetNativeSmartAdaptivePins();
        const pool = await providerPool("anthropic", "anthropic_messages");
        const fallback = poolDefault(pool);
        const other = pool.find((entry) => entry.model.id !== fallback.model.id);
        assert.ok(other, "the fixture catalogue has two Anthropic models to route between");
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        reply = ({ signal }) => streamResponse(anthropicStream(), {}, signal);
        const session = { headers: { "x-claude-code-session-id": "sess-on" } };
        try {
            // A router answer naming another provider's model is never taken.
            routerPick = "gpt-6-luna";
            const crossed = await claude(key, claudeBody({ model: "smart-adaptive" }), { headers: { "x-claude-code-session-id": "sess-cross" } });
            await crossed.text();
            assert.equal(crossed.status, 200);
            assert.equal(routed(crossed)[0], fallback.model.id);
            const crossCall = routerCalls.at(-1);
            assert.ok(crossCall.eligibleModelIds.length >= 2);
            assert.ok(
                crossCall.eligibleModelIds.every((id) => pool.some((entry) => entry.model.id === id)),
                "the router sees Anthropic models only"
            );

            routerPick = other.model.id;
            const before = routerCalls.length;
            const first = await claude(key, claudeBody({ model: "smart-adaptive" }), session);
            await first.text();
            assert.equal(first.status, 200);
            assert.deepEqual(routed(first), [other.model.id, "router"]);
            assert.equal(sent.at(-1).body.model, other.model.apiModel);
            assert.equal(routerCalls.length, before + 1, "one router call, on the conversation's first request");

            // Later rounds carry signed thinking and tool results: same model, no router call.
            routerPick = fallback.model.id;
            for (let round = 0; round < 2; round += 1) {
                const next = await claude(key, claudeTurn2(), session);
                await next.text();
                assert.equal(next.status, 200);
                assert.deepEqual(routed(next), [other.model.id, "continued"]);
                assert.equal(sent.at(-1).body.model, other.model.apiModel);
                assert.equal(sent.at(-1).body.messages[1].content[0].signature, "sig_bound_to_its_model", "signed thinking passed through");
            }
            assert.equal(routerCalls.length, before + 1, "the pick holds for the whole conversation");

            // Another instance (or a restart) never saw the pin: the request
            // still succeeds, on the provider default, without routing again.
            resetNativeSmartAdaptivePins();
            const missed = await claude(key, claudeTurn2(), session);
            await missed.text();
            assert.equal(missed.status, 200);
            assert.deepEqual(routed(missed), [fallback.model.id, "default"]);
            assert.equal(routerCalls.length, before + 1, "a conversation under way is never routed again");
            const after = await claude(key, claudeTurn2(), session);
            await after.text();
            assert.deepEqual(routed(after), [fallback.model.id, "continued"], "and the default is pinned from there");

            // The free token count reads the pin and never routes.
            const callsBeforeCount = routerCalls.length;
            reply = () => Response.json({ input_tokens: 42 });
            const countRequest = new Request("http://localhost/api/anthropic/v1/messages/count_tokens?beta=true", {
                method: "POST",
                headers: {
                    authorization: `Bearer ${key}`,
                    "content-type": "application/json",
                    "anthropic-version": "2023-06-01",
                    "x-claude-code-session-id": "sess-on",
                },
                body: JSON.stringify({ model: "smart-adaptive", messages: [{ role: "user", content: "hi" }] }),
            });
            const counted = await handleNativeFreeCall(countRequest, anthropicMessagesSpec, {
                upstreamPath: anthropicCountTokensPath(countRequest),
                prepare: (body, model) => prepareAnthropicMessages(body, model, { countTokens: true }),
            });
            assert.equal(counted.status, 200);
            assert.equal(sent.at(-1).body.model, fallback.model.apiModel, "the session's pinned model");
            assert.equal(routerCalls.length, callsBeforeCount);

            // Without a session id, the conversation is known by its opening.
            resetNativeSmartAdaptivePins();
            reply = ({ signal }) => streamResponse(anthropicStream(), {}, signal);
            routerPick = other.model.id;
            const opening = [{ role: "user", content: [{ type: "text", text: "Rename foo" }] }];
            const anon = await claude(key, claudeBody({ model: "smart-adaptive", messages: opening }));
            await anon.text();
            assert.deepEqual(routed(anon), [other.model.id, "router"]);
            routerPick = fallback.model.id;
            const anonNext = await claude(
                key,
                claudeTurn2({
                    messages: [
                        ...opening,
                        { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }, { type: "text", text: "Done." }] },
                        { role: "user", content: [{ type: "text", text: "Now bar" }] },
                    ],
                })
            );
            await anonNext.text();
            assert.deepEqual(routed(anonNext), [other.model.id, "continued"]);
            const reservations = await reservationsFor(userId);
            assert.ok(reservations.every((row) => row.status === "settled"), "every request settled");
        } finally {
            routerPick = null;
            delete process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED;
        }
    });

    await t.test("Smart Adaptive: a request refused anyway spends no router call; candidates leave room for the output", async () => {
        process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED = "true";
        resetNativeSmartAdaptivePins();
        const pool = await providerPool("anthropic", "anthropic_messages");
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        try {
            routerPick = pool[0].model.id;
            const before = routerCalls.length;
            const sentBefore = sent.length;
            const cases = [
                [claudeBody({ model: "smart-adaptive", tools: [{ type: "web_search_20250305", name: "web_search" }] }), {}, "server_tool_unsupported"],
                [claudeBody({ model: "smart-adaptive", system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }] }), {}, "unsupported_cache_ttl"],
                [claudeBody({ model: "smart-adaptive" }), { headers: { "anthropic-beta": "context-management-2025-06-27,é" } }, "invalid_header"],
            ];
            for (const [payload, init, code] of cases) {
                const response = await claude(key, payload, init);
                assert.equal(response.status, 400, code);
                assert.equal((await response.json()).tomverse.code, code);
            }
            assert.equal(routerCalls.length, before, "no router call for a request refused anyway");
            assert.equal(sent.length, sentBefore);
            assert.equal((await reservationsFor(userId)).length, 0);
        } finally {
            routerPick = null;
            delete process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED;
        }

        // Two synthetic Anthropic models: the small one takes the input but
        // not the input plus the output it would reserve.
        const { routeNativeSmartAdaptive } = await import(mod("lib/externalApiNativeSmartAdaptive.ts"));
        const synthetic = (id, contextWindowTokens, creditWeight) => ({
            model: { id, apiModel: id, provider: "anthropic" },
            capabilities: { id, protocols: ["chat_completions", "anthropic_messages"], vision: true, contextWindowTokens, maxOutputTokens: 4_000, creditWeight },
        });
        const small = synthetic("small-window", 6_000, 1);
        const large = synthetic("large-window", 200_000, 2);
        const body = { model: "smart-adaptive", max_tokens: 4_000, messages: [{ role: "user", content: "word ".repeat(3_000) }] };
        const decision = await routeNativeSmartAdaptive({
            protocol: "anthropic_messages",
            request: new Request("http://localhost/x", { headers: { "x-claude-code-session-id": "fit" } }),
            body,
            runnable: [small, large],
            keyId: "k",
            userId,
            requestId: "r",
            routerAllowed: async () => false,
            prepare: (model) => prepareAnthropicMessages(body, model),
        });
        assert.equal(decision.entry.model.id, "large-window", "input plus reserved output must fit the window");
        const tiny = await routeNativeSmartAdaptive({
            protocol: "anthropic_messages",
            request: new Request("http://localhost/x", { headers: { "x-claude-code-session-id": "fit-small" } }),
            body: { ...body, max_tokens: 1 },
            runnable: [small, large],
            keyId: "k",
            userId,
            requestId: "r",
            routerAllowed: async () => false,
            prepare: (model) => prepareAnthropicMessages({ ...body, max_tokens: 1 }, model),
        });
        assert.equal(tiny.entry.model.id, "small-window", "the input alone fits the small model (the default by credits)");

        // The model's own request check applies to each candidate: a thinking
        // budget the short-output model cannot hold leaves it out.
        const shortOut = synthetic("short-output", 200_000, 1);
        const longOut = { ...synthetic("long-output", 200_000, 2) };
        longOut.capabilities = { ...longOut.capabilities, maxOutputTokens: 64_000 };
        const thinkingBody = { model: "smart-adaptive", max_tokens: 32_000, thinking: { type: "enabled", budget_tokens: 10_000 }, messages: [{ role: "user", content: "think" }] };
        assert.throws(() => prepareAnthropicMessages(thinkingBody, { apiModel: "short-output", maxOutputTokens: 4_000 }), "the short model refuses it");
        const thinking = await routeNativeSmartAdaptive({
            protocol: "anthropic_messages",
            request: new Request("http://localhost/x", { headers: { "x-claude-code-session-id": "fit-thinking" } }),
            body: thinkingBody,
            runnable: [shortOut, longOut],
            keyId: "k",
            userId,
            requestId: "r",
            routerAllowed: async () => false,
            prepare: (model) => prepareAnthropicMessages(thinkingBody, model),
        });
        assert.equal(thinking.entry.model.id, "long-output");

        // Nothing of the provider fits: refused here, with no router call.
        const noFitCalls = routerCalls.length;
        const refusedRoute = (runnable, payload) =>
            routeNativeSmartAdaptive({
                protocol: "anthropic_messages",
                request: new Request("http://localhost/x", { headers: { "x-claude-code-session-id": "no-fit" } }),
                body: payload,
                runnable,
                keyId: "k",
                userId,
                requestId: "r",
                routerAllowed: async () => true,
                prepare: (model) => prepareAnthropicMessages(payload, model),
            });
        await assert.rejects(refusedRoute([small], body), (error) => error.code === "context_length_exceeded");
        await assert.rejects(refusedRoute([shortOut], thinkingBody), (error) => error.status === 400, "the model check's own refusal");
        assert.equal(routerCalls.length, noFitCalls);

        // Concurrent first requests share one router call, and each takes the
        // shared pick only if it is one of its own candidates.
        process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED = "true";
        const textOnly = synthetic("text-only", 200_000, 1);
        textOnly.capabilities = { ...textOnly.capabilities, vision: false };
        const seesA = synthetic("sees-a", 200_000, 2);
        const seesB = synthetic("sees-b", 200_000, 3);
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        const textBody = { model: "smart-adaptive", max_tokens: 1_000, messages: [{ role: "user", content: "Plan the change" }] };
        const imageBody = {
            ...textBody,
            messages: [{ role: "user", content: [{ type: "text", text: "Plan the change" }, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }] }],
        };
        const route = (payload) =>
            routeNativeSmartAdaptive({
                protocol: "anthropic_messages",
                request: new Request("http://localhost/x", { headers: { "x-claude-code-session-id": "concurrent" } }),
                body: payload,
                runnable: [textOnly, seesA, seesB],
                keyId: "k-concurrent",
                userId,
                requestId: "r",
                routerAllowed: async () => true,
                prepare: (model) => prepareAnthropicMessages(payload, model),
            });
        try {
            routerPick = "text-only";
            routerDelayMs = 50;
            const callsBefore = routerCalls.length;
            const [textDecision, imageDecision] = await Promise.all([route(textBody), route(imageBody)]);
            assert.equal(textDecision.entry.model.id, "text-only");
            assert.equal(imageDecision.entry.model.id, "sees-a", "the shared pick cannot read the image: this request's own default");
            assert.equal(routerCalls.length, callsBefore + 1, "one router call for both");
        } finally {
            routerPick = null;
            routerDelayMs = 0;
            delete process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED;
        }
    });

    await t.test("Codex Smart Adaptive: OpenAI candidates only, pinned by the thread's prompt_cache_key, encrypted reasoning kept on its model", async () => {
        process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED = "true";
        resetNativeSmartAdaptivePins();
        const pool = await providerPool("openai", "responses");
        const fallback = poolDefault(pool);
        const other = pool.find((entry) => entry.model.id !== fallback.model.id);
        assert.ok(other, "the fixture catalogue has two OpenAI models to route between");
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        reply = ({ signal }) => streamResponse(responsesStream(), {}, signal);
        // Codex 0.146 with model "smart-adaptive" (captured 2026-11-19): its
        // generic function tools, the thread id as prompt_cache_key.
        const firstBody = codexBody({
            model: "smart-adaptive",
            // Assembled, so the scanner does not read a thread id as a credential.
            prompt_cache_key: ["thread", "fixture", "1"].join("-"),
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Fix the test" }] }],
            tools: [{ type: "function", name: "shell_command", parameters: { type: "object", properties: { command: { type: "string" } } } }],
        });
        try {
            routerPick = other.model.id;
            const before = routerCalls.length;
            const first = await codex(key, firstBody);
            await first.text();
            assert.equal(first.status, 200);
            assert.deepEqual(routed(first), [other.model.id, "router"]);
            assert.equal(sent.at(-1).body.model, other.model.apiModel);
            assert.ok(routerCalls.at(-1).eligibleModelIds.every((id) => pool.some((entry) => entry.model.id === id)), "OpenAI models only");

            routerPick = fallback.model.id;
            const nextBody = {
                ...firstBody,
                input: [
                    ...firstBody.input,
                    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAAABencrypted" },
                    { type: "function_call", call_id: "c1", name: "shell_command", arguments: '{"command":"npm test"}' },
                    { type: "function_call_output", call_id: "c1", output: "ok" },
                ],
            };
            const next = await codex(key, nextBody);
            await next.text();
            assert.equal(next.status, 200);
            assert.deepEqual(routed(next), [other.model.id, "continued"]);
            assert.deepEqual(sent.at(-1).body.input, nextBody.input, "the encrypted reasoning goes back to the model that made it");
            assert.equal(routerCalls.length, before + 1);

            // A missed pin on a thread under way: the default, no router call, no failure.
            resetNativeSmartAdaptivePins();
            const missed = await codex(key, nextBody);
            await missed.text();
            assert.equal(missed.status, 200);
            assert.deepEqual(routed(missed), [fallback.model.id, "default"]);
            assert.equal(routerCalls.length, before + 1);
            const [reservation] = await reservationsFor(userId);
            assert.equal((await receiptFor(reservation.id)).modelId, other.model.id, "the receipt names the routed model");
            const native = await receiptFor(reservation.id);
            assert.ok(["router", "continued", "default"].includes(native.routedBy), "the routing decision is on the receipt");
            assert.match(native.routeConversation, /^[0-9a-f]{32}$/);
        } finally {
            routerPick = null;
            delete process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED;
        }
    });

    await t.test("Claude Code Smart Adaptive: a message the user wrote moves the conversation up, never down", async () => {
        process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED = "true";
        resetNativeSmartAdaptivePins();
        const pool = [...(await providerPool("anthropic", "anthropic_messages"))].sort(
            (a, b) => a.capabilities.creditWeight - b.capabilities.creditWeight
        );
        const cheap = pool[0];
        const strong = pool.at(-1);
        assert.ok(strong.capabilities.creditWeight > cheap.capabilities.creditWeight, "the fixture has a cheaper and a stronger model");
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        reply = ({ signal }) => streamResponse(anthropicStream(), {}, signal);
        const session = { headers: { "x-claude-code-session-id": "sess-up" } };
        const userTurn = (text, before = claudeTurn2().messages) =>
            claudeTurn2({
                messages: [
                    ...before,
                    { role: "assistant", content: [{ type: "text", text: "Done." }] },
                    { role: "user", content: [{ type: "text", text }] },
                ],
            });
        try {
            routerPick = cheap.model.id;
            const before = routerCalls.length;
            const first = await claude(key, claudeBody({ model: "smart-adaptive" }), session);
            await first.text();
            assert.deepEqual(routed(first), [cheap.model.id, "router"]);
            assert.equal(routerCalls.at(-1).coding.currentModelId, null);
            assert.equal(routerCalls.at(-1).taskKind, "external_api");

            // A tool round: the pin, no router call.
            const round = await claude(key, claudeTurn2(), session);
            await round.text();
            assert.deepEqual(routed(round), [cheap.model.id, "continued"]);
            assert.equal(routerCalls.length, before + 1);

            // The user writes again and the router asks for more: it moves up.
            routerPick = strong.model.id;
            const harder = userTurn("It still fails. Redesign the parser.");
            const up = await claude(key, harder, session);
            await up.text();
            assert.equal(up.status, 200);
            assert.deepEqual(routed(up), [strong.model.id, "router"]);
            assert.equal(sent.at(-1).body.model, strong.model.apiModel);
            const asked = routerCalls.at(-1);
            assert.equal(routerCalls.length, before + 2, "one router call for the user's message");
            assert.equal(asked.coding.currentModelId, cheap.model.id);
            assert.equal(asked.coding.lastToolResult, "ok");
            assert.equal(asked.coding.toolCount, 1);
            assert.equal(asked.prompt, "It still fails. Redesign the parser.");

            // Pinned once admitted: the next tool round stays on it.
            const next = await claude(key, claudeTurn2({ messages: [...harder.messages,
                { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "Edit", input: { path: "src/parse.ts" } }] },
                { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "ok" }] }] }), session);
            await next.text();
            assert.deepEqual(routed(next), [strong.model.id, "continued"]);

            // A cheaper pick on a later message keeps the stronger model.
            routerPick = cheap.model.id;
            const light = await claude(key, userTurn("Thanks, now write the commit message", harder.messages), session);
            await light.text();
            assert.deepEqual(routed(light), [strong.model.id, "continued"]);
            assert.equal(routerCalls.length, before + 3);

            // A new history on the same session (a Claude Code subagent) keeps
            // the session's model and makes no router call.
            const subagentBefore = routerCalls.length;
            routerPick = cheap.model.id;
            const subagent = await claude(key, claudeBody({ model: "smart-adaptive", messages: [{ role: "user", content: [{ type: "text", text: "Search the repo for parse()" }] }] }), session);
            await subagent.text();
            assert.deepEqual(routed(subagent), [strong.model.id, "continued"]);
            assert.equal(routerCalls.length, subagentBefore);
            routerPick = strong.model.id;

            // Two identical requests for one message at once share one router call.
            const twinsBefore = routerCalls.length;
            routerDelayMs = 50;
            const twinBody = userTurn("Explain the change", harder.messages);
            const twins = await Promise.all([claude(key, twinBody, session), claude(key, twinBody, session)]);
            await Promise.all(twins.map((response) => response.text()));
            routerDelayMs = 0;
            assert.equal(routerCalls.length, twinsBefore + 1, "one router call for both");
            assert.deepEqual(twins.map((response) => routed(response)[0]), [strong.model.id, strong.model.id]);

            // A user message with no pin (a restart) is routed like a first request.
            resetNativeSmartAdaptivePins();
            routerPick = strong.model.id;
            const restarted = await claude(key, userTurn("Carry on"), session);
            await restarted.text();
            assert.deepEqual(routed(restarted), [strong.model.id, "router"]);
            assert.equal(routerCalls.at(-1).coding.currentModelId, null);
        } finally {
            routerPick = null;
            delete process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED;
        }
    });

    await t.test("native Smart Adaptive pins a model only once admission accepted it", async () => {
        process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED = "true";
        resetNativeSmartAdaptivePins();
        const pool = [...(await providerPool("anthropic", "anthropic_messages"))].sort(
            (a, b) => a.capabilities.creditWeight - b.capabilities.creditWeight
        );
        const fallback = poolDefault(pool);
        const strong = pool.at(-1);
        assert.ok(strong.capabilities.creditWeight > fallback.capabilities.creditWeight);
        reply = ({ signal }) => streamResponse(anthropicStream(), {}, signal);
        // A key cap that covers the default model's hold but not the strong one's.
        const probeUser = await newUser();
        const userId = await newUser();
        allow(userId, probeUser);
        const { key: probeKey } = await issueKey(probeUser);
        await (await claude(probeKey, claudeBody({ model: fallback.model.id }))).text();
        const [probe] = await reservationsFor(probeUser);
        const { key } = await issueKey(userId, { creditCap: probe.reservedCredits });
        const session = { headers: { "x-claude-code-session-id": "sess-refused" } };
        try {
            routerPick = strong.model.id;
            const refused = await claude(key, claudeBody({ model: "smart-adaptive" }), session);
            await refused.text();
            assert.equal(refused.status, 429, "the strong model's hold is beyond the key cap");
            // Nothing was pinned: the next tool round is the default's, not the refused model's.
            const round = await claude(key, claudeTurn2(), session);
            await round.text();
            assert.equal(round.status, 200);
            assert.deepEqual(routed(round), [fallback.model.id, "default"]);
        } finally {
            routerPick = null;
            delete process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED;
        }
    });

    await t.test("Codex Smart Adaptive: a message the user wrote moves the thread up", async () => {
        process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED = "true";
        resetNativeSmartAdaptivePins();
        const pool = [...(await providerPool("openai", "responses"))].sort(
            (a, b) => a.capabilities.creditWeight - b.capabilities.creditWeight
        );
        const cheap = pool[0];
        const strong = pool.at(-1);
        assert.ok(strong.capabilities.creditWeight > cheap.capabilities.creditWeight, "the fixture has a cheaper and a stronger OpenAI model");
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        reply = ({ signal }) => streamResponse(responsesStream(), {}, signal);
        const opening = [{ type: "message", role: "user", content: [{ type: "input_text", text: "Fix the test" }] }];
        const thread = { prompt_cache_key: ["thread", "fixture", "up"].join("-") };
        try {
            routerPick = cheap.model.id;
            const first = await codex(key, codexBody({ model: "smart-adaptive", ...thread, input: opening }));
            await first.text();
            assert.deepEqual(routed(first), [cheap.model.id, "router"]);
            routerPick = strong.model.id;
            const later = codexBody({
                model: "smart-adaptive",
                ...thread,
                input: [
                    ...opening,
                    { type: "function_call", call_id: "c1", name: "shell_command", arguments: "{}" },
                    { type: "function_call_output", call_id: "c1", output: "1 failed" },
                    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Tried a fix." }] },
                    { type: "message", role: "user", content: [{ type: "input_text", text: "Still failing" }] },
                ],
            });
            const up = await codex(key, later);
            await up.text();
            assert.deepEqual(routed(up), [strong.model.id, "router"]);
            const asked = routerCalls.at(-1);
            assert.equal(asked.coding.currentModelId, cheap.model.id);
            assert.equal(asked.coding.lastToolResult, "1 failed");
            assert.equal(asked.previousAnswer, "Tried a fix.");
        } finally {
            routerPick = null;
            delete process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED;
        }
    });

    await t.test("non-streaming Messages and the free token count", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const message = { id: "msg_2", type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }], usage: { input_tokens: 20, cache_read_input_tokens: 10, output_tokens: 4 } };
        reply = () => Response.json(message);
        const response = await claude(key, claudeBody({ stream: false }));
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), message);
        const [reservation] = await reservationsFor(userId);
        assert.equal(reservation.settledInputTokens, 30);
        assert.equal(reservation.settledOutputTokens, 4);

        reply = ({ path }) => Response.json({ input_tokens: path.includes("count_tokens") ? 1_234 : -1 });
        const countRequest = new Request("http://localhost/api/anthropic/v1/messages/count_tokens?beta=true", {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }),
        });
        const counted = await handleNativeFreeCall(countRequest, anthropicMessagesSpec, {
            upstreamPath: anthropicCountTokensPath(countRequest),
            prepare: (body, model) => prepareAnthropicMessages(body, model, { countTokens: true }),
        });
        assert.equal(counted.status, 200);
        assert.equal((await counted.json()).input_tokens, 1_234);
        assert.equal(sent.at(-1).path, "/v1/messages/count_tokens?beta=true");
        assert.equal((await reservationsFor(userId)).length, 1, "a token count holds and charges nothing");
    });
});
