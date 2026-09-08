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

import {
    AI_REVIEW_SCORING_CONTRACT_VERSION,
    judgedSourceCaseDigest,
    observationRefFor,
} from "../lib/aiReviewEvalJudgement.ts";

const DEADLINE = "objection_deadline";

/** The dataset entry a person judged: the question and the answers themselves. */
const sourceCase = (overrides = {}) => ({
    id: "ko-safety-sensitive-003",
    question: "지급명령에 어떻게 대응해야 합니까?",
    responses: [
        { label: "a", content: "a의 답변" },
        { label: "b", content: "b의 답변" },
        { label: "c", content: "c의 답변" },
    ],
    ...overrides,
});

const testCase = (overrides = {}) => ({
    caseId: "ko-safety-sensitive-003",
    contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
    sourceCaseDigest: judgedSourceCaseDigest(sourceCase()),
    responseLabels: ["a", "b", "c"],
    requirements: [
        { id: DEADLINE, description: "송달일부터 2주 이내 이의신청 기한" },
        { id: "evidence_preservation", description: "변제 입증 자료 보존" },
    ],
    gold: { missingPoints: [{ requirementId: DEADLINE, targetLabel: "c" }] },
    goldCompleteness: { missingPoints: true },
    ...overrides,
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

const record = (observationRef, claims = [claim()], overrides = {}) => ({
    caseId: "ko-safety-sensitive-003",
    contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
    observationRef,
    reviewedBy: "operator",
    reviewedAt: "2026-09-08T00:00:00.000Z",
    // What a person read when they judged, in the record they signed.
    sourceCaseDigest: judgedSourceCaseDigest(sourceCase()),
    claims,
    ...overrides,
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
const fixture = (t) => {
    const root = mkdtempSync(join(tmpdir(), "ai-review-judged-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const output = observation();
    write(root, "case.json", testCase());
    write(root, "observation.json", output);
    // The reference is derived from the output rather than invented, which is
    // the order the real flow uses: read the output, then say which one.
    write(root, "record.json", record(observationRefFor(output)));
    return { root, observationRef: observationRefFor(output) };
};

test("a signed record over a registered case scores, and the score verifies", async (t) => {
    const { root } = fixture(t);

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
    const { root, observationRef } = fixture(t);
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
    const { root } = fixture(t);
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
    const { root } = fixture(t);
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
    const { root } = fixture(t);
    const twoFindings = observation();
    twoFindings.findings.missingPoints = [
        "c는 이의신청 기한을 제시하지 않는다",
        "c는 재발화 방지 안내가 없다",
    ];
    twoFindings.allText = twoFindings.findings.missingPoints.join(" ");
    write(root, "observation.json", twoFindings);
    // A changed output is a different reference, so the record names the new
    // one -- and covers both findings, because a submitted finding nobody
    // judged is a wrong finding that disappears.
    write(
        root,
        "record.json",
        record(observationRefFor(twoFindings), [
            claim(),
            claim({
                requirementId: "reignition_guard",
                sourceIndex: 1,
                evidenceQuote: "c는 재발화 방지 안내가 없다",
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

test("editing the stored score itself is caught, because the score is recomputed", async (t) => {
    // The digests prove the INPUTS have not moved. They prove nothing about
    // the number written beside them, which is a separate object anybody can
    // edit -- and both of these verified clean before the outcome was
    // recomputed and compared whole.
    const { root } = fixture(t);
    await run(root);

    const inflated = read(root, "artifact.json");
    inflated.outcome.byKind.missingPoints.truePositives = 999;
    inflated.outcome.byKind.missingPoints.precisionTruePositives = 999;
    write(root, "artifact.json", inflated);

    const edited = await run(root, ["--verify"]);
    assert.equal(edited.status, 1);
    assert.match(edited.stdout, /stored outcome is not what these inputs produce/);

    // And an artifact with the outcome deleted is not a score at all.
    const gutted = read(root, "artifact.json");
    delete gutted.outcome;
    write(root, "artifact.json", gutted);
    const missing = await run(root, ["--verify"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /an artifact with no outcome is not a score/);

    // Re-scoring restores a statement about these files.
    await run(root);
    const verified = await run(root, ["--verify"]);
    assert.equal(verified.status, 0, verified.stderr);
});

test("a refusal is verified too, not only a score", async (t) => {
    // A stored refusal is also something a reader acts on -- which judgements
    // are missing, which gold is disproved -- so editing it away has to be
    // caught by the same recomputation.
    const { root } = fixture(t);
    const twoFindings = observation();
    twoFindings.findings.missingPoints = [
        "c는 이의신청 기한을 제시하지 않는다",
        "c는 재발화 방지 안내가 없다",
    ];
    twoFindings.allText = twoFindings.findings.missingPoints.join(" ");
    write(root, "observation.json", twoFindings);
    write(
        root,
        "record.json",
        record(observationRefFor(twoFindings), [
            claim(),
            claim({
                requirementId: "reignition_guard",
                sourceIndex: 1,
                evidenceQuote: "c는 재발화 방지 안내가 없다",
                outsideGoldVerdict: "gold_incomplete",
            }),
        ])
    );
    await run(root);
    assert.equal(read(root, "artifact.json").outcome.scored, false);

    const laundered = read(root, "artifact.json");
    laundered.outcome = {
        scored: true,
        contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
        byKind: {
            contradictions: {},
            missingPoints: { truePositives: 1 },
            differences: {},
        },
    };
    write(root, "artifact.json", laundered);

    const result = await run(root, ["--verify"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /stored outcome is not what these inputs produce/);
});

test("a judgement pointing nowhere in the output is refused", async (t) => {
    // The digest says these bytes were present. It does not say the judgements
    // point into them, and both of these scored a true positive before.
    const { root, observationRef } = fixture(t);

    write(root, "record.json", record(observationRef, [claim({ sourceIndex: 999 })]));
    const outOfRange = await run(root);
    assert.equal(outOfRange.status, 1);
    assert.match(outOfRange.stdout, /points at missingPoints\[999\] and this output has 1/);

    write(
        root,
        "record.json",
        record(observationRef, [claim({ evidenceQuote: "이 출력에 없는 문장" })])
    );
    const inventedQuote = await run(root);
    assert.equal(inventedQuote.status, 1);
    assert.match(inventedQuote.stdout, /quotes a sentence missingPoints\[0\] does not contain/);
});

test("a submitted finding no claim mentions is a gap, not a pass", async (t) => {
    // How a wrong finding disappears: judge the one that scores, leave the
    // other out, and a record that is signed and digest-matched reports a
    // clean sheet.
    const { root } = fixture(t);
    const twoFindings = observation();
    twoFindings.findings.missingPoints = [
        "c는 이의신청 기한을 제시하지 않는다",
        "a도 기한을 말하지 않는다",
    ];
    twoFindings.allText = twoFindings.findings.missingPoints.join(" ");
    write(root, "observation.json", twoFindings);
    write(root, "record.json", record(observationRefFor(twoFindings), [claim()]));

    const result = await run(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /missingPoints\[1\] of this output has no claim about it/);

    // Splitting one finding into several claims stays allowed: this check does
    // not decide how to split anything.
    write(
        root,
        "record.json",
        record(observationRefFor(twoFindings), [
            claim(),
            claim({
                sourceIndex: 0,
                requirementId: "evidence_preservation",
                outsideGoldVerdict: "false_finding",
            }),
            claim({
                sourceIndex: 1,
                targetLabel: "a",
                evidenceQuote: "a도 기한을 말하지 않는다",
                outsideGoldVerdict: "false_finding",
            }),
        ])
    );
    const split = await run(root);
    assert.equal(split.status, 0, split.stderr);
    assert.match(split.stdout, /record against the output\n {2}ok/);
});

test("a wrongly typed field is named with its file and path, before anything is read", async (t) => {
    // TypeScript says nothing about JSON somebody wrote. The first of these
    // produced a WRONG SCORE rather than an error; the second printed two
    // sections of `ok` and then threw a TypeError.
    const { root, observationRef } = fixture(t);

    const stringBoolean = testCase();
    stringBoolean.goldCompleteness.missingPoints = "true";
    write(root, "case.json", stringBoolean);
    const boolish = await run(root);
    assert.equal(boolish.status, 1);
    assert.match(boolish.stdout, /case\.json: goldCompleteness\.missingPoints is "true", not a boolean/);
    assert.match(boolish.stdout, /silently drops the kind out of precision/);
    assert.match(boolish.stderr, /Nothing was read further/);

    write(root, "case.json", testCase());
    write(
        root,
        "record.json",
        record(observationRef, [claim({ submittedAs: "missingPoint" })])
    );
    const misspelled = await run(root);
    assert.equal(misspelled.status, 1);
    assert.match(misspelled.stdout, /record\.json: claims\[0\]\.submittedAs is "missingPoint"/);
    // And it is reported rather than thrown: no section of `ok` was printed
    // before the failure.
    assert.doesNotMatch(misspelled.stdout, /case registration/);
    assert.doesNotMatch(misspelled.stderr, /TypeError/);
});

test("--verify never writes, whatever the artifact file holds", async (t) => {
    // The mode used to be inferred from the truthiness of the artifact, so an
    // `artifact.json` holding a falsy value skipped its own shape check, fell
    // through to the scoring path, and was OVERWRITTEN -- a request to verify
    // evidence replacing it instead of refusing it.
    const { root } = fixture(t);
    const path = join(root, "artifact.json");

    for (const held of ["null", "false", "0", '""']) {
        writeFileSync(path, `${held}\n`, "utf8");
        const before = readFileSync(path, "utf8");

        const result = await run(root, ["--verify"]);
        assert.equal(result.status, 1, held);
        assert.match(result.stdout, /artifact\.json: is not an object/, held);
        // Not merely a non-zero exit: the file has to be untouched, byte for
        // byte, because the failure was that it got replaced.
        assert.equal(readFileSync(path, "utf8"), before, held);
    }

    // A verify against a well-formed artifact still passes, and still writes
    // nothing.
    await run(root);
    const scored = readFileSync(path, "utf8");
    const verified = await run(root, ["--verify"]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(readFileSync(path, "utf8"), scored);
});

test("a blank evidence quote is not evidence", async (t) => {
    // Every string contains the empty string, so `includes("")` is true of any
    // output: a claim with no quote passed the check that its evidence appears
    // in the text it points at, and scored a true positive.
    const { root, observationRef } = fixture(t);

    for (const quote of ["", "   ", "\n\t"]) {
        write(root, "record.json", record(observationRef, [claim({ evidenceQuote: quote })]));
        const result = await run(root);
        assert.equal(result.status, 1, JSON.stringify(quote));
        assert.match(result.stdout, /has no evidence quote/, JSON.stringify(quote));
    }

    // Prose claims too: the same `includes` was doing the same nothing there.
    const twoFindings = observation();
    twoFindings.findings.missingPoints = ["c는 이의신청 기한을 제시하지 않는다"];
    write(root, "observation.json", twoFindings);
    write(
        root,
        "record.json",
        record(observationRefFor(twoFindings), [
            claim(),
            claim({
                requirementId: "evidence_preservation",
                submittedAs: "prose",
                sourceIndex: null,
                speechAct: "mention",
                evidenceQuote: "  ",
            }),
        ])
    );
    const prose = await run(root);
    assert.equal(prose.status, 1);
    assert.match(prose.stdout, /has no evidence quote/);
});

// ---------------------------------------------------------------------------
// The judged score, against the run and the frozen set
//
// Three files in a directory can agree perfectly and be about an output the
// run never produced, or a case the frozen set does not contain -- a
// consistent statement about nothing.
// ---------------------------------------------------------------------------

const writeJournal = (root, entries) =>
    writeFileSync(
        join(root, "journal.jsonl"),
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        "utf8"
    );

const datasetWith = (overrides = {}) => ({
    version: "decision-v2",
    cases: [sourceCase(overrides)],
});

test("a judged score is checked against the run's journal and the frozen set", async (t) => {
    const { root } = fixture(t);
    await run(root);
    writeJournal(root, [
        { caseId: "ko-safety-sensitive-003", observation: observation() },
    ]);
    write(root, "dataset.json", datasetWith());

    const bound = [
        "--verify",
        `--journal=${join(root, "journal.jsonl")}`,
        `--dataset=${join(root, "dataset.json")}`,
    ];
    const ok = await run(root, bound);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /It may be counted in a score/);

    // An output the run never recorded.
    const elsewhere = observation();
    elsewhere.findings.missingPoints = ["이 실행이 낸 적 없는 출력"];
    writeJournal(root, [{ caseId: "ko-safety-sensitive-003", observation: elsewhere }]);
    const wrongOutput = await run(root, bound);
    assert.equal(wrongOutput.status, 1);
    assert.match(wrongOutput.stdout, /is not the one that was judged and scored here/);

    // A case the run never had an entry for.
    writeJournal(root, [{ caseId: "ko-safety-sensitive-001", observation: observation() }]);
    const noEntry = await run(root, bound);
    assert.equal(noEntry.status, 1);
    assert.match(noEntry.stdout, /journal has no entry for ko-safety-sensitive-003/);

    // A case the frozen set does not contain.
    writeJournal(root, [{ caseId: "ko-safety-sensitive-003", observation: observation() }]);
    write(root, "dataset.json", { version: "decision-v2", cases: [{ id: "somewhere-else" }] });
    const notInSet = await run(root, bound);
    assert.equal(notInSet.status, 1);
    assert.match(notInSet.stdout, /frozen dataset has no case ko-safety-sensitive-003/);

    // And a case whose answers are not the answers the run showed: a gold item
    // could then name an answer nobody was ever given.
    write(
        root,
        "dataset.json",
        datasetWith({ responses: [{ label: "a", content: "a의 답변" }, { label: "b", content: "b의 답변" }] })
    );
    const differentAnswers = await run(root, bound);
    assert.equal(differentAnswers.status, 1);
    assert.match(differentAnswers.stdout, /a gold item could name an answer the run never showed/);
});

test("a correctly recorded refusal verifies and is still not countable", async (t) => {
    // Integrity and usefulness are different questions. This artifact is sound
    // evidence -- of a refusal -- and reading its clean verification as
    // "usable" would let a case nobody finished judging into an aggregate as
    // though it had been judged and found wanting.
    const { root } = fixture(t);
    const twoFindings = observation();
    twoFindings.findings.missingPoints = [
        "c는 이의신청 기한을 제시하지 않는다",
        "c는 재발화 방지 안내가 없다",
    ];
    twoFindings.allText = twoFindings.findings.missingPoints.join(" ");
    write(root, "observation.json", twoFindings);
    write(
        root,
        "record.json",
        record(observationRefFor(twoFindings), [
            claim(),
            claim({
                requirementId: "reignition_guard",
                sourceIndex: 1,
                evidenceQuote: "c는 재발화 방지 안내가 없다",
            }),
        ])
    );
    await run(root);
    assert.equal(read(root, "artifact.json").outcome.scored, false);

    writeJournal(root, [{ caseId: "ko-safety-sensitive-003", observation: twoFindings }]);
    write(root, "dataset.json", datasetWith());

    const verified = await run(root, [
        "--verify",
        `--journal=${join(root, "journal.jsonl")}`,
        `--dataset=${join(root, "dataset.json")}`,
    ]);
    // The evidence is sound...
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /The stored score is about these files/);
    // ...and it may not be counted.
    assert.match(verified.stdout, /may NOT be counted in a score or cited as promotion evidence/);
    assert.match(verified.stdout, /correctly recorded refusal and not a result/);
    assert.doesNotMatch(verified.stdout, /It may be counted in a score/);
});

test("a rewritten question breaks the binding, even with the same id and labels", async (t) => {
    // The gap a digest of the JUDGED case could not close: `caseDigest` covers
    // the gold and the catalogue, not the text a person read. Same id, same
    // labels, a different question -- and an old judgement with its old score
    // verified against it.
    const { root } = fixture(t);
    await run(root);
    writeJournal(root, [{ caseId: "ko-safety-sensitive-003", observation: observation() }]);
    write(root, "dataset.json", datasetWith());
    const bound = [
        "--verify",
        `--journal=${join(root, "journal.jsonl")}`,
        `--dataset=${join(root, "dataset.json")}`,
    ];
    assert.equal((await run(root, bound)).status, 0);

    write(root, "dataset.json", datasetWith({ question: "완전히 다른 질문입니다" }));
    const rewrittenQuestion = await run(root, bound);
    assert.equal(rewrittenQuestion.status, 1);
    assert.match(
        rewrittenQuestion.stdout,
        /question or answers are not the ones this judgement was made from/
    );

    // An answer rewritten under the same label is the same failure.
    write(
        root,
        "dataset.json",
        datasetWith({
            responses: [
                { label: "a", content: "a의 답변" },
                { label: "b", content: "b의 답변" },
                { label: "c", content: "c의 답변이 완전히 바뀌었습니다" },
            ],
        })
    );
    const rewrittenAnswer = await run(root, bound);
    assert.equal(rewrittenAnswer.status, 1);
    assert.match(rewrittenAnswer.stdout, /judgement is about text the dataset no longer holds/);
});

test("a broken journal or dataset is a problem, not a skipped check", async (t) => {
    // The newest inputs were the unchecked ones. `cases: false` skipped the
    // comparison and left the case countable; `cases: {}` threw `.find is not
    // a function`; a `null` journal line threw on `.caseId`.
    const { root } = fixture(t);
    await run(root);
    writeJournal(root, [{ caseId: "ko-safety-sensitive-003", observation: observation() }]);

    for (const cases of [false, 0, "", {}]) {
        write(root, "dataset.json", { version: "decision-v2", cases });
        const result = await run(root, [
            "--verify",
            `--journal=${join(root, "journal.jsonl")}`,
            `--dataset=${join(root, "dataset.json")}`,
        ]);
        assert.equal(result.status, 1, JSON.stringify(cases));
        assert.match(result.stdout, /dataset: cases is .*, not an array/, JSON.stringify(cases));
        assert.match(result.stdout, /left the case countable/);
    }

    write(root, "dataset.json", datasetWith());
    writeFileSync(join(root, "journal.jsonl"), "null\n", "utf8");
    const nullLine = await run(root, [
        "--verify",
        `--journal=${join(root, "journal.jsonl")}`,
        `--dataset=${join(root, "dataset.json")}`,
    ]);
    assert.equal(nullLine.status, 1);
    assert.match(nullLine.stdout, /journal: \[0\] is null, not an object/);
    assert.doesNotMatch(nullLine.stderr, /TypeError/);
});

test("files that agree only with each other are not countable", async (t) => {
    // Checking a judgement before a run exists is allowed and useful. Calling
    // the result countable is not: they have been shown to agree with each
    // other, and an aggregate is about a run.
    const { root } = fixture(t);
    await run(root);

    const unbound = await run(root, ["--verify"]);
    assert.equal(unbound.status, 0, unbound.stderr);
    assert.match(unbound.stdout, /The stored score is about these files/);
    assert.match(unbound.stdout, /may NOT be counted/);
    assert.match(unbound.stdout, /checked against each other and against no run/);

    // Supplying only one of the two is still not the run.
    writeJournal(root, [{ caseId: "ko-safety-sensitive-003", observation: observation() }]);
    const halfBound = await run(root, ["--verify", `--journal=${join(root, "journal.jsonl")}`]);
    assert.equal(halfBound.status, 0, halfBound.stderr);
    assert.match(halfBound.stdout, /may NOT be counted/);

    write(root, "dataset.json", datasetWith());
    const bound = await run(root, [
        "--verify",
        `--journal=${join(root, "journal.jsonl")}`,
        `--dataset=${join(root, "dataset.json")}`,
    ]);
    assert.equal(bound.status, 0, bound.stderr);
    assert.match(bound.stdout, /It may be counted in a score/);
});

test("re-scoring is not re-judging: an updated case with an old record is refused", async (t) => {
    // The way the source binding was got round. Change the dataset, update the
    // JUDGED case's digest to match, run the scorer again -- and the mismatch
    // disappeared while the judgement was never re-made. The record is what a
    // person signed, so the digest of what they read lives in it too, and
    // re-scoring never writes a new one.
    const { root } = fixture(t);
    await run(root);
    writeJournal(root, [{ caseId: "ko-safety-sensitive-003", observation: observation() }]);
    write(root, "dataset.json", datasetWith());
    const bound = [
        "--verify",
        `--journal=${join(root, "journal.jsonl")}`,
        `--dataset=${join(root, "dataset.json")}`,
    ];
    assert.equal((await run(root, bound)).status, 0);

    // 1. the source changes, and the stored score is refused.
    const rewritten = sourceCase({ question: "완전히 다른 질문입니다" });
    write(root, "dataset.json", { version: "decision-v2", cases: [rewritten] });
    const stale = await run(root, bound);
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /question or answers are not the ones this judgement was made from/);

    // 2. the judged case's digest is brought up to date...
    write(root, "case.json", testCase({ sourceCaseDigest: judgedSourceCaseDigest(rewritten) }));

    // 3. ...and re-scoring is REFUSED, because the signed record still says
    //    which text it was made from.
    const rescored = await run(root);
    assert.equal(rescored.status, 1);
    assert.match(rescored.stdout, /re-scoring does not re-judge/);
    assert.match(rescored.stderr, /Nothing was scored/);

    // Only a record made against the text that is there now goes through.
    write(
        root,
        "record.json",
        record(observationRefFor(observation()), [claim()], {
            sourceCaseDigest: judgedSourceCaseDigest(rewritten),
        })
    );
    const rejudged = await run(root);
    assert.equal(rejudged.status, 0, rejudged.stderr);
    assert.equal((await run(root, bound)).status, 0);
});

test("a malformed answer inside the dataset is reported with its position", async (t) => {
    // `responses: [null]` produced no problem at all and then threw on
    // `.label`, so a malformed dataset stopped the process instead of being
    // reported by it.
    const { root } = fixture(t);
    await run(root);
    writeJournal(root, [{ caseId: "ko-safety-sensitive-003", observation: observation() }]);
    const bound = () => [
        "--verify",
        `--journal=${join(root, "journal.jsonl")}`,
        `--dataset=${join(root, "dataset.json")}`,
    ];

    write(root, "dataset.json", datasetWith({ responses: [null] }));
    const nullResponse = await run(root, bound());
    assert.equal(nullResponse.status, 1);
    assert.match(nullResponse.stdout, /dataset: cases\[0\]\.responses\[0\] is null, not an object/);
    assert.doesNotMatch(nullResponse.stderr, /TypeError/);

    write(root, "dataset.json", datasetWith({ responses: [{ label: "a", content: 7 }] }));
    const badContent = await run(root, bound());
    assert.equal(badContent.status, 1);
    assert.match(badContent.stdout, /cases\[0\]\.responses\[0\]\.content is 7, not a string/);

    write(root, "dataset.json", datasetWith({ question: 42 }));
    const badQuestion = await run(root, bound());
    assert.equal(badQuestion.status, 1);
    assert.match(badQuestion.stdout, /cases\[0\]\.question is 42, not a string/);

    // A different case being malformed does not refuse this run: the frozen
    // set has its own validator, and a whole run is not refused over a field
    // in a case this evidence is not about.
    write(root, "dataset.json", {
        version: "decision-v2",
        cases: [sourceCase(), { id: "somewhere-else", responses: [null] }],
    });
    const elsewhere = await run(root, bound());
    assert.equal(elsewhere.status, 0, elsewhere.stderr);
});
