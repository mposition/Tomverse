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
 * disclosable only when it answers everything a notice prints, each answer
 * with a reference, and anything else fails closed in both directions at
 * once.
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

const emptyRow = (provider = "openai") => ({
    provider,
    recipientEntity: null,
    recipientCountryCodes: [],
    customerContentStorage: {
        mode: "UNKNOWN",
        countryCodes: [],
        macroRegions: [],
        evidenceRef: null,
    },
    processing: {
        mode: "UNKNOWN",
        countryCodes: [],
        macroRegions: [],
        evidenceRef: null,
    },
    destinationRegions: [],
    trainsOnCustomerContent: { value: null, evidenceRef: null },
    retention: Object.fromEntries(
        RETENTION_COMPONENTS.map((component) => [
            component,
            { behavior: "UNKNOWN", maxDays: null, evidenceRef: null },
        ])
    ),
    zeroDataRetention: { mode: "UNKNOWN", evidenceRef: null },
    independentCommercialUseProhibited: { value: null, evidenceRef: null },
    evidenceRef: null,
    status: "unproven",
});

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
    const bare = { ...emptyRow(), status: "proven" };
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

test("the two location modes carry locations, and a grouping may be one of them", () => {
    // The allowing branches, held as well as the refusing ones: a list of
    // places a provider may use, and "the EU" named as a grouping.
    const possible = provenRow({
        processing: {
            mode: "DISCLOSED_POSSIBLE_LOCATIONS",
            countryCodes: ["US", "GB"],
            macroRegions: [],
            evidenceRef: evidence,
        },
    });
    assert.deepEqual(destinationShapeProblems(possible), []);
    assert.equal(destinationIsDisclosable(possible), true);

    const grouping = provenRow({
        customerContentStorage: {
            mode: "COMMITTED_LOCATIONS",
            countryCodes: [],
            macroRegions: ["EU"],
            evidenceRef: evidence,
        },
        destinationRegions: ["EU"],
    });
    assert.deepEqual(destinationShapeProblems(grouping), []);
    assert.equal(destinationIsDisclosable(grouping), true);
});

test("no place is not a place: NOT_PINNED and NOT_SPECIFIED list nothing", () => {
    // A set of places the provider may use is DISCLOSED_POSSIBLE_LOCATIONS.
    for (const mode of ["NOT_PINNED", "NOT_SPECIFIED"]) {
        const row = provenRow({
            processing: { mode, countryCodes: ["US"], macroRegions: [], evidenceRef: evidence },
        });
        assert.ok(
            destinationShapeProblems(row).includes(`processing is ${mode} but lists locations`),
            mode
        );
        assert.equal(destinationIsDisclosable(row), false, mode);
    }
});

test("the recipient rests on the row's evidence, even while unproven", () => {
    const named = {
        ...emptyRow(),
        recipientEntity: "Example Recipient, LLC",
        recipientCountryCodes: ["US"],
    };
    assert.equal(named.status, "unproven");
    assert.ok(
        destinationShapeProblems(named).includes("the recipient is named without an evidenceRef")
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
                `storage country code ${JSON.stringify(code)} is not a two-letter country code`
            ),
            code
        );
    }
    assert.ok(problems.includes('storage macro region "SG" is a country code'));

    // A miswritten country is not a grouping either: moving it to the macro
    // field must not let it back into the storage alias.
    const moved = destinationShapeProblems(
        provenRow({
            customerContentStorage: {
                mode: "COMMITTED_LOCATIONS",
                countryCodes: [],
                macroRegions: ["UK", "EL", " "],
                evidenceRef: evidence,
            },
            destinationRegions: ["UK", "EL", " "],
        })
    );
    assert.ok(moved.includes('storage macro region "UK" is a miswritten country code'));
    assert.ok(moved.includes('storage macro region "EL" is a miswritten country code'));
    assert.ok(moved.includes("storage macro region is blank"));
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

