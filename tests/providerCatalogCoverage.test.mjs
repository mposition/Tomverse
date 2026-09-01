import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
    chatModelExclusion,
    isLikelyChatModelId,
    parseProviderCatalogModels,
    parseProviderCatalogResponse,
} from "../lib/providerModelCatalogCore.ts";
import { AI_PROVIDERS } from "../lib/modelRegistryShared.ts";

// What a catalogue scan did *not* look at: ML-05, the OpenAI prefix guess, and
// the page budget.
//
// Contract: .github/audits/model-lifecycle-email-2026-08-22.md ML-05, §6.
//
// Three separate ways the daily report could be read as more complete than it
// is: a provider printed as a raw key, a model dropped by a guess about its
// name, and a page budget that ran out mid-list. None of them was visible.

test("every provider has a display name on every surface", () => {
    // ML-05: `providerName()` in the report carried eleven of twelve, so
    // `minimax` printed as `minimax` in every operator report for as long as
    // the provider has existed. The other three maps were typed
    // `Record<AiProvider, string>` and none of them lost a provider -- so the
    // fix is the type, and this test is the second guard.
    const maps = [
        ["lib/providerModelCatalogReport.ts", "PROVIDER_REPORT_NAMES"],
        ["lib/providerMonitoring.ts", "PROVIDER_DISPLAY_NAMES"],
        ["components/admin/AdminProviderOpsPanel.tsx", "providerLabel"],
        ["components/marketing/ModelCatalogueSection.tsx", "PROVIDER_LABELS"],
    ];

    for (const [file, name] of maps) {
        const source = readFileSync(file, "utf8");
        const start = source.indexOf(`${name}`);
        assert.ok(start > -1, `${file} no longer defines ${name}`);
        const block = source.slice(start, source.indexOf("};", start));
        for (const provider of AI_PROVIDERS) {
            assert.match(
                block,
                new RegExp(`\\n\\s*${provider}:\\s*"`),
                `${file}: ${name} is missing ${provider}`
            );
        }
    }
});

test("the display names are allowed to differ between surfaces", () => {
    // Not a bug to be consolidated away: an operator report names the product
    // line it is scanning, a marketing page names the company. One map would
    // have to pick, and either choice is wrong on the other page.
    const report = readFileSync("lib/providerModelCatalogReport.ts", "utf8");
    const marketing = readFileSync(
        "components/marketing/ModelCatalogueSection.tsx",
        "utf8"
    );
    assert.match(report, /google: "Google Gemini"/);
    assert.match(marketing, /google: "Google"/);
});

test("a non-chat model is excluded for what its name says", () => {
    for (const id of [
        "text-embedding-3-large",
        "whisper-1",
        "tts-1",
        "omni-moderation-latest",
        "dall-e-3",
    ]) {
        assert.equal(chatModelExclusion("openai", id), "non_chat_kind", id);
    }
});

test("a guess about the name is recorded as a guess", () => {
    // The distinction that matters: an embedding model says `embedding`, and
    // that is as reliable as a name can be. "OpenAI chat models start with
    // gpt-, chatgpt- or o<n>" is a bet, and the day it stops holding, the new
    // model is not discovered and nothing says so.
    assert.equal(
        chatModelExclusion("openai", "davinci-002"),
        "openai_prefix_heuristic"
    );
    assert.equal(chatModelExclusion("openai", "gpt-5-6-luna"), null);
    assert.equal(chatModelExclusion("openai", "o4-mini"), null);
    // The prefix rule is OpenAI's alone.
    assert.equal(chatModelExclusion("anthropic", "claude-opus-5"), null);
    assert.equal(chatModelExclusion("mistral", "codestral-latest"), null);
});

test("the old boolean still answers the same way", () => {
    assert.equal(isLikelyChatModelId("openai", "gpt-5-6-luna"), true);
    assert.equal(isLikelyChatModelId("openai", "davinci-002"), false);
    assert.equal(isLikelyChatModelId("openai", "text-embedding-3-large"), false);
});

test("the parser reports what the prefix guess dropped", () => {
    const parsed = parseProviderCatalogModels("openai", {
        data: [
            { id: "gpt-5-6-luna" },
            { id: "davinci-002" },
            { id: "babbage-002" },
            // Excluded for what it is, not by the guess -- so it does not
            // appear below. Listing it would bury the one line worth reading.
            { id: "text-embedding-3-large" },
        ],
    });

    assert.deepEqual(
        parsed.observations.map((observation) => observation.id),
        ["gpt-5-6-luna"]
    );
    assert.deepEqual(parsed.heuristicallyExcluded, ["babbage-002", "davinci-002"]);
});

test("a provider with no prefix rule drops nothing to a guess", () => {
    const parsed = parseProviderCatalogModels("anthropic", {
        data: [{ id: "claude-opus-5" }, { id: "voyage-3-embedding" }],
    });
    assert.deepEqual(
        parsed.observations.map((observation) => observation.id),
        ["claude-opus-5"]
    );
    assert.deepEqual(parsed.heuristicallyExcluded, []);
});

test("an unreadable payload reports both lists empty", () => {
    assert.deepEqual(parseProviderCatalogModels("openai", null), {
        observations: [],
        heuristicallyExcluded: [],
    });
});

test("the observation-only parser is unchanged", () => {
    // Existing callers and their tests read this shape; adding a second answer
    // must not move the first.
    assert.deepEqual(
        parseProviderCatalogResponse("openai", {
            data: [{ id: "gpt-5-6-luna" }, { id: "davinci-002" }],
        }).map((observation) => observation.id),
        ["gpt-5-6-luna"]
    );
});

test("the page budget is small enough that reaching it means something", () => {
    // Five pages of up to a thousand is far more than any provider lists today,
    // which is why running out is worth an incident rather than a note: every
    // model past the cut is absent from a run that reported success, and
    // absence is how a retirement is detected.
    const source = readFileSync("lib/providerModelCatalogMonitor.ts", "utf8");
    assert.match(source, /const MAX_PAGES = \d+;/);
    assert.match(source, /PROVIDER_MODEL_CATALOG_TRUNCATED/);
    assert.match(
        source,
        /must not be read as missing/,
        "the incident has to say what the truncation does to the next section"
    );
});

test("a rejected key raises an incident, per provider", () => {
    // The scan is not what a 401 breaks. The same key carries this provider's
    // chat traffic, so the outage is already live when the daily report prints
    // the row -- and before this the row was the only thing that said anything.
    const source = readFileSync("lib/providerModelCatalogMonitor.ts", "utf8");
    assert.match(
        source,
        /PROVIDER_CATALOG_KEY_REJECTED\}_\$\{provider\.toUpperCase\(\)\}/,
        "the incident code must carry the provider"
    );
    // Why it must: notification cooldown is keyed on the code alone
    // (lib/operationalMonitoring.ts), so one shared code lets the first
    // rejected provider silence every other one in the same run.
    assert.match(source, /severity: "error"/);
    // And the classification itself stays out of the fetch, where a network
    // would be needed to reach it.
    assert.match(source, /providerCatalogHttpFailure\(provider, response\.status\)/);
});

test("a rejected key is named in the report row, not left as a status code", () => {
    const source = readFileSync("lib/providerModelCatalogReport.ts", "utf8");
    assert.match(source, /PROVIDER_CATALOG_KEY_REJECTED/);
    assert.match(
        source,
        /chat requests are failing too/,
        "the row has to say the scan is the symptom, not the outage"
    );
});
