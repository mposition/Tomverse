import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
    applyAutoExploration,
} from "../lib/autoExploration.ts";
import {
    autoExplorationAvailable,
    autoExplorationEnabledFromValue,
    autoExplorationKillSwitchEngaged,
    AUTO_EXPLORATION_FLAG_KEY,
    AUTO_EXPLORATION_KILL_SWITCH_ENV,
} from "../lib/autoExplorationAccess.ts";
import { rankCandidates } from "../lib/routerSelection.ts";
import { selectAutoModel } from "../lib/autoModelSelection.ts";
import { AVAILABLE_MODELS } from "../lib/models.ts";

const cell = { qualityBand: 1, qualityCi95Lower: null, evidenceRef: null };

test("the exploration tie is the group model id has not split", () => {
    const ranking = rankCandidates(
        [
            { modelId: "b-model", cell },
            { modelId: "a-model", cell },
        ],
        {}
    );
    assert.deepEqual(
        ranking.ranked.map((candidate) => candidate.modelId),
        ["a-model", "b-model"]
    );
    assert.deepEqual(ranking.tiedWithTopModelIds, ["a-model", "b-model"]);
});

test("a session seed stays on one model and a different credit price stays out", () => {
    const rankedModelIds = ["alpha", "beta", "gamma"];
    const tiedModelIds = ["alpha", "beta", "gamma"];
    const billedCreditsByModelId = { alpha: 4, beta: 4, gamma: 8 };
    const first = applyAutoExploration({
        rankedModelIds,
        tiedModelIds,
        billedCreditsByModelId,
        enabled: true,
        conversationId: "conv_same",
    });
    const second = applyAutoExploration({
        rankedModelIds,
        tiedModelIds,
        billedCreditsByModelId,
        enabled: true,
        conversationId: "conv_same",
    });
    assert.equal(first.allocationMode, "explore_bounded");
    assert.equal(first.allocationSeedGrain, "session");
    assert.equal(second.chosenModelId, first.chosenModelId);
    assert.notEqual(first.chosenModelId, "gamma");
    assert.deepEqual(first.spreadModelIds, ["alpha", "beta"]);
    assert.equal(first.allocationSeedGrain === "request", false);
});

test("no conversation id, a disabled flag, and a one-model spread stay on the sorted top", () => {
    const base = {
        rankedModelIds: ["alpha", "beta"],
        tiedModelIds: ["alpha", "beta"],
        billedCreditsByModelId: { alpha: 4, beta: 4 },
    };
    for (const input of [
        { ...base, enabled: true, conversationId: null },
        { ...base, enabled: true, conversationId: "   " },
        { ...base, enabled: false, conversationId: "conv_same" },
        {
            ...base,
            billedCreditsByModelId: { alpha: 4, beta: 8 },
            enabled: true,
            conversationId: "conv_same",
        },
    ]) {
        const result = applyAutoExploration(input);
        assert.equal(result.chosenModelId, "alpha");
        assert.equal(result.allocationMode, "deterministic");
        assert.equal(result.allocationSeedGrain, null);
    }
});

test("the flag is off unless the stored value is exactly true and the kill switch is empty", () => {
    assert.equal(AUTO_EXPLORATION_FLAG_KEY, "feature.autoExplorationEnabled");
    assert.equal(AUTO_EXPLORATION_KILL_SWITCH_ENV, "AUTO_EXPLORATION_KILL_SWITCH");
    assert.equal(autoExplorationEnabledFromValue("true"), true);
    assert.equal(autoExplorationEnabledFromValue("TRUE"), false);
    assert.equal(autoExplorationEnabledFromValue(undefined), false);
    assert.equal(autoExplorationKillSwitchEngaged({}), false);
    assert.equal(
        autoExplorationKillSwitchEngaged({ AUTO_EXPLORATION_KILL_SWITCH: "off" }),
        true
    );
    assert.equal(
        autoExplorationAvailable({
            storedFlagValue: "true",
            env: { AUTO_EXPLORATION_KILL_SWITCH: "1" },
        }),
        false
    );
});

