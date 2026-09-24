import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AVAILABLE_MODELS } from "../lib/models.ts";
import { PROVIDER_API_CONFIGURATION } from "../lib/modelRegistryShared.ts";
import { resolveModelPricing } from "../lib/modelPricing.ts";
import {
    closePinnedExperiment,
    createPinnedExperiment,
    reservePinnedExperiment,
} from "../lib/pinnedDeploymentBudget.ts";
import {
    applyExperimentClose,
    classifyPinnedDeployment,
    createSerialExperimentLedger,
    decideExperimentReserve,
    pinnedBillablePromptCeiling,
    pinnedReservedInputTokens,
    PINNED_INFERENCE_MAX_RETRIES,
    quotePinnedTextCost,
    readPinnedDeploymentConfig,
    runPinnedDeployment,
    settlePinnedUsageCost,
} from "../lib/pinnedDeploymentExecution.ts";
import {
    createLivePlacement,
    matchLivePlacement,
    placementWriteData,
    readStoredPlacement,
} from "../lib/pinnedDeploymentPlacement.ts";
import { streamPinnedInference } from "../lib/pinnedDeploymentDispatch.ts";

const account = "account_internal";
const deploymentId = "dep_from_db";
const experimentId = "exp_1";
const messages = [{ role: "user", content: "hello" }];
const pricing = {
    costSource: "registry",
    reasoningTokenBilling: "billed_as_output",
    inputUsdPerMillionTokens: 0.2,
    outputUsdPerMillionTokens: 1.2,
    cacheWriteUsdPerMillionTokens: 0.25,
    maxOutputTokens: 128,
};
const loaded = {
    ok: true,
    deploymentId,
    logicalModelId: "gpt-5-6-luna",
    provider: "openai",
    contextWindowTokens: 1_050_000,
};

const enteredEnv = {
    PINNED_DEPLOYMENT_EXECUTION: "on",
    PINNED_DEPLOYMENT_ACCOUNT_ID: account,
    PINNED_DEPLOYMENT_ID: deploymentId,
    PINNED_DEPLOYMENT_EXPERIMENT_ID: experimentId,
};

const quote = quotePinnedTextCost({
    messages,
    pricing,
    contextWindowTokens: loaded.contextWindowTokens,
});
assert.equal(quote.ok, true);
const reservedMicroUsd = quote.ok ? quote.quote.reservedMicroUsd : 0;

const ports = (overrides = {}) => {
    const calls = { load: 0, pricing: 0, record: 0, transport: 0, http: 0 };
    const limit = Object.hasOwn(overrides, "limit") ? overrides.limit : 1_000_000;
    const ledger = overrides.ledger ?? createSerialExperimentLedger(limit);
    const base = {
        loadDeployment: async () => {
            calls.load += 1;
            return loaded;
        },
        resolvePricing: async () => {
            calls.pricing += 1;
            return pricing;
        },
        ledger,
        record: async () => {
            calls.record += 1;
            return { ok: true, attemptId: "attempt_1" };
        },
        transport: async (args) => {
            calls.transport += 1;
            assert.equal(args.maxRetries, 0);
            assert.equal(args.logicalModelId, "gpt-5-6-luna");
            return { started: true, pending: true, response: { kind: "stream" } };
        },
    };
    return { calls, ledger, ...base, ...overrides, ledger };
};

test("flag off and a non-target account stay on the ordinary path", async () => {
    const failing = ports();
    failing.loadDeployment = async () => { throw new Error("should not load"); };
    failing.transport = async () => { throw new Error("should not call"); };
    const off = await runPinnedDeployment({
        env: {},
        authenticatedAccountId: account,
        messages,
    }, failing);
    assert.deepEqual(off, { route: "existing", providerCalls: 0 });

    const other = await runPinnedDeployment({
        env: enteredEnv,
        authenticatedAccountId: "someone_else",
        messages,
    }, failing);
    assert.deepEqual(other, { route: "existing", providerCalls: 0 });

    const spelledOn = readPinnedDeploymentConfig({
        PINNED_DEPLOYMENT_EXECUTION: "true",
        PINNED_DEPLOYMENT_ACCOUNT_ID: account,
    });
    assert.equal(classifyPinnedDeployment(spelledOn, account), "existing");
    const blank = readPinnedDeploymentConfig({
        PINNED_DEPLOYMENT_EXECUTION: "on",
        PINNED_DEPLOYMENT_ACCOUNT_ID: " ",
    });
    assert.equal(classifyPinnedDeployment(blank, " "), "existing");
});

