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
    const { handleNativeGeneration, handleNativeFreeCall } = await import(mod("lib/externalApiNative.ts"));
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

    await t.test("Claude Code refusals before dispatch: server tool, 1h cache, other provider's model, Smart Adaptive", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const before = sent.length;
        const cases = [
            [claudeBody({ tools: [{ type: "web_search_20250305", name: "web_search" }] }), 400, "server_tool_unsupported"],
            [claudeBody({ system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }] }), 400, "unsupported_cache_ttl"],
            [claudeBody({ model: "gpt-6-luna" }), 400, "model_unsupported_protocol"],
            [claudeBody({ model: "smart-adaptive" }), 400, "model_unsupported_protocol"],
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