test("the settings reader repeats the flag literals and does not import them", () => {
    const source = readFileSync(join(import.meta.dirname, "../lib/appSettings.ts"), "utf8");
    assert.equal(source.includes('from "@/lib/autoExplorationAccess"'), false);
    assert.match(
        source,
        /const AUTO_EXPLORATION_FLAG_KEY = "feature\.autoExplorationEnabled"/
    );
    assert.match(source, /process\.env\.AUTO_EXPLORATION_KILL_SWITCH/);
    assert.match(source, /row\?\.value === "true"/);
});

const ready = { ready: true, outstanding: [], problems: [] };
const cohortConfig = {
    killSwitch: false,
    rolloutPercent: 100,
    salt: "cohort-2026-08",
    eligiblePlans: ["Pro", "Max"],
};

test("Auto exploration does not move a manual turn or a turn with the flag off", () => {
    const shared = {
        requestedModelId: "gpt-5-6-luna",
        productKey: "chat",
        subjectKey: "user_abc",
        isGuest: false,
        plan: "Pro",
        attachmentsUnmeasurable: false,
        text: "이 문장을 영어로 번역해 주세요.",
        attachments: [],
        webSearchRequested: false,
        models: AVAILABLE_MODELS,
        reservedInputTokens: 1_200,
        requestOutputCapTokens: 4_000,
        cohortConfig,
        readiness: ready,
        searchBackendReadiness: { tavily: false, perplexity: false },
    };
    const off = selectAutoModel({
        ...shared,
        conversation: {
            selectionMode: "auto",
            routerModelId: null,
            routerChallengerTurns: 0,
        },
    });
    const flaggedWithoutSeed = selectAutoModel({
        ...shared,
        explorationEnabled: true,
        conversationId: null,
        conversation: {
            selectionMode: "auto",
            routerModelId: null,
            routerChallengerTurns: 0,
        },
    });
    const manual = selectAutoModel({
        ...shared,
        explorationEnabled: true,
        conversationId: "conv_manual",
        conversation: {
            selectionMode: "manual",
            routerModelId: null,
            routerChallengerTurns: 0,
        },
    });
    assert.equal(off.routed, true);
    assert.equal(off.record.allocationMode, "deterministic");
    assert.equal(off.record.allocationSeedGrain, null);
    assert.equal(flaggedWithoutSeed.routed, true);
    assert.equal(flaggedWithoutSeed.modelId, off.modelId);
    assert.equal(flaggedWithoutSeed.record.allocationMode, "deterministic");
    assert.equal(manual.routed, false);
    assert.equal(manual.reason, "conversation_is_manual");
    assert.equal(manual.fallbackModelId, "gpt-5-6-luna");
});

test("the same conversation id keeps the same Auto answer while exploration is on", () => {
    const shared = {
        requestedModelId: "gpt-5-6-luna",
        productKey: "chat",
        subjectKey: "user_abc",
        isGuest: false,
        plan: "Pro",
        attachmentsUnmeasurable: false,
        text: "Summarise this in one sentence.",
        attachments: [],
        webSearchRequested: false,
        models: AVAILABLE_MODELS,
        reservedInputTokens: 1_200,
        requestOutputCapTokens: 4_000,
        cohortConfig,
        readiness: ready,
        explorationEnabled: true,
        conversationId: "conv_stable",
        searchBackendReadiness: { tavily: false, perplexity: false },
        conversation: {
            selectionMode: "auto",
            routerModelId: null,
            routerChallengerTurns: 0,
        },
    };
    const first = selectAutoModel(shared);
    const second = selectAutoModel(shared);
    assert.equal(first.routed, true);
    assert.equal(second.routed, true);
    assert.equal(second.modelId, first.modelId);
    if (first.record.allocationMode === "explore_bounded") {
        assert.equal(first.record.allocationSeedGrain, "session");
        assert.equal(first.stickyMemoryModelId !== undefined, true);
    }
});
