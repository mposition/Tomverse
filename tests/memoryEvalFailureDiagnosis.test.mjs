/**
 * The failure diagnosis, and the two mistakes it was written twice to avoid.
 *
 * This module groups a failing run's failures by what can be observed about
 * them, so that a person can tell a prompt defect from a taxonomy mismatch
 * from a gold defect from a model error. Its whole value rests on two things:
 * that it counts the same failures the scorer counted, and that it does not
 * assert a cause.
 *
 * Both were got wrong in drafting. The first draft called a candidate
 * "recognised" if it quoted a message some gold entry cited, which hid 10 of
 * the run's 41 critical adoptions; the second filtered the gate on
 * `disposition` when the gate counts every bulk-safe candidate no bulk-safe
 * gold admitted. Each read plausibly and each under-reported the number being
 * diagnosed. So the tests below are mostly about agreement with the scorer.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { diagnoseRun, tally } from "../lib/memoryEvalFailureDiagnosis.ts";
import { scoreCaseV3 } from "../lib/memoryEvalScoringV3.ts";
import { MEMORY_EVAL_CRITICAL_CATEGORIES } from "../lib/memoryExtractionEvalCore.ts";

/** A case in a critical cell whose gold expects nothing. */
const emptyGoldCase = (id) => ({
    id,
    category: "assistant_only",
    language: "ko",
    expected: [],
    goldCompleteness: "exhaustive",
    conversations: [
        {
            externalConversationId: `${id}-c`,
            title: "t",
            messages: [
                { externalMessageId: `${id}-m1`, role: "user", content: "동생 대신 물어봐요." },
                { externalMessageId: `${id}-m2`, role: "assistant", content: "확인이 우선입니다." },
            ],
        },
    ],
});

/** A durable case whose single gold entry the run can relabel. */
const goldCase = (id) => ({
    id,
    category: "durable_facts",
    language: "en",
    expected: [
        {
            id: "e1",
            kind: "communication_style",
            polarity: "affirmed",
            factValueAll: ["jargon"],
            evidence: { evidenceMessageId: `${id}-m1`, evidenceQuote: "Keep the jargon." },
            expectedDisposition: "bulk_safe",
        },
    ],
    goldCompleteness: "exhaustive",
    conversations: [
        {
            externalConversationId: `${id}-c`,
            title: "t",
            messages: [
                { externalMessageId: `${id}-m1`, role: "user", content: "Keep the jargon." },
                { externalMessageId: `${id}-m2`, role: "assistant", content: "Will do." },
            ],
        },
    ],
});

const candidate = (overrides) => ({
    kind: "relationship",
    polarity: "affirmed",
    statement: "The user has a sibling.",
    bulkSafe: true,
    disposition: "accepted",
    evidence: [],
    ...overrides,
});

const recordFor = (kase, candidates) => ({
    caseId: kase.id,
    category: kase.category,
    language: kase.language,
    candidates,
    outcome: scoreCaseV3(kase, candidates),
});

const run = (pairs) =>
    diagnoseRun({
        records: pairs.map(([kase, candidates]) => recordFor(kase, candidates)),
        cases: pairs.map(([kase]) => kase),
        criticalCategories: MEMORY_EVAL_CRITICAL_CATEGORIES,
    });

/* ------------------------------------------- agreement with the scorer -- */

test("the critical count is the scorer's, not a second opinion", () => {
    // The gate counts every bulk-safe candidate no bulk-safe gold admitted.
    // `disposition` does not enter into it, which is what the second draft got
    // wrong — so a candidate with a disposition the gate ignores must still be
    // counted here.
    const kase = emptyGoldCase("c1");
    const candidates = [
        candidate({
            disposition: "held",
            evidence: [
                { evidenceMessageId: "c1-m1", evidenceQuote: "동생 대신 물어봐요." },
            ],
        }),
    ];
    const record = recordFor(kase, candidates);
    assert.equal(record.outcome.criticalBulkSafeAdoptions, 1, "premise: the gate counts it");

    const diagnosis = run([[kase, candidates]]);
    assert.equal(
        diagnosis.unrecognisedCandidates.filter((row) => row.critical).length,
        1
    );
});

test("a candidate quoting a gold-cited message is still unrecognised when relabelled", () => {
    // The first draft's mistake. The candidate quotes exactly the message the
    // gold cites, so "does it quote gold's message" says recognised — and the
    // scorer says otherwise, because the label differs.
    const kase = goldCase("c2");
    const candidates = [
        candidate({
            kind: "formatting",
            polarity: "affirmed",
            statement: "The user prefers jargon kept with a gloss.",
            evidence: [
                { evidenceMessageId: "c2-m1", evidenceQuote: "Keep the jargon." },
            ],
        }),
    ];
    const record = recordFor(kase, candidates);
    assert.equal(record.outcome.goldMatched, 0, "premise: the scorer did not match it");

    const diagnosis = run([[kase, candidates]]);
    assert.equal(diagnosis.unrecognisedCandidates.length, 1);
    assert.equal(diagnosis.unrecognisedCandidates[0].quotesGoldMessage, true);
    // And the gold side calls it relabelled rather than missed, naming what
    // the run said instead.
    assert.equal(diagnosis.unmatchedGold.length, 1);
    assert.equal(diagnosis.unmatchedGold[0].shape, "relabelled");
    assert.deepEqual(diagnosis.unmatchedGold[0].relabelledAs, [
        { kind: "formatting", polarity: "affirmed" },
    ]);
});

