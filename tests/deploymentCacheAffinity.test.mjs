import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    CACHE_WINDOW_STATES,
    PROMPT_CACHE_SUPPORT_STATES,
    cacheAffinityProblems,
    cacheWindowState,
    promptCacheCapabilityProblems,
} from "../lib/deploymentCacheAffinity.ts";

/**
 * What a deployment's cache is known to do, and where a conversation lands.
 *
 * The property these hold is that nothing is claimed without a verification
 * behind it: an unchecked deployment carries no figures, a verified one names
 * when and what, and the window answer is a comparison of clocks rather than a
 * prediction about a prefix nothing here records.
 */

const migration = () =>
    readFileSync(
        new URL(
            "../prisma/migrations/20260923220000_deployment_cache_affinity_dark/migration.sql",
            import.meta.url
        ),
        "utf8"
    );

const verifiedAt = new Date("2026-09-23T00:00:00.000Z");

const capability = (overrides = {}) => ({
    promptCacheSupport: "unproven",
    ...overrides,
});

const verified = (overrides = {}) =>
    capability({
        promptCacheSupport: "verified_explicit",
        promptCacheTtlSeconds: 300,
        promptCacheVerifiedAt: verifiedAt,
        promptCacheEvidenceRef: "docs/policy/anthropic-prompt-caching.md",
        ...overrides,
    });

test("an unproven deployment carries no figures and no verification", () => {
    // A number beside `unproven` is one nobody can say the origin of, and it
    // would be read as measured.
    assert.deepEqual(promptCacheCapabilityProblems(capability()), []);
    assert.deepEqual(
        promptCacheCapabilityProblems(capability({ promptCacheTtlSeconds: 300 })),
        ["an unproven cache has no measured figures"]
    );
    assert.deepEqual(
        promptCacheCapabilityProblems(
            capability({ promptCacheVerifiedAt: verifiedAt })
        ),
        ["an unproven cache has no verification"]
    );
});

test("a verified cache says when it was verified and names its evidence", () => {
    assert.deepEqual(promptCacheCapabilityProblems(verified()), []);
    assert.deepEqual(
        promptCacheCapabilityProblems(
            verified({ promptCacheVerifiedAt: null, promptCacheEvidenceRef: "   " })
        ),
        [
            "a verified cache says when it was verified",
            "a verified cache names its evidence",
        ]
    );
});

test("a cache found absent has no window, and one found present must have one", () => {
    // A window for a cache that does not exist is a contradiction; a cache
    // with no window cannot be aged and would be believed forever.
    assert.deepEqual(
        promptCacheCapabilityProblems(
            verified({ promptCacheSupport: "verified_absent", promptCacheTtlSeconds: null })
        ),
        []
    );
    assert.deepEqual(
        promptCacheCapabilityProblems(
            verified({ promptCacheSupport: "verified_absent" })
        ),
        ["a cache found absent has no window"]
    );
    assert.deepEqual(
        promptCacheCapabilityProblems(verified({ promptCacheTtlSeconds: null })),
        ["a verified cache says how long it holds"]
    );
});

test("the figures are sane", () => {
    // Zero is present and wrong, which is a different complaint from absent.
    assert.deepEqual(promptCacheCapabilityProblems(verified({ promptCacheTtlSeconds: 0 })), [
        "a cache window is longer than nothing",
    ]);
    assert.deepEqual(
        promptCacheCapabilityProblems(verified({ promptCacheMinPrefixTokens: -1 })),
        ["a minimum prefix is not negative"]
    );
    assert.deepEqual(
        promptCacheCapabilityProblems(capability({ promptCacheSupport: "maybe" })),
        ['unknown prompt cache support "maybe"']
    );
});

test("the two verified-present states stay apart", () => {
    // One is a provider caching on its own; the other needs a marker and
    // charges a premium for the write. A ranking that folded them would be
    // assuming a marker either is or is not needed.
    assert.deepEqual(
        [...PROMPT_CACHE_SUPPORT_STATES],
        ["unproven", "verified_absent", "verified_automatic", "verified_explicit"]
    );
});

test("an affinity names all three things it is about", () => {
    const ok = {
        conversationId: "conv_1",
        logicalModelId: "gpt-5-6-luna",
        modelDeploymentId: "dep_1",
        servedTurns: 1,
    };
    assert.deepEqual(cacheAffinityProblems(ok), []);
    assert.deepEqual(cacheAffinityProblems({ ...ok, conversationId: " " }), [
        "an affinity names the conversation it is about",
    ]);
    assert.deepEqual(cacheAffinityProblems({ ...ok, logicalModelId: "" }), [
        "an affinity names the model the person chose",
    ]);
    assert.deepEqual(cacheAffinityProblems({ ...ok, modelDeploymentId: "" }), [
        "an affinity names the deployment that served it",
    ]);
    // A row exists because a turn landed somewhere.
    assert.deepEqual(cacheAffinityProblems({ ...ok, servedTurns: 0 }), [
        "an affinity counts at least the turn that created it",
    ]);
});

