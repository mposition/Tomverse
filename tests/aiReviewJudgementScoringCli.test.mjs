// The offline flow, run as a flow: files in, a score out, and the question a
// later reader has to be able to ask about a stored number.
//
// The unit tests cover what the scorer decides. These cover the part that
// arithmetic cannot: that a score written beside a case, an output and a
// judgement record STOPS being about them the moment any of the three is
// edited, and says so rather than going on saying what it said.
//
// No provider is called. Everything here is local files.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AI_REVIEW_SCORING_CONTRACT_VERSION } from "../lib/aiReviewEvalJudgement.ts";

const DEADLINE = "objection_deadline";

const testCase = () => ({
    caseId: "ko-safety-sensitive-003",
    contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
    responseLabels: ["a", "b", "c"],
    requirements: [
        { id: DEADLINE, description: "송달일부터 2주 이내 이의신청 기한" },
        { id: "evidence_preservation", description: "변제 입증 자료 보존" },
    ],
    gold: { missingPoints: [{ requirementId: DEADLINE, targetLabel: "c" }] },
    goldCompleteness: { missingPoints: true },
});

const observation = () => ({
    findings: {
        contradictions: [],
        missingPoints: ["c는 이의신청 기한을 제시하지 않는다"],
        differences: [],
    },
    allText: "c는 이의신청 기한을 제시하지 않는다",
    reviewerProse: "c는 이의신청 기한을 제시하지 않는다",
    totalQuotes: 0,
    matchedQuotes: 0,
});

const claim = (overrides = {}) => ({
    targetLabel: "c",
    requirementId: DEADLINE,
    assertion: "missing",
    speechAct: "finding",
    submittedAs: "missingPoints",
    sourceIndex: 0,
    evidenceQuote: "c는 이의신청 기한을 제시하지 않는다",
    status: "confirmed",
    confirmedBy: "operator",
    confirmedAt: "2026-09-08T00:00:00.000Z",
    ...overrides,
});

const record = (observationRef, claims = [claim()]) => ({
    caseId: "ko-safety-sensitive-003",
    contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
    observationRef,
    reviewedBy: "operator",
    reviewedAt: "2026-09-08T00:00:00.000Z",
    claims,
});

