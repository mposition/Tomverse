/**
 * The budget's binding to an instrument, and the three refusals that enforce
 * it.
 *
 * The 2026-08-28 re-approval names an immutable tuple — dataset, contract and
 * prompt, each with its version and digest — and says the approval "loses
 * effect immediately" if any of them differs. A sentence in an audit cannot do
 * that, so this is the sentence as a gate, and these are its cases.
 *
 * The last test is the one that matters most in a year's time: it recomputes
 * the tuple from the tree and holds the registered values against it. A digest
 * that drifts fails here rather than in a paid run.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
    evalBudgetBindingProblems,
    evalBudgetTupleFailures,
    isFullCommitSha,
} from "../lib/memoryEvalBudgetBinding.ts";
import { decideEvalRunMode } from "../lib/memoryExtractionEvalCore.ts";
import {
    MEMORY_EXTRACTION_EVAL_REGISTER,
    findEvalRegisterProblems,
} from "../lib/memoryExtractionEvalRegister.ts";
import { harnessTarget } from "../lib/memoryEvalHarnessTarget.ts";
import { MEMORY_EVAL_SUCC5_MANIFEST } from "../lib/memoryEvalSucc5.ts";
import {
    MEMORY_EXTRACTION_PROMPT_VERSION,
    extractionPromptContract,
} from "../lib/memoryExtractionPrompt.ts";

const fundedPair = () => {
    const entry = MEMORY_EXTRACTION_EVAL_REGISTER.find(
        (candidate) =>
            candidate.extractionModelId === "gpt-5-6-luna" &&
            candidate.promptVersion === "mem-extract-v6"
    );
    assert.ok(entry, "the funded pair is not registered");
    return entry;
};

/* ------------------------------------------------------------ the tuple -- */

test("v6's instrument cannot fund the prompt this tree now ships", () => {
    // The whole point, and it reads inverted since 2026-08-31 because the
    // tree moved on. Every value below is still recomputed rather than
    // restated; what changed is which answer is correct.
    //
    // While the tree shipped v6 this asserted no divergence at all. The tree
    // now ships `mem-extract-v7`, so v6's instrument no longer describes the
    // bytes a run would use — and the comparison firing is the protection
    // working, not a stale expectation. Asserting emptiness here today would
    // mean asserting that a v7 run may proceed on v6's approval, which is
    // precisely what this file exists to prevent.
    //
    // Both halves are pinned. The dataset and contract must still match,
    // because nothing approved them to move; the prompt fields must differ,
    // and by exactly the two names below, so a *third* divergence appearing
    // quietly is a failure rather than noise inside an expected one.
    const budget = fundedPair().evalBudget;
    assert.ok(budget?.boundTuple, "the funded pair records no instrument");
    const target = harnessTarget();
    const actual = {
        datasetVersion: target.datasetVersion,
        datasetDigest: target.datasetDigest,
        datasetManifestDigest: MEMORY_EVAL_SUCC5_MANIFEST.manifestDigest,
        scoringContractVersion: target.scoringContractVersion,
        scoringContractDigest: target.scoringContractDigest,
        promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION,
        promptDigest: createHash("sha256")
            .update(extractionPromptContract(), "utf8")
            .digest("hex"),
    };
    const failures = [...evalBudgetTupleFailures(budget.boundTuple, actual)];
    assert.ok(
        failures.length > 0,
        "v6's budget still matches the shipped prompt — a v7 run could take it"
    );
    assert.deepEqual(
        failures.map((line) => line.split(":")[0]).sort(),
        ["promptDigest", "promptVersion"],
        `only the prompt was approved to move; failures were:\n${failures.join("\n")}`
    );
    // Named rather than left to the field list: the dataset and the contract
    // are what a moved digest would show up in, and they must be silent.
    assert.equal(budget.boundTuple.datasetDigest, actual.datasetDigest);
    assert.equal(budget.boundTuple.datasetManifestDigest, actual.datasetManifestDigest);
    assert.equal(budget.boundTuple.scoringContractDigest, actual.scoringContractDigest);

    // And the approved values, written out, so the diff of any future change
    // to this file shows what was approved rather than only that it moved.
    assert.deepEqual(budget.boundTuple, {
        datasetVersion: "mem-eval-succ-5",
        datasetDigest:
            "0a516821da60669da6763528a414d0433e11e38db8eca56c690667cc7b2a18f0",
        datasetManifestDigest:
            "215b679444c610928975c63b8c095f98eefb0d0bd22f28acff3255fcaf464762",
        scoringContractVersion: "mem-score-v3.4",
        scoringContractDigest:
            "a62f4bdd8d2073345e19e478541c20d81275a0d11fb78aa6e4df86ec0489b4cd",
        promptVersion: "mem-extract-v6",
        promptDigest:
            "c85389d8360a997fe80e4d8905304c223f67f67b1676fa2df483daf902b05052",
    });
});