test("a target account with a deployment and room dispatches once and records", async () => {
    const built = ports();
    const result = await runPinnedDeployment({
        env: enteredEnv,
        authenticatedAccountId: account,
        messages,
        webSearchMode: null,
    }, built);
    assert.equal(result.route, "dispatched");
    assert.equal(result.providerCalls, 1);
    assert.equal(result.hold, "in_flight");
    assert.equal(built.calls.transport, 1);
    assert.equal(built.calls.record, 1);
    assert.equal(built.ledger.snapshot().reservedMicroUsd, reservedMicroUsd);
    assert.equal(built.ledger.snapshot().spentMicroUsd, 0);
});

test("budget, deployment, and record failures do not call a provider or the ordinary path", async () => {
    const unset = ports({ limit: null });
    unset.transport = async () => { throw new Error("provider"); };
    const noBudget = await runPinnedDeployment({
        env: enteredEnv,
        authenticatedAccountId: account,
        messages,
    }, unset);
    assert.equal(noBudget.route, "refused");
    assert.equal(noBudget.reason, "no_limit");
    assert.equal(noBudget.providerCalls, 0);

    const short = ports({ limit: 1 });
    short.transport = async () => { throw new Error("provider"); };
    const over = await runPinnedDeployment({
        env: enteredEnv,
        authenticatedAccountId: account,
        messages,
    }, short);
    assert.equal(over.route, "refused");
    assert.equal(over.reason, "over_limit");
    assert.equal(over.providerCalls, 0);
    assert.equal(short.ledger.snapshot().reservedMicroUsd, 0);

    const mismatch = ports();
    mismatch.loadDeployment = async () => ({ ok: false, reason: "deployment_mismatch" });
    mismatch.transport = async () => { throw new Error("provider"); };
    const missed = await runPinnedDeployment({
        env: enteredEnv,
        authenticatedAccountId: account,
        messages,
    }, mismatch);
    assert.equal(missed.route, "refused");
    assert.equal(missed.reason, "deployment_mismatch");
    assert.equal(missed.providerCalls, 0);

    const unrecorded = ports();
    unrecorded.record = async () => ({ ok: false });
    unrecorded.transport = async () => { throw new Error("provider"); };
    const lost = await runPinnedDeployment({
        env: enteredEnv,
        authenticatedAccountId: account,
        messages,
    }, unrecorded);
    assert.equal(lost.route, "refused");
    assert.equal(lost.reason, "record_required");
    assert.equal(lost.providerCalls, 0);
    assert.equal(unrecorded.ledger.snapshot().reservedMicroUsd, 0);
    assert.equal(unrecorded.ledger.snapshot().spentMicroUsd, 0);
    assert.equal(unrecorded.ledger.snapshot().holds[0].status, "released");
});

test("side costs and an unpriceable cap refuse before a provider call", async () => {
    const built = ports();
    built.transport = async () => { throw new Error("provider"); };
    const search = await runPinnedDeployment({
        env: enteredEnv,
        authenticatedAccountId: account,
        messages,
        webSearchMode: "auto",
    }, built);
    assert.equal(search.reason, "side_cost");
    assert.equal(search.providerCalls, 0);
    assert.equal(built.calls.load, 0);

    const attached = await runPinnedDeployment({
        env: enteredEnv,
        authenticatedAccountId: account,
        messages: [{ role: "user", content: "hello", attachments: [{}] }],
    }, built);
    assert.equal(attached.reason, "side_cost");

    const fallback = quotePinnedTextCost({
        messages,
        pricing: { ...pricing, costSource: "conservative_fallback" },
        contextWindowTokens: loaded.contextWindowTokens,
    });
    assert.equal(fallback.ok, false);
    const separate = quotePinnedTextCost({
        messages,
        pricing: { ...pricing, reasoningTokenBilling: "billed_separately" },
        contextWindowTokens: loaded.contextWindowTokens,
    });
    assert.equal(separate.ok, false);
    const noWriteRate = quotePinnedTextCost({
        messages,
        pricing: { ...pricing, cacheWriteUsdPerMillionTokens: null },
        contextWindowTokens: loaded.contextWindowTokens,
    });
    assert.equal(noWriteRate.ok, false);
});

