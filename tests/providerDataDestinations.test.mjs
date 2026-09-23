import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    PROVIDER_DATA_DESTINATIONS,
    disclosableDataDestinations,
    providerDestinationIsEstablished,
    providerDataDestination,
    provenDestinationProblems,
} from "../lib/providerDataDestinations.ts";

/**
 * Where a provider takes personal data.
 *
 * The Privacy page and the routing residency gate read this one list, so what
 * these tests hold is that it cannot claim more than it can show: a row is
 * `proven` only with an entity, a region and a reference to whatever says so,
 * and anything else fails closed in both directions at once.
 */

const providerUnion = () => {
    const source = readFileSync(new URL("../lib/models.ts", import.meta.url), "utf8");
    const declaration = source.match(/export type AiProvider =([\s\S]*?);/);
    assert.ok(declaration, "AiProvider is declared");
    return [...declaration[1].matchAll(/"([a-z0-9_-]+)"/g)].map((match) => match[1]);
};

test("every provider the catalogue can reach is enrolled", () => {
    // Enrolment is the point: a provider added to the union and forgotten here
    // is one nobody asked the destination question about, and the report would
    // read a confident zero over a set it had not looked at.
    const enrolled = PROVIDER_DATA_DESTINATIONS.map((entry) => entry.provider).sort();
    assert.deepEqual(enrolled, providerUnion().sort());
});

test("no provider is listed twice", () => {
    const enrolled = PROVIDER_DATA_DESTINATIONS.map((entry) => entry.provider);
    assert.equal(new Set(enrolled).size, enrolled.length);
});

test("a destination cannot be claimed without something that says so", () => {
    for (const entry of PROVIDER_DATA_DESTINATIONS) {
        assert.deepEqual(
            provenDestinationProblems(entry),
            [],
            `${entry.provider}: ${provenDestinationProblems(entry).join(", ")}`
        );
    }

    // And the rule bites when it is broken.
    assert.deepEqual(
        provenDestinationProblems({
            provider: "openai",
            recipientEntity: null,
            destinationRegions: [],
            evidenceRef: null,
            status: "proven",
        }),
        [
            "proven without an evidenceRef",
            "proven without a recipientEntity",
            "proven without a destinationRegion",
        ]
    );
});

test("an unproven provider has no established destination", () => {
    for (const entry of PROVIDER_DATA_DESTINATIONS) {
        if (entry.status === "proven") continue;
        assert.equal(providerDestinationIsEstablished(entry.provider), false, entry.provider);
    }
});

test("a provider nobody enrolled has none either", () => {
    // Absent and unproven answer the same way, and for the same reason: nobody
    // can say where the data would go.
    assert.equal(providerDataDestination("not-a-provider"), null);
    assert.equal(providerDestinationIsEstablished("not-a-provider"), false);
});

test("nothing is disclosable until something is proven", () => {
    // Today this is empty, and that is the accurate state rather than a gap.
    // A notice is a promise; this is the list of promises that can be kept.
    for (const entry of disclosableDataDestinations()) {
        assert.equal(entry.status, "proven");
        assert.deepEqual(provenDestinationProblems(entry), []);
    }
    assert.deepEqual(
        disclosableDataDestinations().map((entry) => entry.provider),
        PROVIDER_DATA_DESTINATIONS.filter((entry) => entry.status === "proven").map(
            (entry) => entry.provider
        )
    );
});
