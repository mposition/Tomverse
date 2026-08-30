/**
 * The failure report, reading a schema-3 artifact.
 *
 * `tests/memoryEvalFailureSummary.test.mjs` covers the schema-2 shape and is
 * untouched — a report that answers one schema correctly and the other
 * silently wrongly is the failure this file exists to catch, and it can only
 * be caught by asserting both.
 *
 * What schema 3 adds to the classification is that "the tokens are right and
 * this did not match" now has three answers: the kind, the polarity, or a
 * citation that does not resolve. They need different responses from a
 * person — a taxonomy question, a reading of what the user said, and a defect
 * — so a report that collapsed them into one line would be a pile.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { analyseArtifact } from "../scripts/report-memory-eval-failures-core.mjs";

const USER_TURN = "저는 커피를 안 마셔요.";

const testCase = {
    id: "case-1",
    category: "durable_facts",
    language: "ko",
    goldCompleteness: "exhaustive",
    expected: [
        {
            id: "g1",
            kind: "preference",
            polarity: "negated",
            factValueAll: ["커피"],
            evidence: {
                evidenceMessageId: "m-user",
                evidenceQuote: "커피를 안 마셔요",
            },
            expectedDisposition: "bulk_safe",
        },
    ],
    conversations: [
        {
            externalConversationId: "conv-1",
            title: "fixture",
            messages: [
                { externalMessageId: "m-user", role: "user", content: USER_TURN },
            ],
        },
    ],
};

const candidate = (overrides = {}) => ({
    kind: "preference",
    polarity: "negated",
    statement: "사용자는 커피를 마시지 않는다",
    bulkSafe: true,
    disposition: "store_candidate",
    evidence: [
        { evidenceMessageId: "m-user", evidenceQuote: "커피를 안 마셔요" },
    ],
    ...overrides,
});

const analyse = (candidates) =>
    analyseArtifact({
        artifact: {
            manifest: {
                datasetVersion: "d",
                datasetDigest: "x",
                datasetSchemaVersion: 3,
            },
            records: [
                {
                    caseId: "case-1",
                    category: "durable_facts",
                    language: "ko",
                    failure: null,
                    candidates,
                    outcome: {},
                },
            ],
        },
        casesById: new Map([["case-1", testCase]]),
        datasetVersion: "d",
        datasetDigest: "x",
        datasetSchemaVersion: 3,
    });

test("a correct, cited candidate is classified as neither a miss nor a mismatch", () => {
    const analysis = analyse([candidate()]);
    assert.equal(analysis.kindMismatches.length, 0);
    assert.equal(analysis.unrecognised.length, 0);
});

test("a wrong kind is reported as a kind difference", () => {
    const analysis = analyse([candidate({ kind: "identity" })]);
    assert.equal(analysis.kindMismatches.length, 1);
    assert.equal(analysis.kindMismatches[0].expectedKind, "preference");
    assert.equal(analysis.kindMismatches[0].returnedKind, "identity");
});

test("a flipped polarity is reported as a polarity difference, not a kind one", () => {
    // The same words with the opposite claim. Reported under the kind pair
    // `preference -> preference` it would read as no difference at all.
    const analysis = analyse([
        candidate({ polarity: "affirmed", statement: "사용자는 커피를 마신다" }),
    ]);
    assert.equal(analysis.kindMismatches.length, 1);
    const row = analysis.kindMismatches[0];
    assert.equal(row.expectedPolarity, "negated");
    assert.equal(row.returnedPolarity, "affirmed");
    assert.deepEqual(analysis.kindMismatchPairs, [
        ["polarity negated -> affirmed", 1],
    ]);
});

test("a right statement that cites nothing is reported as an evidence failure", () => {
    const analysis = analyse([candidate({ evidence: [] })]);
    assert.equal(analysis.kindMismatches.length, 1);
    assert.equal(analysis.kindMismatches[0].evidenceBound, false);
    assert.deepEqual(analysis.kindMismatchPairs, [["evidence did not resolve", 1]]);
});

test("the gold description names the polarity and the schema-3 tokens", () => {
    // The schema-2 report read `mustInclude`, which a schema-3 gold does not
    // have: every gold would have printed an empty token list and every
    // candidate would have been "kind matches, tokens do not".
    const analysis = analyse([]);
    assert.equal(analysis.returnedNothing.length, 1);
    assert.deepEqual(analysis.returnedNothing[0].expected, [
        "preference/negated + [커피] (bulk_safe)",
    ]);
});

test("a schema-2 artifact is still read by the schema-2 rules", () => {
    // The other half of the guarantee. Default schema, `mustInclude` golds,
    // no polarity anywhere — and the report must not start reporting an
    // evidence failure for every candidate.
    const v2Case = {
        id: "case-2",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "g1",
                kind: "preference",
                mustInclude: ["커피"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [],
    };
    const analysis = analyseArtifact({
        artifact: {
            manifest: { datasetVersion: "d", datasetDigest: "x" },
            records: [
                {
                    caseId: "case-2",
                    category: "durable_facts",
                    language: "ko",
                    failure: null,
                    candidates: [
                        {
                            kind: "preference",
                            statement: "사용자는 커피를 마시지 않는다",
                            bulkSafe: true,
                            disposition: "store_candidate",
                        },
                    ],
                    outcome: {},
                },
            ],
        },
        casesById: new Map([["case-2", v2Case]]),
        datasetVersion: "d",
        datasetDigest: "x",
    });
    assert.equal(analysis.kindMismatches.length, 0);
    assert.equal(analysis.unrecognised.length, 0);
});
