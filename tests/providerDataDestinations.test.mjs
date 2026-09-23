import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    PROVIDER_DATA_DESTINATIONS,
    RETENTION_COMPONENTS,
    destinationIsDisclosable,
    destinationShapeProblems,
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

// A row that says everything a notice needs, with a reference for each
// part. Tests take it apart one field at a time.
const evidence = "TEST-EVIDENCE-1";
const reviewedRetention = () =>
    Object.fromEntries(
        RETENTION_COMPONENTS.map((component) => [
            component,
            { behavior: "BOUNDED", maxDays: 30, evidenceRef: evidence },
        ])
    );
const provenRow = (overrides = {}) => ({
    provider: "openai",
    recipientEntity: "Example Recipient, LLC",
    recipientCountryCodes: ["US"],
    customerContentStorage: {
        mode: "COMMITTED_LOCATIONS",
        countryCodes: ["SG"],
        macroRegions: [],
        evidenceRef: evidence,
    },
    processing: {
        mode: "NOT_PINNED",
        countryCodes: [],
        macroRegions: [],
        evidenceRef: evidence,
    },
    destinationRegions: ["SG"],
    trainsOnCustomerContent: { value: false, evidenceRef: evidence },
    retention: reviewedRetention(),
    zeroDataRetention: { mode: "UNKNOWN", evidenceRef: null },
    independentCommercialUseProhibited: { value: true, evidenceRef: evidence },
    evidenceRef: evidence,
    status: "proven",
    ...overrides,
});

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

    // And the rule bites when it is broken: an unproven row relabelled as
    // proven is missing every part a notice would print.
    const bare = { ...PROVIDER_DATA_DESTINATIONS[0], status: "proven" };
    assert.deepEqual(provenDestinationProblems(bare), [
        "proven without an evidenceRef",
        "proven without a recipientEntity",
        "proven without a recipient country",
        "proven without a reviewed storage geography",
        "proven without a reviewed processing geography",
        "proven without a training answer",
        ...RETENTION_COMPONENTS.map(
            (component) => `proven without a reviewed retention.${component}`
        ),
        "proven without an independent-commercial-use answer",
    ]);
    assert.equal(destinationIsDisclosable(bare), false);
});

test("the complete fixture is disclosable, so the refusals below are about one field each", () => {
    assert.deepEqual(provenDestinationProblems(provenRow()), []);
    assert.deepEqual(destinationShapeProblems(provenRow()), []);
    assert.equal(destinationIsDisclosable(provenRow()), true);
});

test("every enrolled row says nothing it cannot mean", () => {
    for (const entry of PROVIDER_DATA_DESTINATIONS) {
        assert.deepEqual(destinationShapeProblems(entry), [], entry.provider);
    }
});

test("storage and processing are separate answers", () => {
    // A provider can keep content in one place and run inference anywhere it
    // has capacity. "Not stored" is a storage answer only: what is not kept is
    // still processed somewhere.
    const row = provenRow({
        processing: {
            mode: "NO_PERSISTENT_CONTENT_STORAGE",
            countryCodes: [],
            macroRegions: [],
            evidenceRef: evidence,
        },
    });
    assert.ok(
        destinationShapeProblems(row).includes(
            "processing cannot be NO_PERSISTENT_CONTENT_STORAGE; that is a storage answer"
        )
    );
    assert.equal(destinationIsDisclosable(row), false);
});

test("nobody-looked is not the same as looked-and-it-does-not-say", () => {
    // NOT_SPECIFIED and NOT_PINNED are reviewed answers and may be printed;
    // UNKNOWN is the absence of a review and may not.
    for (const mode of ["NOT_SPECIFIED", "NOT_PINNED"]) {
        const row = provenRow({
            processing: { mode, countryCodes: [], macroRegions: [], evidenceRef: evidence },
        });
        assert.equal(destinationIsDisclosable(row), true, mode);
    }
    const unknown = provenRow({
        processing: { mode: "UNKNOWN", countryCodes: [], macroRegions: [], evidenceRef: null },
    });
    assert.ok(
        provenDestinationProblems(unknown).includes(
            "proven without a reviewed processing geography"
        )
    );
});

test("a location mode must list locations, and an unknown one must not", () => {
    const committedEmpty = provenRow({
        customerContentStorage: {
            mode: "COMMITTED_LOCATIONS",
            countryCodes: [],
            macroRegions: [],
            evidenceRef: evidence,
        },
        destinationRegions: [],
    });
    assert.ok(
        destinationShapeProblems(committedEmpty).includes(
            "storage names locations but lists none"
        )
    );
    const unknownWithPlaces = provenRow({
        processing: { mode: "UNKNOWN", countryCodes: ["US"], macroRegions: [], evidenceRef: null },
    });
    assert.ok(
        destinationShapeProblems(unknownWithPlaces).includes(
            "processing is UNKNOWN but lists locations"
        )
    );
});

test("a reviewed geography names what it was reviewed against", () => {
    const row = provenRow({
        processing: { mode: "NOT_PINNED", countryCodes: [], macroRegions: [], evidenceRef: null },
    });
    assert.ok(
        destinationShapeProblems(row).includes("processing is NOT_PINNED without an evidenceRef")
    );
});

