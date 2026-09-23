import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AI_PROVIDERS } from "../lib/modelRegistryShared.ts";
import {
    REGION_PIN_HOSTS,
    regionPinHostDecision,
} from "../lib/regionPinHosts.ts";

test("each region-pin host has no global origin and is not a catalogue connection", () => {
    assert.deepEqual(REGION_PIN_HOSTS, ["vertex-ai", "azure-openai"]);
    for (const host of REGION_PIN_HOSTS) {
        const decision = regionPinHostDecision(host);
        assert.deepEqual(decision, {
            host,
            globalOrigin: null,
            catalogueConnection: false,
            residency: "unproven",
        });
        assert.throws(() => {
            decision.residency = "proven";
        });
        assert.equal(AI_PROVIDERS.includes(host), false);
    }
});

test("an unknown host is not given an origin", () => {
    assert.equal(regionPinHostDecision("vertex"), null);
    assert.equal(regionPinHostDecision("azure"), null);
    assert.equal(regionPinHostDecision(""), null);
    assert.equal(regionPinHostDecision(null), null);
});

test("the module does not store an origin", () => {
    const source = readFileSync("lib/regionPinHosts.ts", "utf8");
    assert.doesNotMatch(source, /https?:\/\//);
    assert.doesNotMatch(source, /googleapis/i);
    assert.doesNotMatch(source, /azure\.com/i);
    assert.doesNotMatch(source, /openai\.azure/i);
});

test("the request path does not import the region-pin decision", () => {
    const hits = [];
    const walk = (directory) => {
        for (const name of readdirSync(directory)) {
            const path = join(directory, name);
            if (statSync(path).isDirectory()) {
                walk(path);
                continue;
            }
            if (!/\.(?:ts|tsx|mjs|js)$/.test(name)) continue;
            if (path === join("lib", "regionPinHosts.ts")) continue;
            const source = readFileSync(path, "utf8");
            if (
                source.includes("regionPinHosts") ||
                source.includes("regionPinHostDecision") ||
                source.includes("REGION_PIN_HOSTS")
            ) {
                hits.push(path);
            }
        }
    };
    for (const root of ["app", "lib"]) walk(root);
    assert.deepEqual(hits, []);
});