test("concurrent reservations share one ceiling", async () => {
    const ledger = createSerialExperimentLedger(reservedMicroUsd * 10);
    let transportCalls = 0;
    const once = () => runPinnedDeployment({
        env: enteredEnv,
        authenticatedAccountId: account,
        messages,
    }, {
        ...ports({ ledger }),
        transport: async (args) => {
            transportCalls += 1;
            assert.equal(args.maxRetries, 0);
            return { started: true, pending: true };
        },
    });
    const results = await Promise.all(Array.from({ length: 20 }, once));
    const dispatched = results.filter((result) => result.route === "dispatched");
    const refused = results.filter((result) => result.reason === "over_limit");
    assert.equal(dispatched.length, 10);
    assert.equal(refused.length, 10);
    assert.equal(transportCalls, 10);
    const snapshot = ledger.snapshot();
    assert.equal(snapshot.reservedMicroUsd + snapshot.spentMicroUsd, reservedMicroUsd * 10);
    assert.ok(snapshot.reservedMicroUsd + snapshot.spentMicroUsd <= reservedMicroUsd * 10);
});

test("a thrown transport occupies the reservation and does not fall through", async () => {
    let transportCalls = 0;
    const ledger = createSerialExperimentLedger(1_000_000);
    const result = await runPinnedDeployment({
        env: enteredEnv,
        authenticatedAccountId: account,
        messages,
    }, {
        ...ports({ ledger }),
        transport: async () => {
            transportCalls += 1;
            throw new Error("429");
        },
    });
    assert.equal(transportCalls, 1);
    assert.equal(result.route, "refused");
    assert.equal(result.reason, "provider_error");
    assert.equal(result.providerCalls, 1);
    assert.notEqual(result.route, "existing");
    assert.equal(ledger.snapshot().spentMicroUsd, reservedMicroUsd);
    assert.equal(ledger.snapshot().reservedMicroUsd, 0);
    assert.equal(ledger.snapshot().holds[0].status, "occupied");
    assert.equal(PINNED_INFERENCE_MAX_RETRIES, 0);
});

const countInferenceRequests = async (maxRetries, fail) => {
    let http = 0;
    const model = createOpenAI({
        apiKey: "test",
        baseURL: "https://api.openai.com/v1",
        fetch: async () => {
            http += 1;
            return fail();
        },
    })("gpt-5.6-luna");
    const messagesForModel = [{ role: "user", content: "hello" }];
    const result = maxRetries === 0
        ? streamPinnedInference({
            model,
            messages: messagesForModel,
            maxOutputTokens: 16,
        })
        : streamText({
            model,
            messages: messagesForModel,
            maxOutputTokens: 16,
        });
    await result.text.catch(() => undefined);
    return http;
};

test("streamText sends one inference request for 429, 500, and a dropped connection", { timeout: 20_000 }, async () => {
    const failures = [
        () => new Response("no", { status: 429 }),
        () => new Response("no", { status: 500 }),
        () => { throw new TypeError("connection"); },
    ];
    for (const fail of failures) {
        assert.equal(await countInferenceRequests(0, fail), 1);
    }
    assert.equal(
        await countInferenceRequests(undefined, () => new Response("no", { status: 429 })),
        3
    );
});

test("unknown cost after dispatch is kept and a later flag change does not release it", async () => {
    const ledger = createSerialExperimentLedger(1_000_000);
    let transportCalls = 0;
    const first = await runPinnedDeployment({
        env: enteredEnv,
        authenticatedAccountId: account,
        messages,
    }, {
        ...ports({ ledger }),
        transport: async () => {
            transportCalls += 1;
            return { started: true, usage: null };
        },
    });
    assert.equal(first.hold, "occupied");
    assert.equal(ledger.snapshot().spentMicroUsd, reservedMicroUsd);
    await ledger.close({
        holdId: ledger.snapshot().holds[0].id,
        experimentId,
        outcome: "unknown",
    });
    assert.equal(ledger.snapshot().spentMicroUsd, reservedMicroUsd);

    const second = await runPinnedDeployment({
        env: { PINNED_DEPLOYMENT_EXECUTION: "off" },
        authenticatedAccountId: account,
        messages,
    }, {
        ...ports({ ledger }),
        transport: async () => { throw new Error("ordinary path is not this transport"); },
    });
    assert.equal(second.route, "existing");
    assert.equal(transportCalls, 1);
    assert.equal(ledger.snapshot().spentMicroUsd, reservedMicroUsd);
});

