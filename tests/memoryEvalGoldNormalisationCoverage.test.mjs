/**
 * Every gold must be satisfiable by the text it was drawn from.
 *
 * This is the check that should have decided the shape of
 * `KOREAN_NUMERAL_EXPRESSIONS` and did not. Narrowing the Korean numeral step
 * from a numeral-by-counter cross-product to a reviewed table is only safe if
 * the table still covers every equivalence a frozen gold depends on, and the
 * survey behind the first draft asked only half the question: it looked for
 * golds *written in Korean numerals*, so it found `육 개월` and `새벽 세 시`
 * and missed `succ-durable-ko-401`, whose gold is the digit `9시` and whose
 * only statement of the fact is `가게 문을 아홉 시에 열어서`.
 *
 * The requirement is symmetric, so the test is stated symmetrically: it does
 * not look at numerals at all. It asks the question the scorer asks — can this
 * gold be found in this case's own text under the live contract — of every
 * gold in every schema-3 dataset the tree assembles.
 *
 * ## Why this belongs in the tree rather than in a survey
 *
 * A survey is run once by whoever is making the change, and it answers the
 * question that person thought to ask. This runs on every commit and answers
 * the question the scorer will actually ask. A row removed from the table, a
 * step reordered, a case edited to state a fact only in words while its gold
 * says digits — each of those fails here, at the commit that causes it.
 *
 * ## What it does not claim
 *
 * That a *model* will phrase things the way the corpus does. Nothing in the
 * repository can establish that. This establishes the weaker, checkable thing:
 * the golds and the contract agree with each other, so a failure here is
 * always the tree's fault and never the model's.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { harnessTarget } from "../lib/memoryEvalHarnessTarget.ts";
import { canonMatch } from "../lib/memoryEvalCanonicalisation.ts";

/**
 * Every schema-3 dataset the tree still assembles, not just the target.
 *
 * A superseded dataset's cases are still read — `resolveArtifactDataset()`
 * scores old artifacts against them — so a contract change that made one of
 * their golds unsatisfiable would make those artifacts unreadable without
 * anything saying so.
 */
const DATASETS = [
    "mem-eval-succ-4",
    "mem-eval-succ-5",
    "mem-eval-succ-6",
    "mem-eval-succ-7",
    "mem-eval-succ-8",
];

/**
 * The text a gold may legitimately be grounded in: **its own anchored user
 * turn**, and nothing else.
 *
 * This has been narrowed twice, and each wider version hid the failure the
 * file exists to find.
 *
 * The first joined every conversation title and every message, assistant turns
 * included. `v3-evidence-binding` credits an adoption only when the quote
 * occurs in a *user* message, so a gold reachable only from a title or from
 * the model's own sentence is a gold the scorer cannot satisfy — and that
 * version called it covered.
 *
 * Narrowing to "all user turns" was still too loose. A gold anchors to one
 * message by id and the scorer reads *that* message, so a gold whose anchor
 * points at the wrong turn is satisfied by a different turn under the union —
 * and a mis-anchored gold is exactly the defect worth catching. The haystack
 * is therefore the anchored message alone.
 *
 * A gold that needs more than its own anchor to be found is a finding, not a
 * false alarm.
 */
const anchoredUserText = (testCase, gold) => {
    const messages = (testCase.conversations ?? []).flatMap(
        (conversation) => conversation.messages ?? []
    );
    const anchor = gold.evidence ?? {};
    const byId =
        anchor.evidenceMessageId === undefined
            ? undefined
            : messages.find(
                  (message) => message.externalMessageId === anchor.evidenceMessageId
              );
    const byIndex =
        anchor.evidenceMessageIndex === undefined
            ? undefined
            : messages[anchor.evidenceMessageIndex];
    const message = byId ?? byIndex;
    // An anchor resolving to nothing, or to a turn the user did not write, is
    // reported rather than quietly replaced by text that would have matched.
    if (!message) {
        return { text: "", problem: "its evidence anchor resolves to no message" };
    }
    if (message.role !== "user") {
        return {
            text: "",
            problem: `its evidence anchor points at a ${message.role} turn`,
        };
    }
    return { text: message.content, problem: null };
};

const unsatisfiable = (datasetVersion) => {
    const target = harnessTarget(datasetVersion);
    const problems = [];
    for (const testCase of target.cases) {
        for (const gold of testCase.expected ?? []) {
            const anchored = anchoredUserText(testCase, gold);
            if (anchored.problem) {
                problems.push(`${testCase.id}/${gold.id}: ${anchored.problem}`);
                continue;
            }
            const haystack = canonMatch(anchored.text, testCase.language);
            const has = (token) =>
                haystack.includes(canonMatch(token, testCase.language));
            // `factValueAll` is every token; `factValueAny` is at least one.
            // Applying the wrong rule to `factValueAny` reports every synonym
            // a gold offers as a failure, which is 17 false alarms here and
            // would bury the one real finding.
            for (const token of gold.factValueAll ?? []) {
                if (!has(token)) {
                    problems.push(
                        `${testCase.id}/${gold.id}: factValueAll ${JSON.stringify(token)} ` +
                            `does not occur in its anchored user turn`
                    );
                }
            }
            const any = gold.factValueAny ?? [];
            if (any.length > 0 && !any.some(has)) {
                problems.push(
                    `${testCase.id}/${gold.id}: none of factValueAny ` +
                        `${JSON.stringify(any)} occurs in its anchored user turn`
                );
            }
        }
    }
    return problems;
};

for (const datasetVersion of DATASETS) {
    test(`every gold in ${datasetVersion} is satisfiable by its own anchor`, () => {
        assert.deepEqual(unsatisfiable(datasetVersion), []);
    });
}

test("the check would fail if the numeral table stopped covering a gold", () => {
    // Red-before-green, permanently. Without this the assertions above would
    // pass just as well against a canonicalisation that did nothing at all,
    // because most golds are quoted verbatim from their own text and need no
    // normalisation to be found.
    //
    // `succ-durable-ko-401` is the case that needs it: its gold is `9시` and
    // its text says `아홉 시`. Under a table missing that row the gold is
    // unreachable, which is the state this file was written to catch.
    const target = harnessTarget("mem-eval-succ-8");
    const testCase = target.cases.find((entry) => entry.id === "succ-durable-ko-401");
    assert.ok(testCase, "succ-durable-ko-401 is not in the dataset");
    const text = anchoredUserText(testCase, testCase.expected[0]).text;
    assert.match(text, /아홉 시/, "the case states the hour in words");
    assert.deepEqual(
        testCase.expected.flatMap((gold) => gold.factValueAll ?? []),
        ["9시"],
        "and its gold states it as a digit"
    );
    // The two meet only because the table says so, and only where the left
    // boundary allows it. There is no right boundary since 2026-09-04, so a
    // noun beginning with the counter is rewritten as well — the substring
    // residual, which reaches the gold in either spelling.
    assert.ok(canonMatch(text, "ko").includes(canonMatch("9시", "ko")));
    assert.equal(canonMatch("아홉 시장", "ko"), "9시장");
    // And the left boundary still holds, which is what keeps 열아홉 시에 out.
    assert.equal(canonMatch("열아홉 시에", "ko"), "열아홉시에");
});
