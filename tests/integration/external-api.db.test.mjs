import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { MockLanguageModelV4 } from "ai/test";
import { getSingleAccountCostCeiling, providerBudgetEnvName } from "../../lib/providerCostBudget.ts";

/**
 * The external API end to end against a migrated local database and the real
 * shared credit ledger, with only the model provider faked. Every scenario
 * checks the provider dispatch count and the reservation the request left.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
test("external inference API over the real shared credit ledger", { skip: !databaseUrl }, async (t) => {
    const url = new URL(databaseUrl);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
    assert.match(url.pathname, /test/);
    const MODEL_ID = "gpt-6-luna";
    Object.assign(process.env, {
        NEXTAUTH_SECRET: "external-api-local-synthetic-secret",
        ADMIN_AUDIT_INTEGRITY_KEY: "synthetic-external-api-audit",
        EXTERNAL_API_ENABLED: "true",
        // Provider credentials decide what is offered; the provider itself is faked below.
        OPENAI_API_KEY: "sk-fixture-not-a-key",
        DEEPSEEK_API_KEY: "sk-fixture-not-a-key",
        EXTERNAL_API_ALLOWED_USER_IDS: "",
        // Every request here comes from one loopback address. The per-minute
        // request guards are their own layer; widen them so scenarios do not
        // throttle each other and the credit layer is what each one tests.
        CHAT_USER_PER_MINUTE: "1000",
        CHAT_IP_PER_MINUTE: "1000",
        EXTERNAL_API_REQUESTS_PER_MINUTE: "1000",
    });
    const floor = getSingleAccountCostCeiling();
    for (const provider of ["openai", "anthropic", "deepseek"]) {
        for (const period of ["day", "month"]) process.env[providerBudgetEnvName(provider, period)] = String(floor[period]);
    }

    const root = resolve(import.meta.dirname, "../..");
    const mod = (path) => pathToFileURL(resolve(root, path)).href;
    const { PrismaClient } = await import("@prisma/client");
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const db = new PrismaClient({ adapter: new PrismaPg(pool) });
    let beforeReservationTransaction;
    const prisma = new Proxy(db, {
        get(target, key) {
            if (key === "$transaction") {
                return async (callback, ...rest) => {
                    // The shared reservation transaction is the one that locks
                    // the credit account; a test hook runs just before it.
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

    // The fake provider. `script` decides what one dispatch streams.
    let dispatches = 0;
    let modelSetupFails = false;
    let script = (...args) => textScript("Hello from the fixture.")(...args);
    const lastCalls = [];
    mock.module(mod("lib/activeAiModel.ts"), {
        namedExports: {
            getActiveAiModel: () => {
                if (modelSetupFails) throw new Error("synthetic provider setup failure");
                return (
                new MockLanguageModelV4({
                    doStream: async (options) => {
                        dispatches += 1;
                        lastCalls.push(options);
                        return script(options);
                    },
                })
                );
            },
            QWEN_GROUNDED_THINKING_BUDGET: 128,
            qwenLookupStep: () => undefined,
            createCohereResearchFetch: (f) => f,
        },
    });

    // Smart Adaptive's router. Chat's LLM router is a paid call; here it answers
    // what the test says and records what it was asked.
    const routerCalls = [];
    let routerPick = null;
    let routerDelayMs = 0;
    // Picks to hand out in order before falling back to routerPick.
    const routerPickQueue = [];
    mock.module(mod("lib/autoLlmRouter.ts"), {
        namedExports: {
            pickAutoModelWithLlm: async (input) => {
                routerCalls.push(input);
                const queued = routerPickQueue.length ? routerPickQueue.shift() : undefined;
                if (routerDelayMs) await new Promise((r) => setTimeout(r, routerDelayMs));
                if (queued !== undefined) return queued ? { modelId: queued, rewrite: null } : null;
                return routerPick ? { modelId: routerPick, rewrite: null } : null;
            },
        },
    });

    const { handleChatCompletions } = await import(mod("lib/externalApiInference.ts"));
    const keys = await import(mod("lib/externalApiKeys.ts"));

    const usage = (input = 120, output = 30, extra = {}) => ({
        inputTokens: { total: input, noCache: input - (extra.cacheRead ?? 0), cacheRead: extra.cacheRead ?? 0, cacheWrite: 0 },
        outputTokens: { total: output, text: output - (extra.reasoning ?? 0), reasoning: extra.reasoning ?? 0 },
    });
    const finish = (unified, u = usage()) => ({ type: "finish", finishReason: { unified, raw: unified }, usage: u });
    const streamOf = (parts, { delayMs = 0, signal } = {}) => ({
        stream: new ReadableStream({
            async start(controller) {
                for (const part of parts) {
                    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
                    if (signal?.aborted) {
                        controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
                        return;
                    }
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
    const textScript = (text, u) => () =>
        streamOf([
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", id: "resp_fixture", modelId: "fixture" },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: text.slice(0, 5) },
            { type: "text-delta", id: "t", delta: text.slice(5) },
            { type: "text-end", id: "t" },
            finish("stop", u),
        ]);
    const callScript = (id) => () =>
        streamOf([
            { type: "stream-start", warnings: [] },
            { type: "tool-input-start", id, toolName: "run" },
            { type: "tool-input-delta", id, delta: "{}" },
            { type: "tool-input-end", id },
            { type: "tool-call", toolCallId: id, toolName: "run", input: "{}" },
            finish("tool-calls", usage(200, 12)),
        ]);
    const runTool = [{ type: "function", function: { name: "run", parameters: { type: "object", properties: {} } } }];
    const toolScript = () => () =>
        streamOf([
            { type: "stream-start", warnings: [] },
            { type: "tool-input-start", id: "call_1", toolName: "read" },
            { type: "tool-input-delta", id: "call_1", delta: '{"path":' },
            { type: "tool-input-delta", id: "call_1", delta: '"package.json"}' },
            { type: "tool-input-end", id: "call_1" },
            { type: "tool-call", toolCallId: "call_1", toolName: "read", input: '{"path":"package.json"}' },
            finish("tool-calls", usage(200, 12)),
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
    const body = (extra = {}) => ({
        model: MODEL_ID,
        messages: [{ role: "user", content: "Say hello" }],
        ...extra,
    });
    const call = (key, payload, init = {}) =>
        handleChatCompletions(
            new Request("http://localhost/api/v1/chat/completions", {
                method: "POST",
                headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "user-agent": "fixture-client/1.0", ...(init.headers ?? {}) },
                body: typeof payload === "string" ? payload : JSON.stringify(payload),
                signal: init.signal,
            })
        );
    const reservationsFor = (userId) =>
        db.chatCreditReservation.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
    const readSse = async (response) => {
        const text = await response.text();
        const events = text.split("\n\n").filter(Boolean).map((block) => block.replace(/^data: /, ""));
        return { text, events, chunks: events.filter((e) => e !== "[DONE]").map((e) => JSON.parse(e)) };
    };

    t.after(async () => {
        await db.$disconnect();
        await pool.end();
    });

    await t.test("feature off and account not enabled dispatch nothing", async () => {
        const userId = await newUser();
        const { key } = await issueKey(userId);
        process.env.EXTERNAL_API_ENABLED = "false";
        assert.equal((await call(key, body())).status, 503);
        process.env.EXTERNAL_API_ENABLED = "true";
        allow("someone-else");
        const refused = await call(key, body());
        assert.equal(refused.status, 403);
        assert.equal((await refused.json()).error.code, "account_not_enabled");
        assert.equal(dispatches, 0);
        assert.equal((await reservationsFor(userId)).length, 0);
    });

    await t.test("bad, malformed and cookie-only credentials are 401 with nothing held", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const forged = key.slice(0, -1) + (key.endsWith("A") ? "B" : "A");
        for (const credential of [forged, "sk-not-a-tomverse-key", ""]) {
            const response = await call(credential, body());
            assert.equal(response.status, 401, credential);
        }
        const noHeader = await handleChatCompletions(
            new Request("http://localhost/api/v1/chat/completions", { method: "POST", headers: { cookie: "next-auth.session-token=x" }, body: JSON.stringify(body()) })
        );
        assert.equal(noHeader.status, 401);
        assert.equal(dispatches, 0);
        assert.equal((await reservationsFor(userId)).length, 0);
    });

    await t.test("paid plans only: Free cannot make a key, and a key made on a paid plan stops when the account is Free", async () => {
        process.env.EXTERNAL_API_READS_PER_MINUTE = "1000";
        const { GET: modelsRoute } = await import(mod("app/api/v1/models/route.ts"));
        const { GET: usageRoute } = await import(mod("app/api/v1/usage/route.ts"));
        const { GET: statusRoute } = await import(mod("app/api/v1/requests/status/route.ts"));
        const bearer = (key) => ({ headers: { authorization: `Bearer ${key}` } });
        const reads = (key) => [
            modelsRoute(new Request("http://localhost/api/v1/models", bearer(key))),
            usageRoute(new Request("http://localhost/api/v1/usage", bearer(key))),
            statusRoute(new Request("http://localhost/api/v1/requests/status?request_id=req_x", bearer(key))),
        ];
        // `*` opens the API to every account, but still only to paid ones.
        allow("*");
        const free = await newUser("Free");
        await assert.rejects(issueKey(free), (error) => error.status === 403 && error.code === "PLAN_NOT_ELIGIBLE");
        assert.equal(await db.externalApiKey.count({ where: { userId: free } }), 0, "no key row");

        const userId = await newUser("Pro");
        const { key } = await issueKey(userId);
        assert.equal((await call(key, body())).status, 200);
        for (const response of await Promise.all(reads(key))) assert.notEqual(response.status, 403);

        await db.user.update({ where: { id: userId }, data: { plan: "Free" } });
        const before = dispatches;
        const held = (await reservationsFor(userId)).length;
        const refused = await call(key, body());
        assert.equal(refused.status, 403);
        const refusal = await refused.json();
        assert.equal(refusal.error.code, "plan_not_eligible");
        assert.equal(refusal.error.message, "The Tomverse API needs a paid plan.");
        for (const response of await Promise.all(reads(key))) {
            assert.equal(response.status, 403);
            assert.equal((await response.json()).error.code, "plan_not_eligible");
        }
        assert.equal(dispatches, before, "nothing dispatched");
        assert.equal((await reservationsFor(userId)).length, held, "nothing held");
        // The key itself is untouched: it can still be listed and revoked.
        const [summary] = await keys.listExternalApiKeys(userId);
        assert.equal(summary.state, "active");

        // Read per request: back on a paid plan, the same key works again.
        await db.user.update({ where: { id: userId }, data: { plan: "Max" } });
        assert.equal((await call(key, body())).status, 200);
        await keys.revokeExternalApiKey({ userId, keyId: summary.id }, { session: sessionFor(userId), request: auditRequest() });
        allow();
    });

    await t.test("text completion: one dispatch, one settled reservation, linked receipt, no conversation", async () => {
        const userId = await newUser();
        allow(userId);
        const { key, summary } = await issueKey(userId);
        const before = dispatches;
        const conversationsBefore = await db.conversation.count({ where: { userId } });
        const response = await call(key, body());
        assert.equal(response.status, 200);
        const json = await response.json();
        assert.equal(json.object, "chat.completion");
        assert.equal(json.choices.length, 1);
        assert.equal(json.choices[0].message.content, "Hello from the fixture.");
        assert.equal(json.choices[0].finish_reason, "stop");
        assert.deepEqual([json.usage.prompt_tokens, json.usage.completion_tokens], [120, 30]);
        assert.equal(dispatches - before, 1);
        assert.equal(lastCalls.at(-1).maxOutputTokens > 0, true);
        const [reservation] = await reservationsFor(userId);
        assert.equal(reservation.source, "external_api");
        assert.equal(reservation.status, "settled");
        assert.equal(reservation.outcome, "completed");
        assert.equal(reservation.settledCredits, reservation.reservedCredits, "completed settles the reserved credits");
        assert.equal(reservation.settledInputTokens, 120);
        assert.equal(reservation.settledOutputTokens, 30);
        const receipt = await db.externalApiRequest.findUnique({ where: { reservationId: reservation.id } });
        assert.equal(receipt.keyId, summary.id);
        assert.equal(receipt.finishReason, "stop");
        assert.ok(receipt.completedAt);
        assert.equal(receipt.clientName, "fixture-client/1.0");
        assert.equal(response.headers.get("x-request-id"), receipt.id);
        assert.equal(await db.conversation.count({ where: { userId } }), conversationsBefore);
        const stored = JSON.stringify(receipt);
        assert.ok(!stored.includes("Say hello") && !stored.includes("Hello from the fixture") && !stored.includes(key));
    });

    await t.test("streamed tool-only reply is a completed, charged request; the tool result is a new request", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        script = toolScript();
        const tools = [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } }];
        const before = dispatches;
        const response = await call(key, body({ stream: true, stream_options: { include_usage: true }, tools }));
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /text\/event-stream/);
        const { events, chunks } = await readSse(response);
        assert.equal(events.at(-1), "[DONE]");
        const ids = new Set(chunks.map((c) => c.id));
        assert.equal(ids.size, 1, "one completion id across chunks");
        const toolFragments = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
        assert.equal(toolFragments[0].id, "call_1");
        assert.equal(toolFragments[0].function.name, "read");
        assert.deepEqual(JSON.parse(toolFragments.map((f) => f.function?.arguments ?? "").join("")), { path: "package.json" });
        const finishChunk = chunks.find((c) => c.choices[0]?.finish_reason);
        assert.equal(finishChunk.choices[0].finish_reason, "tool_calls");
        const usageChunk = chunks.at(-1);
        assert.deepEqual(usageChunk.choices, []);
        assert.equal(usageChunk.usage.prompt_tokens, 200);
        assert.equal(dispatches - before, 1, "the server never executes the tool or loops");
        let [reservation] = await reservationsFor(userId);
        assert.equal(reservation.outcome, "completed");
        assert.ok(reservation.settledCredits > 0, "tool-only is not an empty refund");

        script = textScript("package.json names the fixture.");
        const followUp = await call(
            key,
            body({
                tools,
                messages: [
                    { role: "user", content: "Read package.json" },
                    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"package.json"}' } }] },
                    { role: "tool", tool_call_id: "call_1", content: '{"name":"fixture"}' },
                ],
            })
        );
        assert.equal(followUp.status, 200);
        assert.equal(dispatches - before, 2);
        const sent = lastCalls.at(-1).prompt;
        assert.ok(sent.some((m) => m.role === "tool"), "the tool result reached the provider");
        const all = await reservationsFor(userId);
        assert.equal(all.length, 2, "a separate reservation per model call");
        assert.notEqual(all[0].id, all[1].id);
        script = textScript("Hello from the fixture.");
    });

    await t.test("system and developer messages reach the provider where the client put them", async () => {
        // The shape Aside (Pi openai-completions) and VS Code send: instructions
        // first, often as developer, sometimes a later system note.
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const response = await call(
            key,
            body({
                messages: [
                    { role: "developer", content: "You are a coding agent." },
                    { role: "user", content: [{ type: "text", text: "Hi" }] },
                    { role: "assistant", content: "Hello." },
                    { role: "system", content: "The workspace changed." },
                    { role: "user", content: "Continue" },
                ],
            })
        );
        assert.equal(response.status, 200);
        assert.deepEqual(lastCalls.at(-1).prompt.map((m) => m.role), ["system", "user", "assistant", "system", "user"]);
    });

    await t.test("a request the SDK or adapter refuses before sending is a 400 that costs nothing", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const { UnsupportedFunctionalityError } = await import("ai");
        script = () => {
            throw new UnsupportedFunctionalityError({ functionality: "synthetic request shape" });
        };
        const response = await call(key, body());
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.code, "unsupported_request");
        const [reservation] = await reservationsFor(userId);
        assert.equal(reservation.outcome, "failed");
        assert.equal(reservation.settledCredits, 0);
        assert.equal(reservation.settledCostMicroUsd, 0n, "nothing left this process, so no provider cost");
        // Streaming too: the status waits for the first real part, so the
        // client gets the same 400, not a 200 stream carrying an error.
        const streamed = await call(key, body({ stream: true }));
        assert.equal(streamed.status, 400);
        assert.ok((streamed.headers.get("content-type") ?? "").includes("application/json"));
        assert.equal((await streamed.json()).error.code, "unsupported_request");
        const second = (await reservationsFor(userId)).at(-1);
        assert.equal(second.settledCostMicroUsd, 0n);
        script = textScript("Hello from the fixture.");
    });

    await t.test("Smart Adaptive routes among catalogue models and keeps the pick through a tool loop", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const SECOND = "deepseek-v4-flash";
        try {
            // Without the router switch: always offered, no router call, the default model.
            routerPick = SECOND;
            routerCalls.length = 0;
            const plain = await call(key, body({ model: "smart-adaptive" }));
            assert.equal(plain.status, 200);
            assert.equal(plain.headers.get("x-tomverse-routed-model"), MODEL_ID);
            assert.equal(plain.headers.get("x-tomverse-routed-by"), "default");
            assert.equal(routerCalls.length, 0, "no paid router call while the switch is off");

            process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED = "true";
            const question = { role: "user", content: "Run the tests and fix the failure" };
            // The answer is a tool call: its id is what the tool round carries back.
            script = callScript("call_sa1");
            const first = await call(key, body({ model: "smart-adaptive", messages: [question], tools: runTool }));
            assert.equal(first.status, 200);
            assert.equal(first.headers.get("x-tomverse-routed-model"), SECOND);
            assert.equal(first.headers.get("x-tomverse-routed-by"), "router");
            assert.equal((await first.json()).model, SECOND, "the response names the model that answered");
            assert.equal(routerCalls.length, 1);
            assert.equal(routerCalls[0].prompt, "Run the tests and fix the failure");
            assert.equal(routerCalls[0].conversationId, null, "no decision row, so no prompt is stored");
            assert.ok(routerCalls[0].eligibleModelIds.includes(MODEL_ID) && routerCalls[0].eligibleModelIds.includes(SECOND), "every catalogue model with a credential");
            assert.ok(!routerCalls[0].eligibleModelIds.some((id) => id.startsWith("claude-")), "no Anthropic credential here, so no Anthropic model");
            assert.ok(routerCalls[0].models.length > routerCalls[0].eligibleModelIds.length, "the router model is looked up among all runtime models");
            const receipt = await db.externalApiRequest.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } });
            assert.equal(receipt.modelId, SECOND, "the receipt and the charge are the routed model's");

            // The tool round goes to the model that made the call: no router call.
            routerPick = MODEL_ID;
            script = callScript("call_sa2");
            const round = await call(key, body({
                model: "smart-adaptive",
                messages: [
                    question,
                    { role: "assistant", content: null, tool_calls: [{ id: "call_sa1", type: "function", function: { name: "run", arguments: "{}" } }] },
                    { role: "tool", tool_call_id: "call_sa1", content: "1 failing" },
                ],
                tools: runTool,
            }));
            assert.equal(round.status, 200);
            assert.equal(round.headers.get("x-tomverse-routed-model"), SECOND);
            assert.equal(round.headers.get("x-tomverse-routed-by"), "continued");
            assert.equal(routerCalls.length, 1);

            // The router gate closed (here: its switch) does not hand a running
            // tool loop to another model.
            delete process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED;
            script = textScript("All green.");
            const gated = await call(key, body({
                model: "smart-adaptive",
                messages: [
                    question,
                    { role: "assistant", content: null, tool_calls: [{ id: "call_sa1", type: "function", function: { name: "run", arguments: "{}" } }] },
                    { role: "tool", tool_call_id: "call_sa1", content: "1 failing" },
                    { role: "assistant", content: null, tool_calls: [{ id: "call_sa2", type: "function", function: { name: "run", arguments: "{}" } }] },
                    { role: "tool", tool_call_id: "call_sa2", content: "0 failing" },
                ],
                tools: runTool,
            }));
            assert.equal(gated.headers.get("x-tomverse-routed-model"), SECOND);
            assert.equal(gated.headers.get("x-tomverse-routed-by"), "continued");
            process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED = "true";

            // Streaming: the round sent the moment the client sees the call
            // finish (before settlement) still goes to the model that made it.
            routerPick = SECOND;
            script = (options) => streamOf([
                { type: "stream-start", warnings: [] },
                { type: "tool-input-start", id: "call_stream", toolName: "run" },
                { type: "tool-input-delta", id: "call_stream", delta: "{}" },
                { type: "tool-input-end", id: "call_stream" },
                { type: "tool-call", toolCallId: "call_stream", toolName: "run", input: "{}" },
                finish("tool-calls", usage(200, 12)),
            ], { delayMs: 30, signal: options.abortSignal });
            const streamed = await call(key, body({ model: "smart-adaptive", stream: true, messages: [{ role: "user", content: "Stream a tool call" }], tools: runTool }));
            assert.equal(streamed.headers.get("x-tomverse-routed-model"), SECOND);
            const reader = streamed.body.getReader();
            const decoder = new TextDecoder();
            let seen = "";
            while (!seen.includes('"finish_reason":"tool_calls"')) {
                const { value, done } = await reader.read();
                if (done) break;
                seen += decoder.decode(value, { stream: true });
            }
            routerPick = MODEL_ID;
            script = textScript("Ran it.");
            const quick = await call(key, body({
                model: "smart-adaptive",
                messages: [
                    { role: "user", content: "Stream a tool call" },
                    { role: "assistant", content: null, tool_calls: [{ id: "call_stream", type: "function", function: { name: "run", arguments: "{}" } }] },
                    { role: "tool", tool_call_id: "call_stream", content: "ok" },
                ],
                tools: runTool,
            }));
            await reader.cancel().catch(() => undefined);
            assert.equal(quick.headers.get("x-tomverse-routed-by"), "continued", "remembered before the call reached the client");
            assert.equal(quick.headers.get("x-tomverse-routed-model"), SECOND);
            routerCalls.pop();

            // A tool result for a call this API never answered with routes afresh.
            const stranger = await call(key, body({
                model: "smart-adaptive",
                messages: [
                    question,
                    { role: "assistant", content: null, tool_calls: [{ id: "call_unknown", type: "function", function: { name: "run", arguments: "{}" } }] },
                    { role: "tool", tool_call_id: "call_unknown", content: "?" },
                ],
                tools: runTool,
            }));
            assert.equal(stranger.headers.get("x-tomverse-routed-by"), "router");
            assert.equal(routerCalls.length, 2);
            routerCalls.pop();

            // A new user message is routed again.
            const next = await call(key, body({ model: "smart-adaptive", messages: [question, { role: "assistant", content: "Done." }, { role: "user", content: "Thanks, now summarise" }] }));
            assert.equal(next.headers.get("x-tomverse-routed-model"), MODEL_ID);
            assert.equal(routerCalls.length, 2);
            assert.equal(routerCalls[1].previousAnswer, "Done.");

            // An image: only models that read images are candidates.
            routerPick = SECOND;
            const image = await call(key, body({ model: "smart-adaptive", messages: [{ role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" } }] }] }));
            assert.equal(image.status, 200);
            assert.ok(!routerCalls.at(-1).eligibleModelIds.includes(SECOND), "a model without image input is not a candidate");
            assert.equal(image.headers.get("x-tomverse-routed-model"), MODEL_ID, "a pick outside the candidates is not taken");
            assert.equal(image.headers.get("x-tomverse-routed-by"), "default");

            // A requested output the default model cannot give goes to one that can.
            routerPick = null;
            const long = await call(key, body({ model: "smart-adaptive", max_tokens: 300_000, messages: [{ role: "user", content: "Write a long report" }] }));
            assert.equal(long.status, 200);
            assert.notEqual(long.headers.get("x-tomverse-routed-model"), MODEL_ID);

            // No router answer (not configured, budget, timeout): the default model.
            const fallback = await call(key, body({ model: "smart-adaptive", messages: [{ role: "user", content: "Something else" }] }));
            assert.equal(fallback.headers.get("x-tomverse-routed-model"), MODEL_ID);
            assert.equal(fallback.headers.get("x-tomverse-routed-by"), "default");

            // Optional features a candidate cannot take leave it out, by the
            // same rules the request is validated with.
            routerPick = SECOND;
            const strictTool = await call(key, body({
                model: "smart-adaptive",
                messages: [{ role: "user", content: "Use the strict tool" }],
                tools: [{ type: "function", function: { name: "run", strict: true, parameters: { type: "object", properties: {}, additionalProperties: false } } }],
            }));
            assert.equal(strictTool.status, 200, "never refused because of the pick");
            assert.ok(!routerCalls.at(-1).eligibleModelIds.includes(SECOND), "DeepSeek's adapter drops strict, so it is not a candidate");
            assert.notEqual(strictTool.headers.get("x-tomverse-routed-model"), SECOND);
            const effort = await call(key, body({ model: "smart-adaptive", reasoning_effort: "low", messages: [{ role: "user", content: "Think a little" }] }));
            assert.equal(effort.status, 200);
            assert.ok(routerCalls.at(-1).eligibleModelIds.every((id) => !id.startsWith("deepseek")), "reasoning_effort is OpenAI-only");

            // An Idempotency-Key replay is answered before routing: no second router call.
            routerPick = MODEL_ID;
            const idem = { headers: { "idempotency-key": "smart-adaptive-replay-1" } };
            const once = await call(key, body({ model: "smart-adaptive", messages: [{ role: "user", content: "Once only" }] }), idem);
            assert.equal(once.status, 200);
            await once.text();
            const routedBefore = routerCalls.length;
            const again = await call(key, body({ model: "smart-adaptive", messages: [{ role: "user", content: "Once only" }] }), idem);
            assert.equal(again.status, 409, "the replay is the original's receipt");
            assert.equal(routerCalls.length, routedBefore, "a replay makes no router call");

            // Concurrent duplicates of one Idempotency-Key make one router call
            // and take the same model, so the one admitted answered with the
            // model the tool-loop memory records; the other is its receipt.
            routerPick = SECOND;
            routerDelayMs = 150;
            const twin = { headers: { "idempotency-key": "smart-adaptive-twins" } };
            const twinBody = body({ model: "smart-adaptive", messages: [{ role: "user", content: "Twins" }] });
            const routedBeforeTwins = routerCalls.length;
            const twins = await Promise.all([call(key, twinBody, twin), call(key, twinBody, twin)]);
            const twinBodies = await Promise.all(twins.map((response) => response.text()));
            routerDelayMs = 0;
            assert.equal(routerCalls.length, routedBeforeTwins + 1, "one router call for both twins");
            assert.deepEqual(twins.map((response) => response.status).sort(), [200, 409]);
            const winner = twins.findIndex((response) => response.status === 200);
            assert.equal(twins[winner].headers.get("x-tomverse-routed-model"), SECOND, "the admitted twin took the router's pick");
            assert.equal(JSON.parse(twinBodies[winner]).model, SECOND, "the admitted twin answered with the pick");
            const receiptBody = JSON.parse(twinBodies[1 - winner]);
            assert.ok(["idempotent_request_completed", "idempotent_request_in_progress"].includes(receiptBody.error.code), "the other is the winner's receipt");
            const twinReceipt = await db.externalApiRequest.findFirst({ where: { userId, idempotencyKeyDigest: { not: null } }, orderBy: { createdAt: "desc" } });
            assert.equal(twinReceipt.modelId, SECOND);

            // A different body under the same Idempotency-Key is not a twin: it
            // routes on its own and admission refuses one as a reused key.
            routerDelayMs = 150;
            const reused = { headers: { "idempotency-key": "smart-adaptive-reused" } };
            const routedBeforeReused = routerCalls.length;
            const pair = await Promise.all([
                call(key, body({ model: "smart-adaptive", messages: [{ role: "user", content: "Body one" }] }), reused),
                call(key, body({ model: "smart-adaptive", messages: [{ role: "user", content: "Body two" }] }), reused),
            ]);
            await Promise.all(pair.map((response) => response.text()));
            routerDelayMs = 0;
            assert.equal(routerCalls.length, routedBeforeReused + 2, "different bodies do not share a pick");
            assert.deepEqual(pair.map((response) => response.status).sort(), [200, 422]);

            // Same messages, another field different, routed to different
            // models: the tool round continues with the model of the request
            // admission let through, not the one decided last.
            routerDelayMs = 100;
            routerPickQueue.push(SECOND, MODEL_ID);
            script = callScript("call_s");
            const split = { headers: { "idempotency-key": "smart-adaptive-split" } };
            const splitQuestion = { role: "user", content: "Split decision" };
            const splitPair = await Promise.all([
                call(key, body({ model: "smart-adaptive", temperature: 0.1, messages: [splitQuestion], tools: runTool }), split),
                call(key, body({ model: "smart-adaptive", temperature: 0.9, messages: [splitQuestion], tools: runTool }), split),
            ]);
            await Promise.all(splitPair.map((response) => response.text()));
            routerDelayMs = 0;
            const admitted = splitPair.find((response) => response.status === 200);
            assert.ok(admitted, "one of them is admitted");
            const answeredBy = admitted.headers.get("x-tomverse-routed-model");
            const followUp = await call(key, body({
                model: "smart-adaptive",
                messages: [
                    splitQuestion,
                    { role: "assistant", content: null, tool_calls: [{ id: "call_s", type: "function", function: { name: "run", arguments: "{}" } }] },
                    { role: "tool", tool_call_id: "call_s", content: "done" },
                ],
                tools: runTool,
            }));
            assert.equal(followUp.headers.get("x-tomverse-routed-by"), "continued");
            assert.equal(followUp.headers.get("x-tomverse-routed-model"), answeredBy, "the memory holds the model that answered");

            // Two independent requests with the same history, both admitted and
            // routed to different models: each tool round goes to its own model,
            // because each answer's tool-call id is its own.
            let callSerial = 0;
            script = (options) => callScript(`call_twin_${++callSerial}`)(options);
            routerDelayMs = 50;
            routerPickQueue.push(SECOND, MODEL_ID);
            const sameHistory = { role: "user", content: "Same history" };
            const both = await Promise.all([
                call(key, body({ model: "smart-adaptive", messages: [sameHistory], tools: runTool })),
                call(key, body({ model: "smart-adaptive", messages: [sameHistory], tools: runTool })),
            ]);
            routerDelayMs = 0;
            const answers = await Promise.all(both.map((response) => response.json()));
            assert.deepEqual(both.map((response) => response.status), [200, 200]);
            assert.deepEqual(new Set(answers.map((answer) => answer.model)), new Set([SECOND, MODEL_ID]));
            script = textScript("Round done.");
            for (const answer of answers) {
                const id = answer.choices[0].message.tool_calls[0].id;
                const resumed = await call(key, body({
                    model: "smart-adaptive",
                    messages: [
                        sameHistory,
                        { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "run", arguments: "{}" } }] },
                        { role: "tool", tool_call_id: id, content: "ok" },
                    ],
                    tools: runTool,
                }));
                assert.equal(resumed.headers.get("x-tomverse-routed-by"), "continued");
                assert.equal(resumed.headers.get("x-tomverse-routed-model"), answer.model, "each round goes to the model that made its call");
            }
            script = textScript("Hello from the fixture.");

            // A key whose cap is spent gets no paid router call; admission refuses as usual.
            const capped = await issueKey(userId, { creditCap: 1 });
            assert.equal((await call(capped.key, body({ model: "smart-adaptive", messages: [{ role: "user", content: "First" }] }))).status, 200);
            const routedAtCap = routerCalls.length;
            const overCap = await call(capped.key, body({ model: "smart-adaptive", messages: [{ role: "user", content: "Second" }] }));
            assert.notEqual(overCap.status, 200);
            assert.equal(routerCalls.length, routedAtCap, "no router call for a key whose cap is spent");

            // A model the catalogue knows but this deployment does not offer (no
            // credential here) says how to recover instead of a bare 404.
            const retired = await call(key, body({ model: "claude-haiku-5-5" }));
            assert.equal(retired.status, 404);
            assert.equal((await retired.json()).error.code, "model_unavailable");
        } finally {
            delete process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED;
            routerPick = null;
            routerDelayMs = 0;
            routerPickQueue.length = 0;
            script = textScript("Hello from the fixture.");
        }
    });

    await t.test("sampling parameters a model does not take are left out and named, not refused", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        // VS Code sends a temperature on every request; GPT 6 Luna takes none.
        const response = await call(key, body({ temperature: 0.1, top_p: 0.9, presence_penalty: 0.2 }));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-tomverse-ignored-parameters"), "temperature, top_p, presence_penalty");
        const sent = lastCalls.at(-1);
        assert.equal(sent.temperature, undefined);
        assert.equal(sent.topP, undefined);
        assert.equal(sent.presencePenalty, undefined);
        const streamed = await call(key, body({ stream: true, temperature: 0 }));
        assert.equal(streamed.status, 200);
        assert.equal(streamed.headers.get("x-tomverse-ignored-parameters"), "temperature");
        await streamed.text();
        const plain = await call(key, body());
        assert.equal(plain.headers.get("x-tomverse-ignored-parameters"), null);
    });

    await t.test("OpenAI calls never ask the provider to store the request", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        assert.equal((await call(key, body({ store: false }))).status, 200);
        assert.equal(lastCalls.at(-1).providerOptions?.openai?.store, false);
        assert.equal((await call(key, body())).status, 200);
        assert.equal(lastCalls.at(-1).providerOptions?.openai?.store, false, "even when the client says nothing");
    });

    await t.test("strict tool schemas reach a provider that honours them", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const tools = [{ type: "function", function: { name: "read", strict: true, parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } }];
        assert.equal((await call(key, body({ tools }))).status, 200);
        const sent = lastCalls.at(-1).tools.find((entry) => entry.name === "read");
        assert.equal(sent.strict, true);
    });

    await t.test("a reply blocked entirely by the provider's content filter is a normal, uncharged finish", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        script = () => streamOf([{ type: "stream-start", warnings: [] }, finish("content-filter", usage(100, 0))]);
        const response = await call(key, body());
        assert.equal(response.status, 200);
        const json = await response.json();
        assert.equal(json.choices[0].finish_reason, "content_filter");
        assert.equal(json.choices[0].message.content, null);
        const streamed = await readSse(await call(key, body({ stream: true })));
        assert.equal(streamed.events.at(-1), "[DONE]");
        assert.equal(streamed.chunks.find((c) => c.choices?.[0]?.finish_reason)?.choices[0].finish_reason, "content_filter");
        for (const reservation of await reservationsFor(userId)) {
            assert.equal(reservation.status, "refunded", "nothing produced, nothing charged");
            assert.equal(reservation.outcome, "empty");
            assert.equal(reservation.settledCredits, 0);
        }
        script = textScript("Hello from the fixture.");
    });

    await t.test("with no output limit the provider gets exactly the limit the reservation priced", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        assert.equal((await call(key, body())).status, 200);
        const unlimited = lastCalls.at(-1).maxOutputTokens;
        assert.equal((await call(key, body({ max_tokens: unlimited }))).status, 200);
        assert.equal(lastCalls.at(-1).maxOutputTokens, unlimited);
        const [implicit, explicit] = await reservationsFor(userId);
        assert.equal(implicit.reservedCostMicroUsd, explicit.reservedCostMicroUsd, "no limit is priced as the model maximum");
        assert.equal((await call(key, body({ max_tokens: 64 }))).status, 200);
        assert.equal(lastCalls.at(-1).maxOutputTokens, 64);
        assert.ok((await reservationsFor(userId)).at(-1).reservedCostMicroUsd < implicit.reservedCostMicroUsd);
    });

    await t.test("a client that left before dispatch is refunded and never reaches the provider", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const controller = new AbortController();
        controller.abort();
        const before = dispatches;
        const response = await call(key, body(), { signal: controller.signal });
        assert.equal(response.status, 499);
        assert.equal(dispatches, before);
        const [reservation] = await reservationsFor(userId);
        assert.equal(reservation.status, "refunded");
        assert.equal(reservation.settledCostMicroUsd, 0n);
    });

    await t.test("a tool call cut off by the output limit is reported as length, not as a finished call", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const tools = [{ type: "function", function: { name: "write", parameters: { type: "object", properties: { text: { type: "string" } } } } }];
        script = () =>
            streamOf([
                { type: "stream-start", warnings: [] },
                { type: "tool-input-start", id: "call_cut", toolName: "write" },
                { type: "tool-input-delta", id: "call_cut", delta: '{"text":"unfinish' },
                finish("length", usage(100, 4096)),
            ]);
        const response = await call(key, body({ tools }));
        const json = await response.json();
        assert.equal(json.choices[0].finish_reason, "length");
        assert.equal(json.choices[0].message.tool_calls, undefined, "the partial call is not offered for execution");
        const streamed = await readSse(await call(key, body({ tools, stream: true })));
        const finishChunk = streamed.chunks.find((c) => c.choices?.[0]?.finish_reason);
        assert.equal(finishChunk.choices[0].finish_reason, "length");
        script = textScript("Hello from the fixture.");
    });

    await t.test("an inline image reaches the provider as a file part and widens the reservation", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const png =
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        assert.equal((await call(key, body())).status, 200);
        const response = await call(
            key,
            body({ messages: [{ role: "user", content: [{ type: "text", text: "Say hello" }, { type: "image_url", image_url: { url: png } }] }] })
        );
        assert.equal(response.status, 200);
        const part = lastCalls.at(-1).prompt.at(-1).content.find((p) => p.type === "file");
        assert.equal(part.mediaType, "image/png");
        const [textOnly, withImage] = await reservationsFor(userId);
        const payload = (row) => row.reservationPayload.inputTokens;
        assert.ok(payload(withImage) > payload(textOnly), "the image is in the input estimate");
        // A 1x1 image measures to a handful of tokens, but the hold is Chat's
        // flat per-image allowance, so the API is never the cheaper way in.
        assert.ok(payload(withImage) - payload(textOnly) >= 16_000, `image hold ${payload(withImage) - payload(textOnly)}`);
        assert.ok(withImage.reservedCostMicroUsd > textOnly.reservedCostMicroUsd);
        const before = dispatches;
        const remote = await call(key, body({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://169.254.169.254/" } }] }] }));
        assert.equal(remote.status, 400);
        assert.equal((await remote.json()).error.code, "unsupported_image_url");
        assert.equal(dispatches, before, "a remote image URL is never fetched or forwarded");
    });

    await t.test("a key revoked between authentication and reservation admits nothing", async () => {
        const userId = await newUser();
        allow(userId);
        const { key, summary } = await issueKey(userId);
        const before = dispatches;
        beforeReservationTransaction = () =>
            keys.revokeExternalApiKey({ userId, keyId: summary.id }, { session: sessionFor(userId), request: auditRequest() });
        const response = await call(key, body());
        assert.equal(response.status, 401);
        assert.equal(dispatches, before);
        assert.equal((await reservationsFor(userId)).length, 0, "the hold rolled back with the refusal");
        assert.equal((await call(key, body())).status, 401, "and stays refused");
        const audit = await db.adminAuditLog.findMany({ where: { targetId: summary.id }, orderBy: { createdAt: "asc" } });
        assert.deepEqual(audit.map((a) => a.action), ["external_api_key.created", "external_api_key.revoked"]);
        assert.ok(!JSON.stringify(audit).includes(key), "the audit trail never holds the secret");
    });

    await t.test("expired keys and suspended accounts are refused before dispatch", async () => {
        const userId = await newUser();
        allow(userId);
        const { key, summary } = await issueKey(userId);
        await db.externalApiKey.update({ where: { id: summary.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
        const before = dispatches;
        assert.equal((await call(key, body())).status, 401);
        await db.externalApiKey.update({ where: { id: summary.id }, data: { expiresAt: null } });
        await db.user.update({ where: { id: userId }, data: { accountStatus: "suspended" } });
        assert.equal((await call(key, body())).status, 401);
        assert.equal(dispatches, before);
    });

    await t.test("the key cap counts held and settled credits and holds under concurrency", async () => {
        const userId = await newUser();
        allow(userId);
        // Learn one request's credit cost from a first, uncapped key.
        const probe = await issueKey(userId);
        assert.equal((await call(probe.key, body())).status, 200);
        const perRequest = (await reservationsFor(userId))[0].settledCredits;
        assert.ok(perRequest > 0);

        const capped = await issueKey(userId, { creditCap: perRequest * 2 });
        // Hold every dispatch open so all requests are in flight together.
        const releases = [];
        script = () => {
            let open;
            const gate = new Promise((r) => (open = r));
            releases.push(open);
            return {
                stream: new ReadableStream({
                    async start(controller) {
                        controller.enqueue({ type: "stream-start", warnings: [] });
                        await gate;
                        controller.enqueue({ type: "text-start", id: "t" });
                        controller.enqueue({ type: "text-delta", id: "t", delta: "ok" });
                        controller.enqueue({ type: "text-end", id: "t" });
                        controller.enqueue(finish("stop"));
                        controller.close();
                    },
                }),
            };
        };
        const before = dispatches;
        const inflight = Array.from({ length: 5 }, () => call(capped.key, body()));
        const waitFor = async (n) => {
            for (let i = 0; i < 400 && releases.length < n; i += 1) await new Promise((r) => setTimeout(r, 10));
        };
        await waitFor(2);
        await new Promise((r) => setTimeout(r, 200));
        for (const open of releases) open();
        const responses = await Promise.all(inflight);
        const statuses = responses.map((r) => r.status).sort();
        assert.deepEqual(statuses, [200, 200, 429, 429, 429]);
        const refusal = await responses.find((r) => r.status === 429).json();
        assert.equal(refusal.error.code, "key_credit_cap_reached");
        assert.equal(dispatches - before, 2, "refused requests never reached the provider");
        const summaries = await keys.listExternalApiKeys(userId);
        const cappedSummary = summaries.find((s) => s.id === capped.summary.id);
        assert.equal(cappedSummary.committedCredits, perRequest * 2);
        assert.equal(cappedSummary.heldCredits, 0);
        // Both keys draw on one account: same subject, one usage ledger.
        const subjects = new Set((await reservationsFor(userId)).map((r) => r.subjectKey));
        assert.equal(subjects.size, 1);
        script = textScript("Hello from the fixture.");
    });

    await t.test("web and API requests draw on one balance and never over-reserve it", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const security = await import(mod("lib/chatSecurity.ts"));
        const { getRuntimeModel } = await import(mod("lib/modelRegistry.ts"));
        const { getUserBillingPlan } = await import(mod("lib/billingEntitlements.ts"));
        const plan = await getUserBillingPlan(userId);
        const model = await getRuntimeModel(MODEL_ID);
        const limit = Math.min(plan.dailyMessageLimit, plan.monthlyMessageLimit);
        // The per-minute request guard is a separate layer; widen it so the
        // credit allowance is what runs out.
        const savedMinute = [process.env.CHAT_USER_PER_MINUTE, process.env.CHAT_IP_PER_MINUTE];
        process.env.CHAT_USER_PER_MINUTE = "1000";
        process.env.CHAT_IP_PER_MINUTE = "1000";
        // The API is paid plans only, and a paid allowance is too large to use
        // up request by request: web holds first take all but a small remainder.
        const remainder = 30;
        assert.ok(limit > remainder, "a finite allowance to exhaust");
        // The web side: Chat's own admission, held and never settled, so every
        // credit it takes stays committed while the API competes for the rest.
        const web = async () => {
            const access = security.identifyChatCaller(new Request("http://localhost/api/chat"), userId, plan.tier, {
                dailyMessageLimit: plan.dailyMessageLimit,
                monthlyMessageLimit: plan.monthlyMessageLimit,
            });
            try {
                const grant = await security.acquireChatAccess(access, security.createChatBudget("user", model, 10), { source: "chat" });
                await security.releaseChatAccess(grant.leaseId);
                return "ok";
            } catch (error) {
                return error.code;
            }
        };
        const api = async () => {
            const response = await call(key, body());
            return response.status === 200 ? "ok" : (await response.json()).error.code;
        };
        const committed = async () =>
            (await reservationsFor(userId)).reduce((total, row) => total + (row.status === "reserved" ? row.reservedCredits : row.settledCredits), 0);
        for (let i = 0; i < limit - remainder; i += 1) assert.equal(await web(), "ok");
        await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? web() : api())));
        assert.ok((await committed()) <= limit);
        let refusalsInARow = 0;
        let lastRefusal = null;
        for (let i = 0; i < limit * 3 && refusalsInARow < 4; i += 1) {
            const result = await (i % 2 ? web() : api());
            if (result === "ok") refusalsInARow = 0;
            else {
                refusalsInARow += 1;
                lastRefusal = result;
            }
        }
        const total = await committed();
        // The prefill rows are one-credit web holds; the step to compare is an API request.
        const perRequest = (await reservationsFor(userId)).find((row) => row.source === "external_api").reservedCredits;
        const diagnosis = JSON.stringify({ total, limit, perRequest, lastRefusal, rows: (await reservationsFor(userId)).length });
        assert.ok(total <= limit, diagnosis);
        assert.ok(limit - total < perRequest, `the allowance was used up, not stranded: ${diagnosis}`);
        assert.ok(lastRefusal && !/CONCURRENCY/.test(lastRefusal), `exhaustion is refused as a credit limit: ${diagnosis}`);
        const sources = new Set((await reservationsFor(userId)).map((row) => row.source));
        assert.deepEqual([...sources].sort(), ["chat", "external_api"]);
        for (const [name, value] of [["CHAT_USER_PER_MINUTE", savedMinute[0]], ["CHAT_IP_PER_MINUTE", savedMinute[1]]]) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });

    await t.test("idempotency: a retry is a receipt, a reuse is a conflict, neither dispatches", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const headers = { "idempotency-key": "retry-1" };
        assert.equal((await call(key, body(), { headers })).status, 200);
        const before = dispatches;
        const replay = await call(key, body(), { headers });
        assert.equal(replay.status, 409);
        const replayBody = await replay.json();
        assert.equal(replayBody.error.code, "idempotent_request_completed");
        assert.equal(replayBody.tomverse.status, "settled");
        const reuse = await call(key, body({ messages: [{ role: "user", content: "Different" }] }), { headers });
        assert.equal(reuse.status, 422);
        assert.equal((await reuse.json()).error.code, "idempotency_key_reused");
        // Concurrent twins: exactly one dispatch.
        const twins = await Promise.all([1, 2, 3].map(() => call(key, body(), { headers: { "idempotency-key": "twin" } })));
        assert.deepEqual(twins.map((r) => r.status).sort(), [200, 409, 409]);
        assert.equal(dispatches - before, 1);
        assert.equal((await reservationsFor(userId)).length, 2);
    });

    await t.test("a twin refused by the shared allowance its original just used up gets the original's receipt", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const security = await import(mod("lib/chatSecurity.ts"));
        const { getRuntimeModel } = await import(mod("lib/modelRegistry.ts"));
        const { getUserBillingPlan } = await import(mod("lib/billingEntitlements.ts"));
        const plan = await getUserBillingPlan(userId);
        const model = await getRuntimeModel(MODEL_ID);
        const limit = Math.min(plan.dailyMessageLimit, plan.monthlyMessageLimit);
        // Web holds (one credit each) take all but the last credit.
        const access = () =>
            security.identifyChatCaller(new Request("http://localhost/api/chat"), userId, plan.tier, {
                dailyMessageLimit: plan.dailyMessageLimit,
                monthlyMessageLimit: plan.monthlyMessageLimit,
            });
        for (let i = 0; i < limit - 1; i += 1) {
            const grant = await security.acquireChatAccess(access(), security.createChatBudget("user", model, 10), { source: "chat" });
            await security.releaseChatAccess(grant.leaseId);
        }
        assert.ok(limit > 0);
        const headers = { "idempotency-key": "allowance-twin" };
        const before = dispatches;
        // The twin passes the pre-check; just before its reservation the
        // original runs to completion and takes the last credit.
        let original;
        beforeReservationTransaction = async () => {
            original = await call(key, body(), { headers });
        };
        const twin = await call(key, body(), { headers });
        assert.equal(original.status, 200);
        assert.equal(twin.status, 409, "the twin is answered with the original's receipt");
        assert.equal((await twin.json()).error.code, "idempotent_request_completed");
        assert.equal(dispatches - before, 1);
    });

    await t.test("a twin of a request that used up the key cap gets its receipt, not a cap refusal", async () => {
        const userId = await newUser();
        allow(userId);
        const probe = await issueKey(userId);
        assert.equal((await call(probe.key, body())).status, 200);
        const perRequest = (await reservationsFor(userId))[0].reservedCredits;
        const { key } = await issueKey(userId, { creditCap: perRequest });
        const before = dispatches;
        const twins = await Promise.all([1, 2, 3].map(() => call(key, body(), { headers: { "idempotency-key": "cap-twin" } })));
        const statuses = twins.map((r) => r.status).sort();
        assert.deepEqual(statuses, [200, 409, 409]);
        for (const response of twins.filter((r) => r.status === 409)) {
            assert.match((await response.json()).error.code, /^idempotent_request_/);
        }
        assert.equal(dispatches - before, 1);
    });

    await t.test("a slow first token keeps the reservation alive before the stream starts", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        process.env.EXTERNAL_API_HEARTBEAT_MS = "40";
        let observed = null;
        try {
            script = () => ({
                stream: new ReadableStream({
                    async start(controller) {
                        // Pretend the reservation is about to expire, then think
                        // for a while before the first part arrives.
                        const [held] = await db.chatCreditReservation.findMany({ where: { userId, status: "reserved" } });
                        await db.chatCreditReservation.update({ where: { id: held.id }, data: { expiresAt: new Date(Date.now() + 1_000) } });
                        await new Promise((r) => setTimeout(r, 400));
                        observed = (await db.chatCreditReservation.findUnique({ where: { id: held.id } })).expiresAt;
                        for (const part of [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "late" }, { type: "text-end", id: "t" }, finish("stop")]) {
                            controller.enqueue(part);
                        }
                        controller.close();
                    },
                }),
            });
            const streamed = await readSse(await call(key, body({ stream: true })));
            assert.equal(streamed.events.at(-1), "[DONE]");
        } finally {
            delete process.env.EXTERNAL_API_HEARTBEAT_MS;
            script = textScript("Hello from the fixture.");
        }
        assert.ok(observed.getTime() > Date.now() + 60_000, "the heartbeat extended the hold while waiting for the first part");
    });

    await t.test("client abort mid-stream settles as cancelled and keeps the receipt", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const controller = new AbortController();
        script = (options) =>
            streamOf(
                [
                    { type: "stream-start", warnings: [] },
                    { type: "text-start", id: "t" },
                    ...Array.from({ length: 50 }, () => ({ type: "text-delta", id: "t", delta: "word " })),
                    finish("stop"),
                ],
                { delayMs: 20, signal: options.abortSignal }
            );
        const response = await call(key, body({ stream: true }), { signal: controller.signal });
        const reader = response.body.getReader();
        await reader.read();
        controller.abort();
        await reader.cancel().catch(() => undefined);
        let reservation;
        for (let i = 0; i < 200; i += 1) {
            [reservation] = await reservationsFor(userId);
            if (reservation?.status !== "reserved") break;
            await new Promise((r) => setTimeout(r, 25));
        }
        assert.equal(reservation.outcome, "cancelled");
        assert.notEqual(reservation.status, "reserved");
        // The receipt is written after settlement and the lease release.
        let receipt;
        for (let i = 0; i < 200; i += 1) {
            receipt = await db.externalApiRequest.findUnique({ where: { reservationId: reservation.id } });
            if (receipt?.completedAt) break;
            await new Promise((r) => setTimeout(r, 25));
        }
        assert.equal(receipt.errorCode, "request_cancelled");
        script = textScript("Hello from the fixture.");
    });

    await t.test("a cancelled Korean reply is estimated with the script-aware counter, not bytes/4", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const controller = new AbortController();
        // 20 Hangul syllables: 60 bytes, so bytes/4 would say 15 tokens --
        // under the pro-rata threshold -- while the text is really ~30.
        const korean = ["안녕하세요", "반갑습니다", "오늘날씨가", "좋네요정말"];
        script = (options) =>
            streamOf(
                [
                    { type: "stream-start", warnings: [] },
                    { type: "text-start", id: "t" },
                    ...korean.map((delta) => ({ type: "text-delta", id: "t", delta })),
                    ...Array.from({ length: 100 }, () => ({ type: "text-delta", id: "t", delta: "" })),
                    finish("stop"),
                ],
                { delayMs: 15, signal: options.abortSignal }
            );
        const response = await call(key, body({ stream: true }), { signal: controller.signal });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let seen = "";
        while (!korean.every((part) => seen.includes(part))) {
            const { value, done } = await reader.read();
            if (done) break;
            seen += decoder.decode(value, { stream: true });
        }
        controller.abort();
        await reader.cancel().catch(() => undefined);
        let reservation;
        for (let i = 0; i < 200; i += 1) {
            [reservation] = await reservationsFor(userId);
            if (reservation?.status !== "reserved") break;
            await new Promise((r) => setTimeout(r, 25));
        }
        assert.equal(reservation.outcome, "cancelled");
        assert.ok(reservation.settledOutputTokens > 16, `estimated ${reservation.settledOutputTokens} output tokens`);
        script = textScript("Hello from the fixture.");
    });

    await t.test("a reply that is only reasoning is a completed, charged request", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        script = () =>
            streamOf([
                { type: "stream-start", warnings: [] },
                { type: "reasoning-start", id: "r" },
                { type: "reasoning-delta", id: "r", delta: "Thinking about the whole output limit." },
                { type: "reasoning-end", id: "r" },
                finish("length", usage(100, 64, { reasoning: 64 })),
            ]);
        const response = await call(key, body());
        assert.equal(response.status, 200);
        const json = await response.json();
        assert.equal(json.choices[0].finish_reason, "length");
        assert.equal(json.choices[0].message.content, null);
        const [reservation] = await reservationsFor(userId);
        assert.equal(reservation.outcome, "completed");
        assert.equal(reservation.status, "settled");
        assert.ok(reservation.settledCredits > 0, "reasoning the client received is charged");
        script = textScript("Hello from the fixture.");
    });

    await t.test("failures: a provider refusal costs nothing, an unknown failure is not priced at zero", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const { APICallError } = await import("ai");
        script = () =>
            streamOf([
                new APICallError({ message: "rate limited", url: "https://provider.invalid", requestBodyValues: {}, statusCode: 429, isRetryable: true }),
            ]);
        const before = dispatches;
        const refused = await call(key, body());
        assert.equal(refused.status, 502);
        assert.equal(dispatches - before, 1, "no automatic retry");
        let [reservation] = await reservationsFor(userId);
        assert.equal(reservation.outcome, "failed");
        assert.equal(reservation.settledCredits, 0);
        assert.equal(reservation.settledCostMicroUsd, 0n);

        // A provider 5xx may come after it processed the request: not proof
        // of zero spend, so the estimate stays on the provider side.
        script = () =>
            streamOf([
                new APICallError({ message: "server error", url: "https://provider.invalid", requestBodyValues: {}, statusCode: 500, isRetryable: true }),
            ]);
        assert.equal((await call(key, body())).status, 502);
        const serverError = (await reservationsFor(userId)).at(-1);
        assert.equal(serverError.outcome, "failed");
        assert.equal(serverError.settledCredits, 0, "the user is not charged for a failure");
        assert.ok(serverError.settledCostMicroUsd > 0n, "a 5xx keeps its estimated provider cost");

        script = () => streamOf([{ type: "stream-start", warnings: [] }, new Error("socket hang up")]);
        const lost = await call(key, body({ stream: true }));
        const { events, chunks } = await readSse(lost);
        assert.notEqual(events.at(-1), "[DONE]", "a failed stream never ends like a finished one");
        assert.equal(chunks.at(-1).error.code, "upstream_error");
        reservation = (await reservationsFor(userId)).at(-1);
        assert.equal(reservation.outcome, "failed");
        assert.equal(reservation.settledCredits, 0, "failed requests are not charged credits");
        assert.ok(reservation.settledCostMicroUsd > 0n, "an unknown provider outcome keeps its estimated cost");
        assert.equal(dispatches - before, 3);
        script = textScript("Hello from the fixture.");
    });

    await t.test("an expired in-flight request is reconciled at its estimate and never settled twice", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        let open;
        const gate = new Promise((r) => (open = r));
        script = () => ({
            stream: new ReadableStream({
                async start(controller) {
                    controller.enqueue({ type: "stream-start", warnings: [] });
                    await gate;
                    controller.enqueue({ type: "text-start", id: "t" });
                    controller.enqueue({ type: "text-delta", id: "t", delta: "late answer" });
                    controller.enqueue({ type: "text-end", id: "t" });
                    controller.enqueue(finish("stop"));
                    controller.close();
                },
            }),
        });
        const pending = call(key, body());
        let reservation;
        for (let i = 0; i < 200 && !reservation; i += 1) {
            [reservation] = await reservationsFor(userId);
            if (!reservation) await new Promise((r) => setTimeout(r, 10));
        }
        // As if the process had died: the reservation outlives its expiry.
        await db.chatCreditReservation.update({ where: { id: reservation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
        const { reconcileExpiredChatCreditReservations } = await import(mod("lib/chatSecurity.ts"));
        await reconcileExpiredChatCreditReservations(new Date());
        let reconciled = await db.chatCreditReservation.findUnique({ where: { id: reservation.id } });
        assert.equal(reconciled.status, "refunded");
        assert.equal(reconciled.settledCredits, 0);
        assert.ok(reconciled.settledCostMicroUsd > 0n, "an unknown provider outcome is not priced at zero");
        assert.ok(reconciled.reconciledAt);
        // The original process finishes later; its settlement must not apply again.
        open();
        const response = await pending;
        assert.equal(response.status, 200);
        const after = await db.chatCreditReservation.findUnique({ where: { id: reservation.id } });
        assert.equal(after.status, "refunded");
        assert.equal(after.settledCredits, 0);
        assert.equal(after.settledCostMicroUsd, reconciled.settledCostMicroUsd);
        script = textScript("Hello from the fixture.");
    });

    await t.test("a failure before the stream starts refunds the hold and frees the slot", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        modelSetupFails = true;
        let response;
        try {
            response = await call(key, body());
        } finally {
            modelSetupFails = false;
        }
        assert.equal(response.status, 500);
        const [reservation] = await reservationsFor(userId);
        assert.equal(reservation.status, "refunded");
        assert.equal(reservation.settledCredits, 0);
        assert.equal(await db.chatRequestLease.count({ where: { subjectKey: reservation.subjectKey } }), 0, "the concurrency slot is released");
        assert.equal((await call(key, body())).status, 200, "the account can carry on");
    });

    await t.test("a stream cancelled during reasoning still settles the reasoning it produced", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const controller = new AbortController();
        script = (options) =>
            streamOf(
                [
                    { type: "stream-start", warnings: [] },
                    { type: "reasoning-start", id: "r" },
                    ...Array.from({ length: 60 }, () => ({ type: "reasoning-delta", id: "r", delta: "thinking about the problem " })),
                    finish("stop"),
                ],
                { delayMs: 15, signal: options.abortSignal }
            );
        const response = await call(key, body({ stream: true }), { signal: controller.signal });
        const reader = response.body.getReader();
        for (let i = 0; i < 8; i += 1) await reader.read();
        controller.abort();
        await reader.cancel().catch(() => undefined);
        let reservation;
        for (let i = 0; i < 200; i += 1) {
            [reservation] = await reservationsFor(userId);
            if (reservation?.status !== "reserved") break;
            await new Promise((r) => setTimeout(r, 25));
        }
        assert.equal(reservation.outcome, "cancelled");
        assert.ok(reservation.settledOutputTokens > 16, "reasoning output is not counted as nothing");
        assert.ok(reservation.settledCredits > 0, "more than 16 output tokens earns the pro-rata charge");
        script = textScript("Hello from the fixture.");
    });

    await t.test("cache reads and reasoning are recorded once, inside the reported totals", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        script = textScript("Hello from the fixture.", usage(1000, 300, { cacheRead: 600, reasoning: 200 }));
        const response = await call(key, body());
        const json = await response.json();
        assert.equal(json.usage.prompt_tokens, 1000);
        assert.equal(json.usage.completion_tokens, 300, "reasoning is inside the output total, not added to it");
        assert.equal(json.usage.prompt_tokens_details.cached_tokens, 600);
        assert.equal(json.usage.completion_tokens_details.reasoning_tokens, 200);
        const [reservation] = await reservationsFor(userId);
        assert.equal(reservation.settledInputTokens, 1000);
        assert.equal(reservation.settledCachedInputTokens, 600);
        assert.equal(reservation.settledOutputTokens, 300);
        script = textScript("Hello from the fixture.", usage(1000, 300));
        await call(key, body());
        const uncached = (await reservationsFor(userId))[1];
        assert.ok(reservation.settledCostMicroUsd < uncached.settledCostMicroUsd, "cached input is priced at the cached rate");
        script = textScript("Hello from the fixture.");
    });

    await t.test("the operator pause stops new requests but an in-flight one still settles", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        let open;
        const gate = new Promise((r) => (open = r));
        script = () => ({
            stream: new ReadableStream({
                async start(controller) {
                    controller.enqueue({ type: "stream-start", warnings: [] });
                    await gate;
                    controller.enqueue({ type: "text-start", id: "t" });
                    controller.enqueue({ type: "text-delta", id: "t", delta: "finished anyway" });
                    controller.enqueue({ type: "text-end", id: "t" });
                    controller.enqueue(finish("stop"));
                    controller.close();
                },
            }),
        });
        const inflight = call(key, body());
        for (let i = 0; i < 200 && (await reservationsFor(userId)).length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
        await db.appSetting.upsert({ where: { key: "feature.aiChatEnabled" }, create: { key: "feature.aiChatEnabled", value: "false" }, update: { value: "false" } });
        try {
            const before = dispatches;
            assert.equal((await call(key, body())).status, 503);
            assert.equal(dispatches, before);
            open();
            const response = await inflight;
            assert.equal(response.status, 200);
            const [reservation] = await reservationsFor(userId);
            assert.equal(reservation.outcome, "completed");
            assert.equal(reservation.status, "settled");
        } finally {
            await db.appSetting.update({ where: { key: "feature.aiChatEnabled" }, data: { value: "true" } });
        }
        script = textScript("Hello from the fixture.");
    });

    await t.test("a server timeout ends the stream with an error the client can see and settles as cancelled", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        process.env.EXTERNAL_API_TIMEOUT_MS = "300";
        script = (options) =>
            streamOf(
                [
                    { type: "stream-start", warnings: [] },
                    { type: "text-start", id: "t" },
                    ...Array.from({ length: 40 }, () => ({ type: "text-delta", id: "t", delta: "slow " })),
                    finish("stop"),
                ],
                { delayMs: 50, signal: options.abortSignal }
            );
        try {
            const { events, chunks } = await readSse(await call(key, body({ stream: true })));
            assert.notEqual(events.at(-1), "[DONE]");
            assert.equal(chunks.at(-1).error.code, "upstream_timeout");
        } finally {
            delete process.env.EXTERNAL_API_TIMEOUT_MS;
        }
        let reservation;
        for (let i = 0; i < 100; i += 1) {
            [reservation] = await reservationsFor(userId);
            if (reservation?.status !== "reserved") break;
            await new Promise((r) => setTimeout(r, 20));
        }
        assert.equal(reservation.outcome, "cancelled");
        const receipt = await db.externalApiRequest.findUnique({ where: { reservationId: reservation.id } });
        assert.equal(receipt.errorCode, "upstream_timeout");
        script = textScript("Hello from the fixture.");
    });

    await t.test("missing provider usage is reported as null and settled from the reservation estimate", async () => {
        const userId = await newUser();
        allow(userId);
        const { key } = await issueKey(userId);
        const noUsage = { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } };
        script = textScript("Hello from the fixture.", noUsage);
        const response = await call(key, body());
        assert.equal(response.status, 200);
        assert.equal((await response.json()).usage, null);
        const [reservation] = await reservationsFor(userId);
        assert.equal(reservation.outcome, "completed");
        assert.ok(reservation.settledCostMicroUsd > 0n);
        assert.ok(reservation.settledOutputTokens > 0, "not zero by assumption");
        script = textScript("Hello from the fixture.");
    });

    await t.test("operator pause stops new dispatch; usage and ownership stay scoped to the key", async () => {
        const userId = await newUser();
        const other = await newUser();
        allow(userId, other);
        const { key, summary } = await issueKey(userId);
        const otherKey = await issueKey(other);
        await db.appSetting.upsert({ where: { key: "feature.aiChatEnabled" }, create: { key: "feature.aiChatEnabled", value: "false" }, update: { value: "false" } });
        const before = dispatches;
        try {
            const paused = await call(key, body());
            assert.equal(paused.status, 503);
            assert.equal((await paused.json()).error.code, "AI_CHAT_DISABLED_BY_ADMIN");
            assert.equal(dispatches, before);
        } finally {
            await db.appSetting.update({ where: { key: "feature.aiChatEnabled" }, data: { value: "true" } });
        }
        await assert.rejects(
            keys.revokeExternalApiKey({ userId, keyId: otherKey.summary.id }, { session: sessionFor(userId), request: auditRequest() }),
            (error) => error.status === 404
        );
        await assert.rejects(
            keys.updateExternalApiKey({ userId: other, keyId: summary.id, name: "stolen" }, { session: sessionFor(other), request: auditRequest() }),
            (error) => error.status === 404
        );
        assert.deepEqual(await keys.externalApiKeyUsage(otherKey.summary.id), []);
    });

    await t.test("request status lookup: own key only, by receipt id or Idempotency-Key, read only", async () => {
        process.env.EXTERNAL_API_READS_PER_MINUTE = "1000";
        const { GET: statusRoute } = await import(mod("app/api/v1/requests/status/route.ts"));
        const lookup = (key, { requestId, idempotencyKey } = {}) =>
            statusRoute(
                new Request(
                    `http://localhost/api/v1/requests/status${requestId !== undefined ? `?request_id=${encodeURIComponent(requestId)}` : ""}`,
                    { headers: { authorization: `Bearer ${key}`, ...(idempotencyKey !== undefined ? { "idempotency-key": idempotencyKey } : {}) } }
                )
            );
        const userId = await newUser();
        const stranger = await newUser();
        allow(userId, stranger);
        const { key } = await issueKey(userId);
        const sibling = await issueKey(userId);
        const foreign = await issueKey(stranger);

        const sent = await call(key, body(), { headers: { "idempotency-key": "cli-step-1" } });
        assert.equal(sent.status, 200);
        const requestId = sent.headers.get("x-request-id");
        const dispatchesBefore = dispatches;
        const reservationsBefore = (await reservationsFor(userId)).length;

        const byId = await lookup(key, { requestId });
        assert.equal(byId.status, 200);
        const byIdJson = await byId.json();
        assert.equal(byIdJson.object, "tomverse.request_status");
        assert.equal(byIdJson.request.requestId, requestId);
        assert.equal(byIdJson.request.status, "settled");
        assert.equal(byIdJson.request.outcome, "completed");
        assert.equal(byIdJson.request.protocol, "chat_completions");
        const [reservation] = await reservationsFor(userId);
        assert.equal(byIdJson.request.chargedCredits, reservation.settledCredits);
        assert.equal(byIdJson.usage_source, "server_settlement");
        assert.equal(byIdJson.output_stored, false);
        assert.ok(!JSON.stringify(byIdJson).includes("Hello from the fixture"), "no output is returned");

        const byIdem = await (await lookup(key, { idempotencyKey: "cli-step-1" })).json();
        assert.deepEqual(byIdem.request, byIdJson.request);

        // Another key of the same account, another account and no request at
        // all answer the same 404, so the lookup is no existence oracle.
        const misses = [
            await lookup(sibling.key, { requestId }),
            await lookup(sibling.key, { idempotencyKey: "cli-step-1" }),
            await lookup(foreign.key, { requestId }),
            await lookup(key, { requestId: `req_${"0".repeat(32)}` }),
            await lookup(key, { idempotencyKey: "never-sent" }),
        ];
        const missBodies = [];
        for (const miss of misses) {
            assert.equal(miss.status, 404);
            missBodies.push(await miss.json());
        }
        for (const missBody of missBodies) assert.deepEqual(missBody, missBodies[0]);
        assert.equal(missBodies[0].error.code, "request_not_found");
        assert.match(missBodies[0].error.message, /does not show it was never sent or charged/);

        // Selector errors.
        for (const [selector, code] of [
            [{}, "invalid_request_selector"],
            [{ requestId, idempotencyKey: "cli-step-1" }, "invalid_request_selector"],
            [{ requestId: "chatcmpl-123" }, "invalid_request_selector"],
            [{ idempotencyKey: "x".repeat(256) }, "invalid_idempotency_key"],
        ]) {
            const refused = await lookup(key, selector);
            assert.equal(refused.status, 400);
            assert.equal((await refused.json()).error.code, code);
        }

        // Nothing above dispatched, reserved or wrote.
        assert.equal(dispatches, dispatchesBefore);
        assert.equal((await reservationsFor(userId)).length, reservationsBefore);

        // Older than the 100 receipts /usage lists: still found by its key.
        for (let i = 0; i < 100; i += 1) assert.equal((await call(key, body())).status, 200);
        const listed = await keys.externalApiKeyUsage((await keys.listExternalApiKeys(userId)).find((k) => k.keyPrefix === key.slice(0, 12)).id, 100);
        assert.ok(!listed.some((receipt) => receipt.requestId === requestId), "pushed out of the recent list");
        assert.equal((await lookup(key, { idempotencyKey: "cli-step-1" })).status, 200);

        // A request whose client left before reading the response: the
        // client never saw x-request-id, but finds it by the key it recorded.
        const controller = new AbortController();
        script = (options) =>
            streamOf(
                [
                    { type: "stream-start", warnings: [] },
                    { type: "text-start", id: "t" },
                    ...Array.from({ length: 40 }, () => ({ type: "text-delta", id: "t", delta: "word " })),
                    finish("stop"),
                ],
                { delayMs: 20, signal: options.abortSignal }
            );
        const inFlight = call(key, body({ stream: true }), { signal: controller.signal, headers: { "idempotency-key": "cli-step-lost" } });
        const response = await inFlight;
        // While it streams it is held, with no charged amount yet.
        const held = await (await lookup(key, { idempotencyKey: "cli-step-lost" })).json();
        assert.equal(held.request.status, "held");
        assert.equal(held.request.chargedCredits, null);
        assert.ok(held.request.heldCredits > 0);
        assert.equal(held.usage_source, null);
        controller.abort();
        await response.body.cancel().catch(() => undefined);
        let settled;
        for (let i = 0; i < 200; i += 1) {
            settled = await (await lookup(key, { idempotencyKey: "cli-step-lost" })).json();
            if (settled.request.status !== "held" && settled.request.completedAt) break;
            await new Promise((r) => setTimeout(r, 25));
        }
        assert.equal(settled.request.outcome, "cancelled");
        assert.equal(typeof settled.request.chargedCredits, "number");
        script = textScript("Hello from the fixture.");

        // A revoked key cannot look anything up.
        const keyId = (await keys.listExternalApiKeys(userId)).find((k) => k.keyPrefix === key.slice(0, 12)).id;
        await keys.revokeExternalApiKey({ userId, keyId }, { session: sessionFor(userId), request: auditRequest() });
        assert.equal((await lookup(key, { requestId })).status, 401);
    });

    await t.test("database guards and account deletion", async () => {
        const userId = await newUser();
        allow(userId);
        const { key, summary } = await issueKey(userId);
        assert.equal((await call(key, body())).status, 200);
        const row = await db.externalApiKey.findUnique({ where: { id: summary.id } });
        assert.match(row.secretDigest, /^[0-9a-f]{64}$/);
        // The secret is everything after "tvk_<8>_" (base64url, which can itself contain "_").
        assert.ok(!JSON.stringify(row).includes(key.slice("tvk_00000000_".length)));
        await assert.rejects(db.externalApiKey.update({ where: { id: summary.id }, data: { secretDigest: "plain-secret" } }));
        await assert.rejects(db.externalApiKey.update({ where: { id: summary.id }, data: { creditCap: 0 } }));
        const [reservation] = await reservationsFor(userId);
        await db.user.delete({ where: { id: userId } });
        assert.equal(await db.externalApiKey.count({ where: { userId } }), 0);
        assert.equal(await db.externalApiRequest.count({ where: { userId } }), 0);
        const kept = await db.chatCreditReservation.findUnique({ where: { id: reservation.id } });
        assert.equal(kept.userId, null, "the shared ledger keeps its row, detached from the person");
    });
});