test("a confirmed non-start releases and a short measurement keeps the reservation", async () => {
    const released = createSerialExperimentLedger(1_000_000);
    const notStarted = await runPinnedDeployment({
        env: enteredEnv,
        authenticatedAccountId: account,
        messages,
    }, {
        ...ports({ ledger: released }),
        transport: async () => ({ started: false }),
    });
    assert.equal(notStarted.route, "refused");
    assert.equal(notStarted.reason, "not_started");
    assert.equal(notStarted.providerCalls, 0);
    assert.equal(released.snapshot().reservedMicroUsd, 0);
    assert.equal(released.snapshot().spentMicroUsd, 0);
    assert.equal(released.snapshot().holds[0].status, "released");

    const usage = { inputTokens: 4, outputTokens: 6, cacheWriteTokens: 0 };
    const actual = settlePinnedUsageCost(pricing, usage);
    const settled = createSerialExperimentLedger(1_000_000);
    const done = await runPinnedDeployment({
        env: enteredEnv,
        authenticatedAccountId: account,
        messages,
    }, {
        ...ports({ ledger: settled }),
        transport: async () => ({ started: true, usage }),
    });
    assert.equal(done.hold, "settled");
    assert.equal(settled.snapshot().spentMicroUsd, reservedMicroUsd);
    assert.equal(settled.snapshot().reservedMicroUsd, 0);
    assert.ok(actual < reservedMicroUsd);
    assert.equal(
        settlePinnedUsageCost({ ...pricing, cacheWriteUsdPerMillionTokens: null }, usage),
        null
    );

    const shortfall = applyExperimentClose(
        { spentMicroUsd: 0, reservedMicroUsd: 10, limitMicroUsd: 100 },
        { status: "held", reservedMicroUsd: 10, experimentId },
        { experimentId, outcome: "usage", actualMicroUsd: 4 }
    );
    assert.equal(shortfall.ok, true);
    if (!shortfall.ok) return;
    assert.equal(shortfall.spentMicroUsd, 10);
    assert.equal(shortfall.settledMicroUsd, 4);
    assert.equal(shortfall.status, "settled");

    const overrun = applyExperimentClose(
        { spentMicroUsd: 0, reservedMicroUsd: 10, limitMicroUsd: 10 },
        { status: "held", reservedMicroUsd: 10, experimentId },
        { experimentId, outcome: "usage", actualMicroUsd: 25 }
    );
    assert.equal(overrun.ok, true);
    if (!overrun.ok) return;
    assert.equal(overrun.spentMicroUsd, 25);
    assert.equal(overrun.settledMicroUsd, 25);
    assert.equal(overrun.status, "settled");
});

test("the reserve predicate counts in-flight cost and rejects a missing limit", () => {
    assert.deepEqual(
        decideExperimentReserve({ spentMicroUsd: 40, reservedMicroUsd: 60, incomingMicroUsd: 0, limitMicroUsd: 100 }),
        { ok: true }
    );
    assert.equal(
        decideExperimentReserve({
            spentMicroUsd: 40,
            reservedMicroUsd: 60,
            incomingMicroUsd: 1,
            limitMicroUsd: 100,
        }).reason,
        "over_limit"
    );
    assert.equal(
        decideExperimentReserve({
            spentMicroUsd: 0,
            reservedMicroUsd: 0,
            incomingMicroUsd: 1,
            limitMicroUsd: null,
        }).reason,
        "no_limit"
    );
});