test("the window answer abstains wherever nothing is known", () => {
    const now = new Date("2026-09-23T00:05:00.000Z");
    // Nobody checked the deployment.
    assert.equal(
        cacheWindowState({ promptCacheSupport: "unproven", lastServedAt: verifiedAt, now }),
        "unproven"
    );
    // Checked, and there is no cache. That is a finding, not an abstention.
    assert.equal(
        cacheWindowState({
            promptCacheSupport: "verified_absent",
            lastServedAt: verifiedAt,
            now,
        }),
        "no_cache_here"
    );
    // Verified present, but the row has no window. Refused at write time, so
    // reaching here means the row predates the constraint; the honest answer
    // is that nothing is known, not a window of zero.
    assert.equal(
        cacheWindowState({ promptCacheSupport: "verified_explicit", lastServedAt: verifiedAt, now }),
        "unproven"
    );
    // A serve in the future is a clock disagreement, not a fresh cache.
    assert.equal(
        cacheWindowState({
            promptCacheSupport: "verified_explicit",
            promptCacheTtlSeconds: 300,
            lastServedAt: new Date("2026-09-23T01:00:00.000Z"),
            now,
        }),
        "unproven"
    );
});

test("the window answer is a comparison of two clocks", () => {
    const base = {
        promptCacheSupport: "verified_automatic",
        promptCacheTtlSeconds: 300,
    };
    assert.equal(cacheWindowState({ ...base, now: verifiedAt }), "never_served");
    assert.equal(
        cacheWindowState({
            ...base,
            lastServedAt: verifiedAt,
            now: new Date("2026-09-23T00:05:00.000Z"),
        }),
        "within_ttl"
    );
    assert.equal(
        cacheWindowState({
            ...base,
            lastServedAt: verifiedAt,
            now: new Date("2026-09-23T00:05:00.001Z"),
        }),
        "past_ttl"
    );
    assert.deepEqual(
        [...CACHE_WINDOW_STATES],
        ["unproven", "no_cache_here", "never_served", "within_ttl", "past_ttl"]
    );
});

test("the database holds the same rules", () => {
    const sql = migration();
    assert.match(sql, /ModelDeployment_promptCacheSupport_check/);
    assert.match(sql, /ModelDeployment_prompt_cache_figures_sane_check/);
    assert.match(sql, /ModelDeployment_prompt_cache_evidence_check/);
    assert.match(sql, /DeploymentCacheAffinity_servedTurns_positive_check/);
    // One row per conversation and logical model: a person can switch models
    // inside one conversation, and a single row would have the second
    // overwrite the first and then report it as the place to return to.
    assert.match(
        sql,
        /CREATE UNIQUE INDEX "DeploymentCacheAffinity_conversationId_logicalModelId_key"/
    );
    // Cascade on both sides, deliberately rather than by default.
    assert.match(
        sql,
        /FOREIGN KEY \("conversationId"\)[\s\S]{0,120}?ON DELETE CASCADE/
    );
    assert.match(
        sql,
        /FOREIGN KEY \("modelDeploymentId"\)[\s\S]{0,120}?ON DELETE CASCADE/
    );
});

test("no prefix, and no digest of one, is stored", () => {
    // The reason the window answer is not a hit prediction. A digest would
    // sharpen it and is derived from what the person wrote; it also confirms a
    // guess, since a candidate prefix can be tested against it.
    const statements = migration()
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
    for (const forbidden of ["prefixDigest", "prefixHash", "promptDigest", "promptHash"]) {
        assert.ok(!statements.includes(forbidden), `${forbidden} is absent`);
    }
});

test("the marker decision is left where it already lives", () => {
    // A dispatcher consulting a capability column instead of
    // lib/anthropicPromptCaching.ts would be a second answer to the same
    // question, and the two would drift without either saying so.
    const module = readFileSync(
        new URL("../lib/deploymentCacheAffinity.ts", import.meta.url),
        "utf8"
    );
    assert.match(module, /lib\/anthropicPromptCaching\.ts/);
    // The marker travels in providerOptions. Naming cache_control in prose is
    // how this module points at the decision it does not take; building one
    // would be it taking that decision.
    assert.ok(
        !module.includes("providerOptions"),
        "this module does not build provider options"
    );
});
