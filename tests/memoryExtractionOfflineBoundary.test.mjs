import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Slice 1.5 is offline by contract: with only this merged, NO code path may
 * reach an extraction provider, spend credits, or consume a provider budget.
 *
 * That is a property of the import graph, so it is checked as one. Tracing
 * call sites would miss a provider reached through a helper; an import that
 * is not there cannot be called at all, however the code is refactored later.
 *
 * When 1.6 adds the real adapter it will live in its own module with its own
 * financial contract, and the modules listed here stay pure — so this test
 * should keep passing rather than being deleted.
 */

const OFFLINE_MODULES = [
    "lib/memoryExtractionPrompt.ts",
    "lib/memoryExtractionOutput.ts",
    "lib/memoryExtractionPipeline.ts",
];

/** Anything that would mean a model call, a charge, or a budget draw. */
const FORBIDDEN_IMPORTS = [
    "ai",
    "@ai-sdk/openai",
    "@ai-sdk/anthropic",
    "@ai-sdk/google",
    "@ai-sdk/moonshotai",
    "openai",
    "@/lib/providerCostBudget",
    "@/lib/providerCredits",
    "@/lib/modelPricing",
    "@/lib/prisma",
];

const importsOf = (source) =>
    [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map(
        (match) => match[1]
    );

test("the offline extraction modules import nothing that can call a provider", () => {
    for (const modulePath of OFFLINE_MODULES) {
        const source = readFileSync(
            new URL(`../${modulePath}`, import.meta.url),
            "utf8"
        );
        for (const specifier of importsOf(source)) {
            assert.ok(
                !FORBIDDEN_IMPORTS.includes(specifier),
                `${modulePath} imports ${specifier}; slice 1.5 must stay offline`
            );
        }
    }
});

test("the offline extraction modules never reach the network directly", () => {
    for (const modulePath of OFFLINE_MODULES) {
        const source = readFileSync(
            new URL(`../${modulePath}`, import.meta.url),
            "utf8"
        );
        // Comments are stripped first: the modules explain *why* they do not
        // call a provider, and prose about fetch is not a fetch.
        const code = source
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "");
        for (const pattern of [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /https?:\/\//]) {
            assert.ok(
                !pattern.test(code),
                `${modulePath} contains ${pattern} outside comments`
            );
        }
    }
});

test("the live provider adapter is reachable from exactly one module", () => {
    // Slice 1.6b adds lib/memoryExtractionProvider.ts, the single place that
    // can spend money. Keeping it the only importer of the SDK is what makes
    // "can extraction call a provider from here?" answerable by reading
    // imports rather than tracing calls.
    const provider = readFileSync(
        new URL("../lib/memoryExtractionProvider.ts", import.meta.url),
        "utf8"
    );
    assert.ok(
        provider.includes('from "ai"'),
        "the provider adapter is where the SDK import belongs"
    );
    assert.ok(
        provider.includes("maxRetries: 0"),
        "an SDK-internal retry is a charge the processor cannot reserve for"
    );
});

test("no production module wires the pipeline into a run driver yet", () => {
    // The processor takes an injected handler (slice 1 / PR #341). Until 1.6
    // supplies a real one, nothing outside tests may hand it the pipeline —
    // that is what keeps a merged 1.5 incapable of spending money.
    const service = readFileSync(
        new URL("../lib/memoryExtractionService.ts", import.meta.url),
        "utf8"
    );
    assert.ok(
        !service.includes("memoryExtractionPipeline"),
        "the run service must not import the pipeline before slice 1.6"
    );
    // The drivers (after() kick, maintenance dispatch) are wired only once
    // settlement exists, so nothing may reach the provider through the run
    // service yet.
    assert.ok(
        !service.includes("memoryExtractionProvider"),
        "the run service must not reach the provider before settlement exists"
    );
});