test("the live catalogue placement is the stored row only when it matches the client", async () => {
    const luna = AVAILABLE_MODELS.find((model) => model.id === "gpt-5-6-luna");
    const endpoint = PROVIDER_API_CONFIGURATION.openai;
    const claim = {
        logicalModelId: luna.id,
        gatewayProvider: luna.provider,
        servingProvider: luna.provider,
        endpointUrl: endpoint.baseUrl,
        upstreamDeploymentName: luna.apiModel,
    };
    const matched = matchLivePlacement(claim);
    assert.equal(matched.ok, true);
    assert.equal(matched.endpointUrl, "https://api.openai.com/v1");
    assert.equal(matchLivePlacement({ ...claim, endpointUrl: "https://example.invalid" }).ok, false);
    assert.equal(matchLivePlacement({ ...claim, servingProvider: "azure" }).ok, false);
    assert.equal(matchLivePlacement({ ...claim, upstreamDeploymentName: "other" }).ok, false);

    const writes = [];
    const created = await createLivePlacement({
        providerEndpoint: {
            create: async (args) => {
                writes.push(args.data);
                return { id: "endpoint_from_db" };
            },
        },
        modelDeployment: {
            create: async (args) => {
                writes.push(args.data);
                return { id: "deployment_from_db" };
            },
        },
    }, claim);
    assert.equal(created.deploymentId, "deployment_from_db");
    assert.equal(Object.hasOwn(writes[0], "id"), false);
    assert.equal(Object.hasOwn(writes[1], "id"), false);
    assert.equal(writes[0].enabled, false);
    assert.equal(writes[1].enabled, false);
    assert.equal(writes[1].providerEndpointId, "endpoint_from_db");
    const shaped = placementWriteData(matched, "endpoint_from_db");
    assert.equal(Object.hasOwn(shaped.deployment, "id"), false);

    const untouched = { providerEndpoint: { create: async () => { throw new Error("wrote"); } }, modelDeployment: { create: async () => { throw new Error("wrote"); } } };
    const rejected = await createLivePlacement(untouched, { ...claim, endpointUrl: "https://example.invalid" });
    assert.equal(rejected.ok, false);

    let queried = null;
    const stored = await readStoredPlacement({
        modelDeployment: {
            findUnique: async (args) => {
                queried = args.where.id;
                return {
                    id: "deployment_from_db",
                    logicalModelId: luna.id,
                    upstreamDeploymentName: luna.apiModel,
                    providerEndpointId: "endpoint_from_db",
                };
            },
        },
        providerEndpoint: {
            findUnique: async () => ({
                id: "endpoint_from_db",
                gatewayProvider: "openai",
                servingProvider: "openai",
                endpointUrl: endpoint.baseUrl,
            }),
        },
    }, "deployment_from_db");
    assert.equal(queried, "deployment_from_db");
    assert.equal(stored.deploymentId, "deployment_from_db");
    assert.equal(matchLivePlacement(stored.claim).ok, true);
});

test("the experiment row stores the caller limit and locks before it reserves", async () => {
    let queries = 0;
    const absent = await createPinnedExperiment({
        $queryRaw: async () => { queries += 1; return [{ id: "unused" }]; },
        $transaction: async (work) => work({}),
    }, 0);
    assert.equal(absent.ok, false);
    assert.equal(queries, 0);

    const created = await createPinnedExperiment({
        $queryRaw: async (_strings, ...values) => {
            assert.equal(values.includes(BigInt(100)), true);
            assert.equal(values.includes(BigInt(5_000_000)), false);
            return [{ id: "exp_from_db" }];
        },
        $transaction: async (work) => work({}),
    }, 100);
    assert.equal(created.experimentId, "exp_from_db");

    const calls = [];
    const tx = {
        $queryRaw: async (strings) => {
            const text = strings.join(" ");
            calls.push(text);
            if (text.includes("INSERT")) return [{ id: "hold_from_db" }];
            if (text.includes("PinnedDeploymentExperimentHold")) {
                return [{ status: "held", reservedMicroUsd: 10n, experimentId }];
            }
            return [{ limitMicroUsd: 100n, spentMicroUsd: 0n, reservedMicroUsd: 40n }];
        },
        $executeRaw: async (strings) => {
            calls.push(strings.join(" "));
            return 1;
        },
    };
    const db = { $transaction: async (work) => work(tx), $queryRaw: async () => [] };
    const reserved = await reservePinnedExperiment(db, {
        experimentId,
        amountMicroUsd: 60,
        deploymentId,
        logicalModelId: "gpt-5-6-luna",
    });
    assert.equal(reserved.holdId, "hold_from_db");
    assert.ok(calls[0].includes("FOR UPDATE"));
    assert.ok(calls[1].includes("INSERT"));
    calls.length = 0;
    const denied = await reservePinnedExperiment(db, {
        experimentId,
        amountMicroUsd: 61,
        deploymentId,
        logicalModelId: "gpt-5-6-luna",
    });
    assert.equal(denied.reason, "over_limit");
    assert.equal(calls.some((call) => call.includes("INSERT")), false);

    const closed = await closePinnedExperiment(db, {
        holdId: "hold_from_db",
        experimentId,
        outcome: "unknown",
    });
    assert.equal(closed.ok, true);
});