test("a matched candidate is not reported as a failure", () => {
    const kase = goldCase("c3");
    const candidates = [
        candidate({
            kind: "communication_style",
            polarity: "affirmed",
            statement: "The user prefers jargon kept.",
            evidence: [
                { evidenceMessageId: "c3-m1", evidenceQuote: "Keep the jargon." },
            ],
        }),
    ];
    assert.equal(recordFor(kase, candidates).outcome.goldMatched, 1, "premise");
    const diagnosis = run([[kase, candidates]]);
    assert.deepEqual([...diagnosis.unrecognisedCandidates], []);
    assert.deepEqual([...diagnosis.unmatchedGold], []);
});

/* ------------------------------------------------ the observations made -- */

test("whose words a candidate quoted is read from the dataset, not the cell", () => {
    // The distinction the audit's first draft got wrong by reading the cell
    // name: a case in `assistant_only` whose candidate quotes the *user* is
    // not the model attributing the assistant's words to the user.
    const kase = emptyGoldCase("c4");
    const fromUser = run([
        [
            kase,
            [
                candidate({
                    evidence: [
                        { evidenceMessageId: "c4-m1", evidenceQuote: "동생 대신 물어봐요." },
                    ],
                }),
            ],
        ],
    ]);
    assert.equal(fromUser.unrecognisedCandidates[0].citedRole, "user");
    assert.equal(fromUser.unrecognisedCandidates[0].goldExpectsNothing, true);

    const fromAssistant = run([
        [
            kase,
            [
                candidate({
                    evidence: [
                        { evidenceMessageId: "c4-m2", evidenceQuote: "확인이 우선입니다." },
                    ],
                }),
            ],
        ],
    ]);
    assert.equal(fromAssistant.unrecognisedCandidates[0].citedRole, "assistant");
});

test("the turn a quote came from separates a statement from a correction", () => {
    const kase = emptyGoldCase("c5");
    const opening = run([
        [kase, [candidate({ evidence: [{ evidenceMessageId: "c5-m1", evidenceQuote: "동생 대신 물어봐요." }] })]],
    ]);
    assert.equal(opening.unrecognisedCandidates[0].earliestCitedTurn, 0);
    const later = run([
        [kase, [candidate({ evidence: [{ evidenceMessageId: "c5-m2", evidenceQuote: "확인이 우선입니다." }] })]],
    ]);
    assert.equal(later.unrecognisedCandidates[0].earliestCitedTurn, 1);
});

test("a run that produced nothing is silent, not relabelled", () => {
    const kase = goldCase("c6");
    const diagnosis = run([[kase, []]]);
    assert.equal(diagnosis.unmatchedGold.length, 1);
    assert.equal(diagnosis.unmatchedGold[0].shape, "silent");
    assert.deepEqual(diagnosis.unmatchedGold[0].relabelledAs, []);
});

test("a case the dataset does not carry is skipped rather than guessed at", () => {
    // Diagnosing an artifact against a sample that does not contain its cases
    // would resolve nothing and report confidently. The script refuses on the
    // dataset digest; this is the module's own half of that.
    const kase = goldCase("c7");
    const diagnosis = diagnoseRun({
        records: [recordFor(kase, [])],
        cases: [],
        criticalCategories: MEMORY_EVAL_CRITICAL_CATEGORIES,
    });
    assert.deepEqual([...diagnosis.unmatchedGold], []);
    assert.deepEqual([...diagnosis.unrecognisedCandidates], []);
});

test("tally counts and orders, most frequent first", () => {
    assert.deepEqual(
        [...tally(["a", "b", "a", "c", "b", "a"], (row) => row)],
        [
            { key: "a", count: 3 },
            { key: "b", count: 2 },
            { key: "c", count: 1 },
        ]
    );
});

/* ----------------------------------------------- what it must not claim -- */

test("neither the module nor the report names a cause", () => {
    // The four causes — prompt defect, taxonomy mismatch, gold defect, model
    // error — are a person's call, recorded in an audit. A field or a printed
    // line that assigned one would make this a verdict wearing a report's
    // name, and the audit would then be quoting the tool's guess back at
    // itself.
    const source = readFileSync(
        fileURLToPath(new URL("../lib/memoryEvalFailureDiagnosis.ts", import.meta.url)),
        "utf8"
    );
    const report = readFileSync(
        fileURLToPath(
            new URL("../scripts/report-memory-eval-failure-diagnosis.mjs", import.meta.url)
        ),
        "utf8"
    );
    // Read off the exported shape rather than the prose: no field may be named
    // for a cause.
    const kase = emptyGoldCase("c8");
    const diagnosis = run([
        [kase, [candidate({ evidence: [{ evidenceMessageId: "c8-m1", evidenceQuote: "동생 대신 물어봐요." }] })]],
    ]);
    for (const field of Object.keys(diagnosis.unrecognisedCandidates[0])) {
        assert.ok(
            !/defect|cause|error|blame/i.test(field),
            `${field} names a cause; this module reports observations`
        );
    }
    // And both files say so, so a later editor knows it is a rule rather than
    // an omission.
    assert.match(source, /does not decide which|not decide/);
    assert.match(report, /does not decide whether a group is/);
});
