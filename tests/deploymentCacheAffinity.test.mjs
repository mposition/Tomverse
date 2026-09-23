import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
    // Present-but-blank counts: the constraint requires the column to be
    // NULL here, so accepting an empty string would pass a row the database
    // refuses.
    for (const evidence of ["", " ", "\t"]) {
        assert.deepEqual(
            promptCacheCapabilityProblems(
                capability({ promptCacheEvidenceRef: evidence })
            ),
            ["an unproven cache has no verification"],
            JSON.stringify(evidence)
        );
    }
});

test("blank means the same six characters on both sides", () => {
    // `String.trim()` strips every Unicode space and PostgreSQL's `btrim`
    // strips only U+0020, so a tab-only reference was accepted by the
    // constraint and refused here. Both now name one character class.
    for (const evidence of [" ", "\t", "\n", "\r", "\f", "\v"]) {
        assert.deepEqual(
            promptCacheCapabilityProblems(verified({ promptCacheEvidenceRef: evidence })),
            ["a verified cache names its evidence"],
            JSON.stringify(evidence)
        );
    }
    // A non-breaking space is a character in both, not whitespace.
    assert.deepEqual(
        promptCacheCapabilityProblems(verified({ promptCacheEvidenceRef: "\u00a0" })),
        []
    );
    const sql = migration();
    assert.match(sql, /"promptCacheEvidenceRef" ~ E'\[\^ \\\\t\\\\n\\\\r\\\\f\\\\v\]'/);
    const statements = sql
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
    assert.ok(
        !statements.includes("btrim"),
        "btrim would be the other definition"
    );
    // A reference, not a transcript.
    assert.match(sql, /ModelDeployment_promptCacheEvidenceRef_length_check/);
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
    // Checked, and there is no cache. That is a finding, not an abstention,
    // and only the state that records the finding may produce it.
    assert.equal(
        cacheWindowState({
            promptCacheSupport: "verified_absent",
            lastServedAt: verifiedAt,
            now,
        }),
        "no_cache_here"
    );
    // An unrecognised state is not a finding. An earlier version answered
    // `no_cache_here` for one, which reads as somebody having checked.
    for (const support of ["", "maybe", "VERIFIED_ABSENT", "verified"]) {
        assert.equal(
            cacheWindowState({ promptCacheSupport: support, lastServedAt: verifiedAt, now }),
            "unproven",
            support
        );
    }
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
            now: new Date("2026-09-23T00:04:59.999Z"),
        }),
        "within_ttl"
    );
    // Exclusive at the boundary: at exactly the TTL the window has elapsed,
    // and `within_ttl` there would be the one point where the name is a
    // claim the provider would not agree with.
    assert.equal(
        cacheWindowState({
            ...base,
            lastServedAt: verifiedAt,
            now: new Date("2026-09-23T00:05:00.000Z"),
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
    // sharpen it and is derived from what the person wrote; it also confirms
    // a guess, since a candidate prefix can be tested against it.
    //
    // Read from the schema and by shape, not by four spellings in one
    // migration: `prefixSha256` and anything a later migration adds have to
    // appear here too, and an earlier version of this test passed for both.
    const schema = readFileSync(
        new URL("../prisma/schema.prisma", import.meta.url),
        "utf8"
    );
    const model = /model DeploymentCacheAffinity \{([\s\S]*?)\n\}/.exec(schema);
    assert.ok(model, "the model is in the schema");
    const derived = /digest|hash|sha\d|checksum|fingerprint|prefix|excerpt|snippet/i;
    for (const line of model[1].split("\n")) {
        const field = /^\s+(\w+)\s+\w+/.exec(line.startsWith("  ///") ? "" : line);
        if (!field) continue;
        assert.ok(
            !derived.test(field[1]),
            `${field[1]} names something derived from what the person wrote`
        );
    }
});

test("nothing imports this module", () => {
    // What actually stops a second answer to the marker question, and stops
    // the shortest wrong path into the objective function: discounting
    // `expectedTotalCostUsdByModelId` when the window says `within_ttl`.
    // That needs no new tie-break criterion, so the criteria-list test would
    // still pass and check:dark-tables does not see a pure function call.
    // An import is the one thing it cannot do without.
    // `fileURLToPath`, not `new URL(...).pathname`. On Windows that pathname
    // is `/C:/…` and stripping the leading slash happens to produce a usable
    // path; on Linux it produces `home/runner/…`, a relative path that
    // resolves against the working directory and does not exist. The test
    // passed locally and could not run in CI.
    //
    // It also walked the whole repository rather than the four roots below,
    // which were declared and never used.
    const root = fileURLToPath(new URL("..", import.meta.url));
    const roots = ["app", "lib", "components", "scripts"];
    const walk = (directory) =>
        readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
            const path = join(directory, entry.name);
            if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
            if (entry.isDirectory()) return walk(path);
            return /\.(ts|tsx|mjs|js)$/.test(entry.name) ? [path] : [];
        });
    const importers = roots
        .flatMap((directory) => walk(join(root, directory)))
        .map((file) => file.split("\\").join("/"))
        .filter((file) => !file.endsWith("lib/deploymentCacheAffinity.ts"))
        .filter((file) =>
            /from\s+["'](@\/lib|\.\.?\/[\w./]*)\/?deploymentCacheAffinity["']/.test(
                readFileSync(file, "utf8")
            )
        );
    assert.deepEqual(importers, []);
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