const run = (directory, extra = []) =>
    new Promise((resolve) => {
        const child = spawn(
            process.execPath,
            [
                "--conditions=react-server",
                "--import",
                "tsx",
                "scripts/score-ai-review-judgements.mjs",
                `--dir=${directory}`,
                ...extra,
            ],
            { env: process.env }
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("close", (status) => resolve({ status, stdout, stderr }));
    });

const write = (root, name, value) =>
    writeFileSync(join(root, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
const read = (root, name) => JSON.parse(readFileSync(join(root, name), "utf8"));

/**
 * Writes the three inputs with a record that names the output correctly.
 *
 * The reference is not invented here: the first scoring run derives it from
 * the output and the record is rewritten to match, which is the same order the
 * real flow uses -- read the output, then say which output you read.
 */
const fixture = async (t) => {
    const root = mkdtempSync(join(tmpdir(), "ai-review-judged-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    write(root, "case.json", testCase());
    write(root, "observation.json", observation());
    write(root, "record.json", record("unknown-until-scored"));
    // One pass to learn the derived reference, then a record that names it.
    await run(root);
    const observationRef = read(root, "artifact.json").observationRef;
    write(root, "record.json", record(observationRef));
    return { root, observationRef };
};

test("a signed record over a registered case scores, and the score verifies", async (t) => {
    const { root } = await fixture(t);

    const scored = await run(root);
    assert.equal(scored.status, 0, scored.stderr);
    assert.match(scored.stdout, /case registration\n {2}ok/);
    assert.match(scored.stdout, /judgement record\n {2}ok/);
    assert.match(scored.stdout, /missingPoints\s+TP 1\s+FN 0\s+FP 0/);

    const artifact = read(root, "artifact.json");
    assert.equal(artifact.outcome.scored, true);
    assert.equal(artifact.outcome.byKind.missingPoints.truePositives, 1);

    const verified = await run(root, ["--verify"]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /The stored score is about these files/);
});

test("editing the judgement record makes the stored score stale until re-scored", async (t) => {
    // The failure a file flow exists to catch. Nothing about the artifact
    // changes when the record does, so without recomputing the digests it goes
    // on reporting a true positive for a judgement nobody is making any more.
    const { root, observationRef } = await fixture(t);
    await run(root);

    write(
        root,
        "record.json",
        record(observationRef, [claim({ assertion: "present" })])
    );

    const stale = await run(root, ["--verify"]);
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /judgement record has changed since this was scored/);
    assert.match(stale.stderr, /not about these files/);

    // Re-scoring is what makes it a statement about these files again -- and
    // the statement is different, because the judgement is.
    const rescored = await run(root);
    assert.equal(rescored.status, 0, rescored.stderr);
    assert.equal(read(root, "artifact.json").outcome.byKind.missingPoints.truePositives, 0);

    const verified = await run(root, ["--verify"]);
    assert.equal(verified.status, 0, verified.stderr);
});

test("editing the gold makes the stored score stale, and the reference is derived", async (t) => {
    const { root } = await fixture(t);
    await run(root);

    const widened = testCase();
    widened.gold.missingPoints = [
        ...widened.gold.missingPoints,
        { requirementId: "evidence_preservation", targetLabel: "c" },
    ];
    write(root, "case.json", widened);

    const stale = await run(root, ["--verify"]);
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /case has changed since this was scored/);

    // And changing the OUTPUT is caught without anybody editing a reference,
    // which is the point of deriving it from the output's own content.
    write(root, "case.json", testCase());
    const rewritten = observation();
    rewritten.findings.missingPoints = ["다른 출력"];
    write(root, "observation.json", rewritten);

    const movedOutput = await run(root, ["--verify"]);
    assert.equal(movedOutput.status, 1);
    assert.match(movedOutput.stdout, /scored from a different reviewer output/);
    assert.match(movedOutput.stdout, /record names a different reviewer output/);
});

test("a gold naming something the case never registered is refused before scoring", async (t) => {
    const { root } = await fixture(t);
    const mistyped = testCase();
    mistyped.gold.missingPoints = [{ requirementId: "objection_deadlien", targetLabel: "c" }];
    write(root, "case.json", mistyped);

    const result = await run(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /which the case does not register/);
    assert.match(result.stderr, /Nothing was scored/);

    const wrongLabel = testCase();
    wrongLabel.gold.missingPoints = [{ requirementId: DEADLINE, targetLabel: "d" }];
    write(root, "case.json", wrongLabel);
    const labelResult = await run(root);
    assert.equal(labelResult.status, 1);
    assert.match(labelResult.stdout, /which the case does not have/);
});

test("a reviewer's finding about an unregistered requirement is NOT a registration error", async (t) => {
    // The boundary. The catalogue constrains the case's own gold and nothing
    // else -- a case's list is not the limit of what is true about it, and
    // rejecting a new finding for being unlisted would close the one route
    // this contract has for discovering an incomplete gold.
    const { root, observationRef } = await fixture(t);
    write(
        root,
        "record.json",
        record(observationRef, [
            claim(),
            claim({
                requirementId: "reignition_guard",
                sourceIndex: 1,
                outsideGoldVerdict: "gold_incomplete",
            }),
        ])
    );

    const result = await run(root);
    assert.equal(result.status, 0, result.stderr);
    // The case registration passes: the claim is not a registration problem.
    assert.match(result.stdout, /case registration\n {2}ok/);
    // It is a judgement, and the judgement disproves an exhaustive gold.
    assert.match(result.stdout, /not scored/);
    assert.match(result.stdout, /confirmed gold gap: missingPoints 1/);

    // The refusal is written to the artifact rather than discarded, because it
    // is what the case has to be corrected with.
    const artifact = read(root, "artifact.json");
    assert.equal(artifact.outcome.scored, false);
    assert.equal(artifact.outcome.goldGaps.missingPoints, 1);
});