test("the ceiling, the run count and the implementation SHA are recorded", () => {
    const budget = fundedPair().evalBudget;
    assert.equal(budget.approvedBy, "@mposition");
    assert.equal(budget.approvedAt, "2026-08-28");
    assert.equal(budget.maxProviderDispatchedRuns, 2);
    assert.equal(
        budget.approvedImplementationSha,
        "34a53ddc0247661e578422300ecc58801ea73fce"
    );
    assert.ok(isFullCommitSha(budget.approvedImplementationSha));
});

test("maxUsd is the per-run ceiling and the programme total is separate", () => {
    // The correction of 2026-08-28. `maxUsd` reached the harness as
    // `ceilingUsd` and was compared against `accruedCostUsd`, which starts at
    // zero on every invocation — so recording the US$12.57 programme figure
    // here authorised it *twice*, US$25.14 across the two approved runs. The
    // two numbers are now separate fields, and this is the pair of assertions
    // that keeps them from collapsing back into one.
    const budget = fundedPair().evalBudget;
    assert.equal(budget.maxUsd, 6.285);
    assert.equal(budget.programmeMaxMicroUsd, 12_570_000);
    assert.equal(
        budget.maxUsd * 1_000_000 * budget.maxProviderDispatchedRuns,
        budget.programmeMaxMicroUsd,
        "the per-run ceiling times the approved runs is not the programme total"
    );
    // Stated as its own assertion because it is the mistake, not a corollary:
    // the programme figure must not be what one run may spend.
    assert.notEqual(budget.maxUsd, budget.programmeMaxMicroUsd / 1_000_000);
});

test("a per-run ceiling that would overspend the programme is a register problem", () => {
    // The check that makes the two fields agree, exercised on the shape it
    // exists to catch: the programme figure written into `maxUsd` again.
    const budget = fundedPair().evalBudget;
    const problems = findEvalRegisterProblems([
        {
            ...fundedPair(),
            evalBudget: { ...budget, maxUsd: 12.57 },
        },
    ]);
    assert.ok(
        problems.some((line) => line.includes("above the")),
        problems.join(" | ")
    );
    // And the registered shape has none.
    assert.deepEqual(
        [...findEvalRegisterProblems(MEMORY_EXTRACTION_EVAL_REGISTER)],
        []
    );
});

test("exactly one v6 pair is funded, and it is the approved one", () => {
    // The re-approval funds one pair and says a budget cannot be transferred
    // or applied to another. A second funded v6 entry would be that transfer,
    // however it was labelled.
    const funded = MEMORY_EXTRACTION_EVAL_REGISTER.filter(
        (entry) => entry.promptVersion === "mem-extract-v6" && entry.evalBudget
    );
    assert.deepEqual(
        funded.map((entry) => entry.extractionModelId),
        ["gpt-5-6-luna"]
    );
    const backup = MEMORY_EXTRACTION_EVAL_REGISTER.find(
        (entry) =>
            entry.extractionModelId === "gpt-5-4-mini" &&
            entry.promptVersion === "mem-extract-v6"
    );
    assert.equal(backup.evalBudget, null);
});

test("every differing field is named, not just the first", () => {
    const approved = fundedPair().evalBudget.boundTuple;
    const failures = evalBudgetTupleFailures(approved, {
        ...approved,
        datasetVersion: "mem-eval-succ-4",
        datasetDigest: "f".repeat(64),
        promptDigest: "a".repeat(64),
    });
    assert.equal(failures.length, 3);
    for (const field of ["datasetVersion", "datasetDigest", "promptDigest"]) {
        assert.ok(
            failures.some((line) => line.startsWith(`${field}:`)),
            `${field} went unreported: ${failures.join(" | ")}`
        );
    }
});

/* --------------------------------------------------------- the binding -- */

test("a budget with no instrument cannot fund a run", () => {
    // Every budget recorded before 2026-08-28 is this shape. They were real
    // approvals and stay on the register; what they cannot do is authorise a
    // run, because "which instrument was this ceiling for" has no answer.
    const problems = evalBudgetBindingProblems({
        approvedBy: "@mposition",
        maxUsd: 20,
    });
    assert.equal(problems.length, 2, problems.join(" | "));
    assert.ok(problems.some((line) => line.includes("records no instrument")));
    assert.ok(problems.some((line) => line.includes("approvedImplementationSha")));
});

test("a short or malformed implementation SHA is refused", () => {
    const boundTuple = fundedPair().evalBudget.boundTuple;
    for (const sha of ["34a53ddc", "", "Z".repeat(40), "34A53DDC0247661E578422300ECC58801EA73FCE"]) {
        const problems = evalBudgetBindingProblems({
            boundTuple,
            approvedImplementationSha: sha,
        });
        assert.equal(problems.length, 1, `${sha}: ${problems.join(" | ")}`);
    }
    assert.deepEqual(
        [
            ...evalBudgetBindingProblems({
                boundTuple,
                approvedImplementationSha: "34a53ddc0247661e578422300ecc58801ea73fce",
            }),
        ],
        []
    );
});

test("a run count that is not a positive whole number is refused", () => {
    const boundTuple = fundedPair().evalBudget.boundTuple;
    for (const runs of [0, -1, 1.5, Number.NaN]) {
        const problems = evalBudgetBindingProblems({
            boundTuple,
            approvedImplementationSha: "34a53ddc0247661e578422300ecc58801ea73fce",
            maxProviderDispatchedRuns: runs,
        });
        assert.equal(problems.length, 1, `${runs}: ${problems.join(" | ")}`);
    }
});

