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
        EXTERNAL_API_MODEL_IDS: MODEL_ID,
        EXTERNAL_API_ALLOWED_USER_IDS: "",
        // Every request here comes from one loopback address. The per-minute
        // request guards are their own layer; widen them so scenarios do not
        // throttle each other and the credit layer is what each one tests.
        CHAT_USER_PER_MINUTE: "1000",
        CHAT_IP_PER_MINUTE: "1000",
        EXTERNAL_API_REQUESTS_PER_MINUTE: "1000",
    });
    const floor = getSingleAccountCostCeiling();
    for (const provider of ["openai", "anthropic"]) {
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
        const userId = await newUser("Free");
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
        assert.ok(limit > 0 && limit < 200, "a small, finite Free allowance to exhaust");
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
        const perRequest = (await reservationsFor(userId))[0].reservedCredits;
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
        const receipt = await db.externalApiRequest.findUnique({ where: { reservationId: reservation.id } });
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

    await t.test("database guards and account deletion", async () => {
        const userId = await newUser();
        allow(userId);
        const { key, summary } = await issueKey(userId);
        assert.equal((await call(key, body())).status, 200);
        const row = await db.externalApiKey.findUnique({ where: { id: summary.id } });
        assert.match(row.secretDigest, /^[0-9a-f]{64}$/);
        assert.ok(!JSON.stringify(row).includes(key.split("_").at(-1)));
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