test("country codes are countries and groupings are not padded into them", () => {
    // `UK` is how provider documents write it; the code is `GB`. `EU` is a
    // grouping. A mixed legacy string is kept out of a confirmed field.
    const row = provenRow({
        customerContentStorage: {
            mode: "COMMITTED_LOCATIONS",
            countryCodes: ["UK", "EU", "AU/SG_GROUP_DEFINED"],
            macroRegions: ["SG"],
            evidenceRef: evidence,
        },
        destinationRegions: ["UK", "EU", "AU/SG_GROUP_DEFINED", "SG"],
    });
    const problems = destinationShapeProblems(row);
    for (const code of ["UK", "EU", "AU/SG_GROUP_DEFINED"]) {
        assert.ok(
            problems.includes(
                `storage country code ${JSON.stringify(code)} is not ISO 3166-1 alpha-2`
            ),
            code
        );
    }
    assert.ok(problems.includes('storage macro region "SG" is a country code'));
    assert.deepEqual(
        destinationShapeProblems(
            provenRow({
                customerContentStorage: {
                    mode: "COMMITTED_LOCATIONS",
                    countryCodes: ["GB"],
                    macroRegions: ["EEA"],
                    evidenceRef: evidence,
                },
                destinationRegions: ["GB", "EEA"],
            })
        ),
        []
    );
});

test("destinationRegions is the storage alias and cannot drift from it", () => {
    // It was once described as where data is processed. Holding it to the
    // storage field is what stops that reading coming back.
    const processingCopied = provenRow({
        processing: {
            mode: "COMMITTED_LOCATIONS",
            countryCodes: ["US"],
            macroRegions: [],
            evidenceRef: evidence,
        },
        destinationRegions: ["US"],
    });
    assert.ok(
        destinationShapeProblems(processingCopied).includes(
            "destinationRegions is the storage alias and differs from customerContentStorage"
        )
    );
    assert.equal(destinationIsDisclosable(processingCopied), false);
});

test("null is not established, and it is not no", () => {
    const training = provenRow({ trainsOnCustomerContent: { value: null, evidenceRef: null } });
    assert.ok(provenDestinationProblems(training).includes("proven without a training answer"));

    const onward = provenRow({
        independentCommercialUseProhibited: { value: null, evidenceRef: null },
    });
    assert.ok(
        provenDestinationProblems(onward).includes(
            "proven without an independent-commercial-use answer"
        )
    );

    // And an answer needs its reference, whichever way it goes.
    const unsourced = provenRow({ trainsOnCustomerContent: { value: false, evidenceRef: null } });
    assert.ok(
        destinationShapeProblems(unsourced).includes(
            "trainsOnCustomerContent is answered without an evidenceRef"
        )
    );
});

test("each kind of retention is its own answer", () => {
    // A short cache and a thirty-day abuse log are different things to tell a
    // person, and the default period is not the maximum for every feature.
    for (const component of RETENTION_COMPONENTS) {
        const retention = reviewedRetention();
        retention[component] = { behavior: "UNKNOWN", maxDays: null, evidenceRef: null };
        assert.ok(
            provenDestinationProblems(provenRow({ retention })).includes(
                `proven without a reviewed retention.${component}`
            ),
            component
        );
    }
    const retention = reviewedRetention();
    retention.safetyLogs = { behavior: "UNKNOWN", maxDays: 30, evidenceRef: null };
    assert.ok(
        destinationShapeProblems(provenRow({ retention })).includes(
            "retention.safetyLogs is UNKNOWN but has a maxDays"
        )
    );
    const fractional = reviewedRetention();
    fractional.content = { behavior: "BOUNDED", maxDays: 0.5, evidenceRef: evidence };
    assert.ok(
        destinationShapeProblems(provenRow({ retention: fractional })).includes(
            "retention.content.maxDays is not a whole number of days"
        )
    );
});

test("zero data retention is not what makes a row disclosable", () => {
    // It is what a strict route needs. A standard route discloses its
    // retention instead of avoiding it, so an unknown ZDR does not block a
    // notice -- and a claimed one still needs its reference.
    assert.equal(destinationIsDisclosable(provenRow()), true);
    const claimed = provenRow({ zeroDataRetention: { mode: "ZDR", evidenceRef: null } });
    assert.ok(
        destinationShapeProblems(claimed).includes("zeroDataRetention is ZDR without an evidenceRef")
    );
});

test("the geography vocabulary is the handoff's, not a local paraphrase", () => {
    // A contract reviewer and this file have to use one set of words.
    const source = readFileSync(
        new URL("../lib/providerDataDestinations.ts", import.meta.url),
        "utf8"
    );
    const union = (name) => {
        const match = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(source);
        assert.ok(match, name);
        return [...match[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).sort();
    };
    assert.deepEqual(
        union("ContentGeographyMode"),
        [
            "COMMITTED_LOCATIONS",
            "DISCLOSED_POSSIBLE_LOCATIONS",
            "NOT_PINNED",
            "NOT_SPECIFIED",
            "NO_PERSISTENT_CONTENT_STORAGE",
            "UNKNOWN",
        ].sort()
    );
    assert.deepEqual(
        union("RetentionBehavior"),
        [
            "BOUNDED",
            "CUSTOMER_CONTROLLED",
            "NOT_APPLICABLE",
            "NOT_SPECIFIED",
            "NO_PERSISTENT_STORAGE",
            "TRANSIENT",
            "UNKNOWN",
        ].sort()
    );
    assert.deepEqual(
        union("ZeroDataRetentionMode"),
        ["CONTRACTUAL_NO_CONTENT_STORAGE", "NOT_SUPPORTED", "UNKNOWN", "ZDR"].sort()
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