/* ------------------------------------------------------------- the gate -- */

const liveInput = (overrides = {}) => ({
    live: true,
    registerEntry: { status: "candidate", evalBudget: { maxUsd: 20 } },
    hasApiKey: true,
    datasetFrozen: true,
    datasetPurpose: "decision",
    datasetSchemaVersion: harnessTarget().datasetSchemaVersion,
    commitKnown: true,
    budgetBindingProblems: [],
    budgetTupleFailures: [],
    runShaDescendsFromApproval: true,
    ...overrides,
});

test("the three budget conditions each refuse, in their own order", () => {
    assert.deepEqual(decideEvalRunMode(liveInput()), {
        mode: "live",
        ceilingUsd: 20,
    });

    for (const [override, reason] of [
        [{ budgetBindingProblems: ["unbound"] }, "budget_not_bound"],
        [{ budgetTupleFailures: ["datasetDigest: ..."] }, "budget_tuple_mismatch"],
        [{ runShaDescendsFromApproval: false }, "run_sha_not_descendant"],
        // Undefined is a refusal too: git could not answer, and an ancestry
        // nobody could check is an ancestry nobody has.
        [{ runShaDescendsFromApproval: undefined }, "run_sha_not_descendant"],
    ]) {
        assert.deepEqual(
            decideEvalRunMode(liveInput(override)),
            { mode: "refused", reason },
            JSON.stringify(override)
        );
    }

    // Order: an unbound budget answers before a mismatched tuple, because a
    // budget with no tuple has nothing to mismatch.
    assert.equal(
        decideEvalRunMode(
            liveInput({
                budgetBindingProblems: ["unbound"],
                budgetTupleFailures: ["datasetDigest: ..."],
                runShaDescendsFromApproval: false,
            })
        ).reason,
        "budget_not_bound"
    );
});

test("a caller that says nothing about the binding is refused", () => {
    // Fail-closed by omission. A live decision reached without the caller
    // establishing the binding is a live decision nobody checked, and the
    // whole point of the re-approval is that this cannot pass silently.
    const decision = decideEvalRunMode({
        live: true,
        registerEntry: { status: "candidate", evalBudget: { maxUsd: 20 } },
        hasApiKey: true,
        datasetFrozen: true,
        datasetPurpose: "decision",
        datasetSchemaVersion: harnessTarget().datasetSchemaVersion,
        commitKnown: true,
    });
    assert.deepEqual(decision, {
        mode: "refused",
        reason: "run_sha_not_descendant",
    });
});

test("a run beyond the approved count refuses, and an unstated one too", () => {
    // The approval covers a fixed number of provider-dispatched runs and
    // nothing in the tree can count them, so the invocation says which run it
    // is. A budget that names no run count leaves the gate inert — every
    // budget recorded before 2026-08-28 is that shape — which is why the
    // entry here carries one.
    const twoRuns = (runOrdinal) =>
        liveInput({
            registerEntry: {
                status: "candidate",
                evalBudget: { maxUsd: 20, maxProviderDispatchedRuns: 2 },
            },
            runOrdinal,
        });

    for (const ordinal of [1, 2]) {
        assert.deepEqual(
            decideEvalRunMode(twoRuns(ordinal)),
            { mode: "live", ceilingUsd: 20 },
            `run ${ordinal}`
        );
    }
    for (const ordinal of [undefined, 0, 3, -1, 1.5, Number.NaN]) {
        assert.deepEqual(
            decideEvalRunMode(twoRuns(ordinal)),
            { mode: "refused", reason: "run_ordinal_not_approved" },
            String(ordinal)
        );
    }
    // Absent is a refusal rather than a default of 1. A default would make
    // every unstated run the first one, which is the accounting this gate
    // exists to prevent.
    assert.equal(
        decideEvalRunMode(twoRuns(undefined)).reason,
        "run_ordinal_not_approved"
    );
    // The instrument is checked first: a third run of the wrong instrument is
    // wrong for the instrument, whichever run it claims to be.
    assert.equal(
        decideEvalRunMode({
            ...twoRuns(3),
            budgetTupleFailures: ["datasetDigest: ..."],
        }).reason,
        "budget_tuple_mismatch"
    );
});

test("a budget that names no run count leaves the ordinal unasked", () => {
    // Every budget from before 2026-08-28. They cannot fund a run for other
    // reasons, and this gate is not one of them.
    assert.deepEqual(decideEvalRunMode(liveInput({ runOrdinal: undefined })), {
        mode: "live",
        ceilingUsd: 20,
    });
});

test("smoke mode is not gated by any of it", () => {
    // None of this is about smoke: it spends nothing, so there is no approval
    // to bind it to.
    assert.deepEqual(
        decideEvalRunMode(
            liveInput({
                live: false,
                budgetBindingProblems: ["unbound"],
                budgetTupleFailures: ["datasetDigest: ..."],
                runShaDescendsFromApproval: false,
            })
        ),
        { mode: "smoke" }
    );
});