test("the ordinary chat retry line is unchanged and this path does not borrow the held refusals", () => {
    const chat = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
    const pinned = readFileSync(new URL("../lib/pinnedDeploymentRoute.ts", import.meta.url), "utf8");
    const execution = readFileSync(new URL("../lib/pinnedDeploymentExecution.ts", import.meta.url), "utf8");
    const budget = readFileSync(new URL("../lib/pinnedDeploymentBudget.ts", import.meta.url), "utf8");
    const placement = readFileSync(new URL("../lib/pinnedDeploymentPlacement.ts", import.meta.url), "utf8");
    assert.match(chat, /maxRetries: modelConfig\.provider === "zhipu" \? 0 : undefined/);
    assert.match(chat, /authenticatedAccountId: session\?\.user\?\.id \?\? null/);
    const entrance = chat.indexOf("await enterPinnedDeploymentChat");
    const stream = chat.indexOf("streamText({");
    assert.ok(entrance > 0 && entrance < stream);
    const block = chat.slice(entrance, entrance + 900);
    assert.match(block, /route === "refused"/);
    assert.match(block, /route === "dispatched"/);
    assert.doesNotMatch(block, /streamText/);
    const dispatch = readFileSync(new URL("../lib/pinnedDeploymentDispatch.ts", import.meta.url), "utf8");
    for (const source of [pinned, execution, budget, placement, dispatch]) {
        assert.equal(source.includes("admitCanaryObservation"), false);
        assert.equal(source.includes("routingHeldDecisions"), false);
        assert.equal(source.includes("decideFallback"), false);
        assert.equal(source.includes("catalogueHostRefusalCode"), false);
        assert.equal(source.includes("5000000"), false);
        assert.equal(source.includes("US$5"), false);
    }
    assert.match(pinned, /streamPinnedInference/);
    assert.match(pinned, /estimatedPromptTokens: promptTokens/);
    assert.match(pinned, /settlePinnedUsageCost/);
    const entranceBody = pinned.slice(pinned.indexOf("export const enterPinnedDeploymentChat"));
    assert.match(entranceBody, /dispatched \?\?= recordDispatched\(instrumentation\)/);
    assert.match(entranceBody, /await recordNotDispatched\(instrumentation, reason, "application"\)/);
    const finishAt = entranceBody.indexOf("onFinish:");
    const errorAt = entranceBody.indexOf("onError:");
    assert.ok(finishAt > 0 && errorAt > finishAt);
    const finishBlock = entranceBody.slice(finishAt, errorAt);
    const errorBlock = entranceBody.slice(errorAt);
    assert.match(finishBlock, /await ensureDispatched\(\)/);
    assert.match(finishBlock, /finally \{[\s\S]*completeInstrumentedDispatch/);
    assert.match(finishBlock, /outcome: "succeeded"/);
    assert.match(errorBlock, /await ensureDispatched\(\)/);
    assert.match(errorBlock, /finally \{[\s\S]*completeInstrumentedDispatch/);
    assert.match(errorBlock, /outcome: "failed_pre_token"/);
    assert.match(execution, /Math\.max\(request\.actualMicroUsd, hold\.reservedMicroUsd\)/);
    assert.match(pinned, /outcome: "unknown"/);
    assert.doesNotMatch(pinned, /stepCountIs/);
    assert.match(dispatch, /maxRetries: PINNED_INFERENCE_MAX_RETRIES/);
    assert.doesNotMatch(dispatch, /stepCountIs/);
    assert.equal(dispatch.includes("maxRetries: inference"), false);
    assert.match(chat, /attemptDispatchOptions\(plan\)/);
});

test("the default catalogue model has a confirmed cap this path can reserve", () => {
    const luna = AVAILABLE_MODELS.find((model) => model.id === "gpt-5-6-luna");
    const resolved = resolveModelPricing(luna);
    assert.equal(resolved.costSource.startsWith("conservative_fallback"), false);
    assert.equal(resolved.reasoningTokenBilling, "billed_as_output");
    assert.equal(typeof resolved.cacheWriteUsdPerMillionTokens, "number");
    const priced = quotePinnedTextCost({
        messages,
        pricing: {
            costSource: resolved.costSource,
            reasoningTokenBilling: resolved.reasoningTokenBilling,
            inputUsdPerMillionTokens: resolved.inputUsdPerMillionTokens,
            outputUsdPerMillionTokens: resolved.outputUsdPerMillionTokens,
            cacheWriteUsdPerMillionTokens: resolved.cacheWriteUsdPerMillionTokens,
            maxOutputTokens: resolved.maxOutputTokens,
        },
        contextWindowTokens: luna.contextWindowTokens,
    });
    assert.equal(priced.ok, true);
    assert.equal(priced.quote.maxOutputTokens, resolved.maxOutputTokens);
    assert.notEqual(priced.quote.maxOutputTokens, resolved.reservationOutputTokens);
    assert.equal(priced.quote.reservedInputTokens, pinnedReservedInputTokens(messages));
    assert.ok(priced.quote.reservedInputTokens > priced.quote.estimatedInputTokens);
});

const ratesFrom = (resolved) => ({
    costSource: resolved.costSource,
    reasoningTokenBilling: resolved.reasoningTokenBilling,
    inputUsdPerMillionTokens: resolved.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: resolved.outputUsdPerMillionTokens,
    cacheWriteUsdPerMillionTokens: resolved.cacheWriteUsdPerMillionTokens,
    maxOutputTokens: 128,
});

test("a prompt that can cross a price tier reserves and settles the higher rate", async () => {
    const luna = AVAILABLE_MODELS.find((model) => model.id === "gpt-5-6-luna");
    const longText = "x".repeat(300_000);
    const longMessages = [{ role: "user", content: longText }];
    const ceiling = pinnedBillablePromptCeiling(longMessages);
    const reservedInput = pinnedReservedInputTokens(longMessages);
    assert.ok(ceiling > 272_000);
    assert.equal(reservedInput, ceiling);
    const short = resolveModelPricing(luna, { estimatedPromptTokens: 1 });
    const long = resolveModelPricing(luna, { estimatedPromptTokens: reservedInput });
    assert.equal(long.costSource, "registry_long_context");
    assert.equal(long.inputUsdPerMillionTokens, short.inputUsdPerMillionTokens * 2);
    assert.equal(long.outputUsdPerMillionTokens, short.outputUsdPerMillionTokens * 1.5);
    assert.equal(long.cacheWriteUsdPerMillionTokens, short.cacheWriteUsdPerMillionTokens * 2);

    const atLongRate = quotePinnedTextCost({
        messages: longMessages,
        pricing: ratesFrom(long),
        contextWindowTokens: luna.contextWindowTokens,
        billableInputTokens: reservedInput,
    });
    const atShortRate = quotePinnedTextCost({
        messages: longMessages,
        pricing: ratesFrom(short),
        contextWindowTokens: luna.contextWindowTokens,
        billableInputTokens: reservedInput,
    });
    assert.equal(atLongRate.ok, true);
    assert.equal(atShortRate.ok, true);
    assert.ok(atLongRate.quote.reservedMicroUsd > atShortRate.quote.reservedMicroUsd);

    const usage = { inputTokens: 300_000, outputTokens: 10, cacheWriteTokens: 0 };
    const shortActual = settlePinnedUsageCost(ratesFrom(short), usage);
    const longActual = settlePinnedUsageCost(ratesFrom(long), usage);
    assert.ok(longActual > shortActual);
    const ledger = createSerialExperimentLedger(1_000_000);
    const done = await runPinnedDeployment({
        env: enteredEnv,
        authenticatedAccountId: account,
        messages,
    }, {
        ...ports({ ledger }),
        resolvePricing: async (_modelId, promptTokens) => (
            promptTokens > 272_000 ? ratesFrom(long) : ratesFrom(short)
        ),
        transport: async () => ({ started: true, usage }),
    });
    assert.equal(done.hold, "settled");
    assert.equal(ledger.snapshot().spentMicroUsd, longActual);
    assert.ok(longActual > reservedMicroUsd);
});
