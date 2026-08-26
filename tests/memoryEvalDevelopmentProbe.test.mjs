import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    MEMORY_EVAL_DEVELOPMENT_PROBE_CASES,
    MEMORY_EVAL_DEVELOPMENT_PROBE_PURPOSE,
} from "../lib/memoryEvalDevelopmentProbeSet.ts";
import { validateSuccessorDataset } from "../lib/memoryEvalDatasetSchema.ts";
import { MEMORY_EXTRACTION_EVAL_REGISTER } from "../lib/memoryExtractionEvalRegister.ts";
import { MEMORY_EXTRACTION_PROMPT_VERSION } from "../lib/memoryExtractionPrompt.ts";
import { scoreCaseV2, judgeEvalV2 } from "../lib/memoryEvalScoringV2.ts";

/**
 * The probe set has one job: make every metric move.
 *
 * A metric with no case that exercises it is a metric nobody has seen work,
 * and the probe's whole purpose is to find that out before a decision-grade
 * run rests on it. So the assertions below are about coverage — one case per
 * defect, one case per counter — rather than about numbers.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const byId = (id) =>
    MEMORY_EVAL_DEVELOPMENT_PROBE_CASES.find((entry) => entry.id === id);

test("the set validates as a development set", () => {
    const result = validateSuccessorDataset({
        cases: MEMORY_EVAL_DEVELOPMENT_PROBE_CASES,
        purpose: MEMORY_EVAL_DEVELOPMENT_PROBE_PURPOSE,
    });
    assert.deepEqual(result.errors, []);
});

test("it could never be mistaken for a decision set", () => {
    // Two independent reasons, and both are asserted: it contains a partial
    // case, and it is nowhere near the floor. Either alone would do; relying
    // on one would let a later edit remove it silently.
    const result = validateSuccessorDataset({
        cases: MEMORY_EVAL_DEVELOPMENT_PROBE_CASES,
        purpose: "decision",
    });
    assert.equal(result.ok, false);
    const codes = new Set(result.errors.map((error) => error.code));
    assert.ok(codes.has("partial_in_decision_set"));
    assert.ok(codes.has("arm_below_exhaustive_floor"));
});

test("both arms and all four categories are present", () => {
    const cells = new Set(
        MEMORY_EVAL_DEVELOPMENT_PROBE_CASES.map(
            (entry) => `${entry.category}:${entry.language}`
        )
    );
    for (const category of [
        "durable_facts",
        "assistant_only",
        "sensitive_secrets",
        "injection_directives",
    ]) {
        assert.ok(
            [...cells].some((cell) => cell.startsWith(`${category}:`)),
            `${category} is not probed`
        );
    }
    for (const language of ["ko", "en"]) {
        assert.ok(
            [...cells].some((cell) => cell.endsWith(`:${language}`)),
            `${language} is not probed`
        );
    }
});

test("every metric has a case that moves it", () => {
    // Precision: a case with an empty gold and a non-zero denominator, so a
    // stray candidate has somewhere to land.
    assert.ok(
        MEMORY_EVAL_DEVELOPMENT_PROBE_CASES.some(
            (entry) =>
                entry.category === "durable_facts" &&
                entry.expected.length === 0 &&
                entry.goldCompleteness === "exhaustive"
        ),
        "nothing exercises precision with an empty gold"
    );
    // Recall and bulk eligibility.
    assert.ok(
        MEMORY_EVAL_DEVELOPMENT_PROBE_CASES.some((entry) =>
            entry.expected.some(
                (expected) => expected.expectedDisposition === "bulk_safe"
            )
        )
    );
    // The sensitive-review axis, in both directions: held correctly, and a
    // lookalike that must stay bulk-safe.
    assert.ok(
        MEMORY_EVAL_DEVELOPMENT_PROBE_CASES.some((entry) =>
            entry.expected.some(
                (expected) => expected.expectedDisposition === "sensitive_review"
            )
        )
    );
    assert.ok(byId("probe-health-lookalike"), "no health lookalike case");
    // The critical counter.
    assert.ok(
        MEMORY_EVAL_DEVELOPMENT_PROBE_CASES.some(
            (entry) => entry.category !== "durable_facts"
        )
    );
});

test("each of the four v2 findings has a case", () => {
    for (const id of [
        "probe-lang-ko",
        "probe-lang-mixed",
        "probe-kind-verbosity",
        "probe-kind-residual",
        "probe-decision-weighing",
        "probe-health-own",
        "probe-health-third-party",
        "probe-partial",
    ]) {
        assert.ok(byId(id), `${id} is missing`);
    }
});

test("the third-party gold refuses the medical-profile form", () => {
    const testCase = byId("probe-health-third-party");
    const expected = testCase.expected[0];
    assert.equal(expected.expectedDisposition, "sensitive_review");
    assert.equal(expected.mustInclude.length, 2);
    const profile = "사용자의 아이는 천식이 있다";
    assert.equal(
        expected.mustInclude.every((token) => profile.includes(token)),
        false
    );
});

test("a perfect run still cannot pass at this size", () => {
    // The guarantee the probe rests on. Every case answered correctly, and
    // the verdict is still not a pass — because a sample this small has no
    // verdict to give, which is what keeps a probe from becoming evidence.
    const outcomes = MEMORY_EVAL_DEVELOPMENT_PROBE_CASES.map((testCase) =>
        scoreCaseV2(
            testCase,
            testCase.expected.map((expected) => ({
                kind: expected.kind,
                statement: expected.mustInclude.join(" "),
                bulkSafe: expected.expectedDisposition === "bulk_safe",
                disposition:
                    expected.expectedDisposition === "bulk_safe"
                        ? "accepted"
                        : "sensitive_review_required",
            }))
        )
    );
    const verdict = judgeEvalV2(outcomes);
    assert.equal(verdict.pass, false);
    // docs/policy/external-conversation-import-and-memory.md §12.2's floor.
    assert.ok(
        verdict.failures.some((line) => line.includes("below §12.2 floor"))
    );
    // And the counters that ARE readable at this size are clean.
    assert.equal(verdict.aggregate.criticalBulkSafeAdoptions, 0);
    assert.equal(verdict.aggregate.sensitiveExpectedBulkSafeViolations, 0);
    assert.equal(verdict.aggregate.failures, 0);
});

test("the smoke probe runs clean end to end", () => {
    // The wiring check, executed rather than described: prompt, parser,
    // validator and the schema-2 scorer all agreeing on the real script.
    const output = execFileSync(
        process.execPath,
        [
            "--import",
            "tsx",
            "scripts/probeMemoryExtractionDevelopment.mjs",
        ],
        { cwd: REPO_ROOT, encoding: "utf8" }
    );
    assert.match(output, /SMOKE/);
    assert.match(output, /No finding\./);
    assert.match(output, /decisionGrade: false/);
    // A stub that is right on purpose must score 1.000 on all three ratios.
    // If this drops, something between the prompt and the scorer disagrees.
    assert.match(output, /precision\s+\d+\/\d+ = 1\.000/);
    assert.match(output, /recall\s+\d+\/\d+ = 1\.000/);
    assert.match(output, /bulk eligibility recall\s+\d+\/\d+ = 1\.000/);
});

test("a live probe with no key refuses before it reaches a provider", () => {
    // The key is removed rather than faked. This test used to supply a
    // plausible key and rely on the pair being unfunded — and the moment a
    // person funded the probe pair, that made the test itself dispatch a paid
    // run. A test must not be one approval away from spending money.
    //
    // With no key the refusal is deterministic and provider-independent, and
    // it still proves the property that matters: nothing reaches the network
    // before the gate says so.
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;

    let output = "";
    let status = 0;
    try {
        execFileSync(
            process.execPath,
            [
                "--conditions=react-server",
                "--import",
                "tsx",
                "scripts/probeMemoryExtractionDevelopment.mjs",
                "--live",
            ],
            { cwd: REPO_ROOT, encoding: "utf8", env }
        );
    } catch (error) {
        status = error.status ?? 1;
        output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    assert.equal(status, 1, "a live probe without a key must refuse");
    assert.match(output, /OPENAI_API_KEY is required/i);
    // The refusal came before the run: no report was printed.
    assert.doesNotMatch(output, /Extraction accuracy/);
});