test("moonshot records Singapore storage and training as separate unread-notice facts", () => {
    const row = providerDataDestination("moonshot");
    assert.ok(row);
    assert.equal(row.recipientEntity, "MOONSHOT AI PTE. LTD.");
    assert.deepEqual([...row.recipientCountryCodes], ["SG"]);
    assert.equal(row.customerContentStorage.mode, "COMMITTED_LOCATIONS");
    assert.deepEqual([...row.customerContentStorage.countryCodes], ["SG"]);
    assert.equal(row.processing.mode, "DISCLOSED_POSSIBLE_LOCATIONS");
    assert.deepEqual([...row.processing.countryCodes], ["SG"]);
    assert.equal(row.trainsOnCustomerContent.value, true);
    assert.equal(row.retention.content.behavior, "NOT_SPECIFIED");
    assert.equal(row.status, "proven");
    assert.equal(destinationIsDisclosable(row), true);
    assert.equal(providerDestinationIsEstablished("moonshot"), true);
    const registry = readFileSync(
        new URL("../lib/modelRegistryShared.ts", import.meta.url),
        "utf8"
    );
    assert.match(registry, /moonshot:\s*\{[\s\S]*?baseUrl: "https:\/\/api\.moonshot\.ai\/v1"/);
    assert.equal(registry.includes("api.moonshot.cn"), false);
});

test("google is ready: paid billing means no training, and the addendum bars sale", () => {
    const row = providerDataDestination("google");
    assert.ok(row);
    assert.equal(row.trainsOnCustomerContent.value, false);
    assert.equal(row.independentCommercialUseProhibited.value, true);
    assert.equal(row.customerContentStorage.mode, "NOT_PINNED");
    assert.equal(row.status, "proven");
    assert.equal(destinationIsDisclosable(row), true);
});

test("deepseek names the Hangzhou company and does not store API content in a named country", () => {
    const row = providerDataDestination("deepseek");
    assert.ok(row);
    assert.equal(
        row.recipientEntity,
        "Hangzhou DeepSeek Artificial Intelligence Co., Ltd."
    );
    assert.deepEqual([...row.recipientCountryCodes], ["CN"]);
    assert.equal(row.customerContentStorage.mode, "NOT_SPECIFIED");
    assert.deepEqual([...row.customerContentStorage.countryCodes], []);
    assert.deepEqual([...row.destinationRegions], []);
    assert.equal(row.processing.mode, "NOT_SPECIFIED");
    assert.equal(row.trainsOnCustomerContent.value, false);
    assert.equal(row.independentCommercialUseProhibited.value, true);
    assert.equal(row.retention.content.behavior, "NOT_SPECIFIED");
    assert.equal(row.status, "proven");
    assert.equal(destinationIsDisclosable(row), true);
    assert.equal(providerDestinationIsEstablished("deepseek"), true);
    const registry = readFileSync(
        new URL("../lib/modelRegistryShared.ts", import.meta.url),
        "utf8"
    );
    assert.match(registry, /deepseek:\s*\{[\s\S]*?baseUrl: "https:\/\/api\.deepseek\.com"/);
    assert.equal(registry.includes("api.deepseek.cn"), false);
    assert.equal(registry.includes("api.sg.deepseek.com"), false);
});

test("mistral API training is off and the row is ready", () => {
    const row = providerDataDestination("mistral");
    assert.ok(row);
    assert.equal(row.trainsOnCustomerContent.value, false);
    assert.equal(row.independentCommercialUseProhibited.value, true);
    assert.equal(row.customerContentStorage.mode, "COMMITTED_LOCATIONS");
    assert.deepEqual([...row.customerContentStorage.macroRegions], ["EU"]);
    assert.equal(row.status, "proven");
    assert.equal(destinationIsDisclosable(row), true);
});

test("minimax is ready: the privacy-policy sentence is the training no and the sale ban", () => {
    const row = providerDataDestination("minimax");
    assert.ok(row);
    assert.equal(row.trainsOnCustomerContent.value, false);
    assert.equal(row.independentCommercialUseProhibited.value, true);
    assert.equal(row.customerContentStorage.mode, "NOT_SPECIFIED");
    assert.equal(row.status, "proven");
    assert.equal(destinationIsDisclosable(row), true);
});

test("every enrolled provider is ready", () => {
    const ready = [
        "openai",
        "anthropic",
        "google",
        "groq",
        "xai",
        "deepseek",
        "mistral",
        "moonshot",
        "minimax",
        "qwen",
        "zhipu",
        "perplexity",
    ];
    const open = [];
    assert.deepEqual(
        disclosableDataDestinations().map((entry) => entry.provider),
        ready
    );
    for (const provider of open) {
        const row = providerDataDestination(provider);
        assert.equal(row.status, "unproven", provider);
        assert.equal(destinationIsDisclosable(row), false, provider);
    }
});

test("nothing is disclosable until something is proven", () => {
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
