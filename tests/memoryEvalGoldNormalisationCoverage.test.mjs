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
 * The text a gold may legitimately be grounded in: **user turns only**.
 *
 * The first version of this file joined every conversation title and every
 * message, assistant turns included, and that hides the failure it exists to
 * find. `v3-evidence-binding` credits an adoption only when the quote occurs
 * in a *user* message, so a gold reachable only from a title or an assistant
 * sentence is a gold the scorer cannot satisfy — and the loose version would
 * have reported it as covered. Titles are labels the harness writes into the
 * prompt, not things the user said; assistant turns are the model's own words,
 * and grounding a fact about the user in them is the injection failure the
 * critical categories exist for.
 *
 * So the haystack is narrower than the prompt on purpose. A gold that needs
 * more than this to be found is a finding, not a false alarm.
 */
const groundingText = (testCase) =>
    (testCase.conversations ?? [])
        .flatMap((conversation) =>
            (conversation.messages ?? [])
                .filter((message) => message.role === "user")
                .map((message) => message.content)
        )
        .join("\n");

const unsatisfiable = (datasetVersion) => {
    const target = harnessTarget(datasetVersion);
    const problems = [];
    for (const testCase of target.cases) {
        const haystack = canonMatch(groundingText(testCase), testCase.language);
        for (const gold of testCase.expected ?? []) {
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
                            `does not occur in the case's own text`
                    );
                }
            }
            const any = gold.factValueAny ?? [];
            if (any.length > 0 && !any.some(has)) {
                problems.push(
                    `${testCase.id}/${gold.id}: none of factValueAny ` +
                        `${JSON.stringify(any)} occurs in the case's own text`
                );
            }
        }
    }
    return problems;
};

for (const datasetVersion of DATASETS) {
    test(`every gold in ${datasetVersion} is satisfiable by its own case`, () => {
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
    const text = groundingText(testCase);
    assert.match(text, /아홉 시/, "the case states the hour in words");
    assert.deepEqual(
        testCase.expected.flatMap((gold) => gold.factValueAll ?? []),
        ["9시"],
        "and its gold states it as a digit"
    );
    // The two meet only because the table says so.
    assert.equal(canonMatch("아홉 시", "ko"), canonMatch("9시", "ko"));
});
