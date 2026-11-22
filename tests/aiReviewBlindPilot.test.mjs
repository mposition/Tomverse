import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadBundle, runDemo } from "../scripts/experiments/ai-review-blind-pilot.mjs";
import {
    PilotInputError,
    adjudicationTemplate,
    appearsIn,
    buildReport,
    freezeInputs,
    lockRecord,
    prepare,
    renderReport,
    scorePlantedKind,
} from "../scripts/experiments/ai-review-blind-pilot/core.mjs";
import { buildMockJudging } from "../scripts/experiments/ai-review-blind-pilot/mock.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "experiments", "ai-review-blind-pilot", "fixtures");
const T0 = "2026-11-22T00:00:00.000Z";
const loadFixture = () => structuredClone(loadBundle(path.join(fixtures, "plan.json")));
const loadMock = () => JSON.parse(readFileSync(path.join(fixtures, "mock-judging.json"), "utf8"));
const itemOf = (bundle, slot, caseId) => bundle.outputs[slot].items.find((item) => item.caseId === caseId);

function pipeline({ bundle = loadFixture(), mock = loadMock(), editAfterJudging, editRecords, editAdjudication } = {}) {
    const freeze = freezeInputs(bundle, T0);
    const prepared = prepare(bundle, freeze);
    const { records, adjudication } = buildMockJudging(prepared, mock);
    editRecords?.(records, prepared);
    editAdjudication?.(adjudication, prepared);
    editAfterJudging?.(bundle);
    const report = buildReport(bundle, freeze, { records, adjudication });
    return { bundle, freeze, prepared, records, adjudication, report };
}
const outputOf = (report, slot, caseId) => report.outputs.find((output) => output.slot === slot && output.caseId === caseId);
const outputIdOf = (prepared, slot, caseId) => prepared.key.outputs.find((output) => output.slot === slot && output.caseId === caseId).outputId;

test("acceptance: two complete gold items, X repeats one and invents one, Y finds both", () => {
    const x = scorePlantedKind({
        goldIds: ["I1", "I2"],
        complete: true,
        rows: [
            { verdict: "matched", goldId: "I1" },
            { verdict: "matched", goldId: "I1" },
            { verdict: "false_finding" },
        ],
    });
    assert.deepEqual([x.tp, x.fp, x.fn, x.duplicates], [1, 1, 1, 1]);
    assert.equal(x.tp / (x.tp + x.fp), 1 / 2);
    assert.equal(x.tp / (x.tp + x.fn), 1 / 2);
    const y = scorePlantedKind({ goldIds: ["I1", "I2"], complete: true, rows: [{ verdict: "matched", goldId: "I1" }, { verdict: "matched", goldId: "I2" }] });
    assert.deepEqual([y.tp, y.fp, y.fn, y.duplicates], [2, 0, 0, 0]);
});

test("incomplete gold keeps wrong findings out of precision; a gap on complete gold or an unruled finding refuses", () => {
    const incomplete = scorePlantedKind({ goldIds: ["I1"], complete: false, rows: [{ verdict: "false_finding" }, { verdict: "gold_gap" }] });
    assert.equal(incomplete.scored, true);
    assert.equal(incomplete.fp, 0);
    assert.equal(incomplete.precisionCounted, false);
    assert.equal(incomplete.goldGaps, 1);
    assert.equal(scorePlantedKind({ goldIds: [], complete: true, rows: [{ verdict: "gold_gap" }] }).reason, "gold_defect");
    assert.equal(scorePlantedKind({ goldIds: [], complete: true, rows: [{ verdict: "undetermined" }] }).reason, "undetermined");
});

test("the synthetic demo reproduces the planted outcomes and says quality is unmeasured", () => {
    const { report } = pipeline();
    const x = report.products.X;
    const y = report.products.Y;
    assert.deepEqual([x.contradiction.tp, x.contradiction.fp, x.contradiction.fn, x.contradiction.duplicates, x.contradiction.insufficient], [3, 4, 1, 1, 1]);
    assert.deepEqual([x.contradiction.precision.numerator, x.contradiction.precision.denominator], [3, 7]);
    assert.deepEqual([x.contradiction.recall.numerator, x.contradiction.recall.denominator], [3, 4]);
    assert.deepEqual([y.contradiction.precision.numerator, y.contradiction.precision.denominator], [2, 2]);
    assert.deepEqual([y.contradiction.recall.numerator, y.contradiction.recall.denominator], [2, 3]);
    assert.deepEqual([x.negativeCaseFalseContradiction.numerator, x.negativeCaseFalseContradiction.denominator], [3, 8]);
    assert.deepEqual([y.negativeCaseFalseContradiction.numerator, y.negativeCaseFalseContradiction.denominator], [0, 7]);
    // Missing goes through judged-v3's own scorer.
    assert.deepEqual([x.missing.recall.numerator, x.missing.recall.denominator], [1, 2]);
    assert.deepEqual([y.missing.recall.numerator, y.missing.recall.denominator], [2, 2]);
    assert.deepEqual(report.pairwise.golds, { both: 2, onlyFirst: 1, onlySecond: 0, neither: 0 });
    assert.equal(report.pairwise.eligiblePairs, 10);
    assert.equal(x.measurement.status, "unmeasured");
    assert.equal(y.measurement.status, "unmeasured");
    const markdown = renderReport(report);
    assert.match(markdown, /품질 미측정/);
    assert.match(markdown, /M5 승인·승격 판정/);
    assert.match(markdown, /단독 관찰/);
});

test("two answers with the same value and matching quotes: a 'conflict' is still a false positive", () => {
    const { report, bundle } = pipeline();
    const answers = bundle.cases.cases.find((c) => c.caseId === "qp-refund-2-en").answers;
    for (const citation of itemOf(bundle, "X", "qp-refund-2-en").findings[0].citations) {
        const answerId = itemOf(bundle, "X", "qp-refund-2-en").displayMap[citation.displayLabel];
        assert.equal(appearsIn(citation.quote, answers.find((a) => a.id === answerId).content), true);
    }
    const output = outputOf(report, "X", "qp-refund-2-en");
    assert.equal(output.contradiction.fp, 1);
    assert.equal(output.contradiction.tp, 0);
    assert.equal(report.products.X.evidence.support.doesNotSupport >= 1, true);
});

test("a correct contradiction with no quote is a semantic TP and 'no evidence', not an evidence pass", () => {
    const { report } = pipeline();
    assert.equal(outputOf(report, "Y", "qp-notice-1-ko").contradiction.tp, 1);
    assert.equal(report.products.Y.evidence.support.noEvidence, 1);
    assert.equal(report.products.Y.evidence.findingsWithoutCitation, 1);
    assert.deepEqual([report.products.Y.evidence.groundedGoldHits.numerator, report.products.Y.evidence.groundedGoldHits.denominator], [1, 3]);
});

test("citations resolve through the run's display map, never through input order", () => {
    const base = pipeline();
    const reversed = loadFixture();
    // Same display labels, same quotes, the opposite label->answer map.
    itemOf(reversed, "X", "qp-notice-1-en").displayMap = { A: "2", B: "1" };
    const flipped = pipeline({ bundle: reversed });
    const before = base.report.products.X.evidence.citationMatch.numerator;
    assert.equal(flipped.report.products.X.evidence.citationMatch.numerator, before - 2);
    const segment = (run) => run.prepared.caseEntries.flatMap((e) => e.outputs).find((o) => o.slot === "X" && o.caseId === "qp-notice-1-en").presented.segments[0];
    assert.deepEqual(segment(flipped).citations.map((c) => c.match), ["not_matched", "not_matched"]);

    // A quote present in BOTH answers matches whichever way the map points.
    const shared = loadFixture();
    itemOf(shared, "X", "qp-notice-1-en").findings[0].citations = [{ displayLabel: "A", quote: "Standard plan" }];
    itemOf(shared, "X", "qp-notice-1-en").displayMap = { A: "2", B: "1" };
    assert.equal(segment(pipeline({ bundle: shared })).citations[0].match, "matched");

    // No map: not checkable, rather than assuming A is the first answer.
    const unmapped = loadFixture();
    itemOf(unmapped, "X", "qp-notice-1-en").displayMap = null;
    const run = pipeline({ bundle: unmapped });
    assert.deepEqual(segment(run).citations.map((c) => c.match), ["not_checkable", "not_checkable"]);
    assert.equal(run.report.products.X.evidence.citationsNotCheckable, 2);
});

test("journal-style observations keep the semantic TP and leave per-quote evidence undeterminable", () => {
    const bundle = loadFixture();
    const item = itemOf(bundle, "X", "qp-notice-1-en");
    Object.assign(item, { format: "observation_only", totalQuotes: 2, matchedQuotes: 2 });
    item.findings = [{ field: "contradictions", text: `${item.findings[0].text} at least 14 days before at least 30 days before`, citations: [] }];
    const mock = loadMock();
    mock.outputs["X/qp-notice-1-en"][0].support = null;
    const { report } = pipeline({ bundle, mock });
    assert.equal(outputOf(report, "X", "qp-notice-1-en").contradiction.tp, 1);
    assert.equal(report.products.X.evidence.aggregateOnlyQuotes, 2);
});

test("brand names are redacted from prose; a brand inside a quote makes the output unblindable; ids in inputs refuse", () => {
    const { prepared } = pipeline();
    const judgeFacing = prepared.packets.map((p) => p.markdown + JSON.stringify(p.record)).join("\n");
    for (const term of ["Mock Reviewer X", "Mock Review Y", "모의 제품", "qp-g-", "qp-notice", "qp-refund", "mock-x", "qp-req-", "Tomverse"]) {
        assert.equal(appearsIn(term, judgeFacing), false, term);
    }
    assert.match(judgeFacing, /\[가림\]/);

    const quoted = loadFixture();
    itemOf(quoted, "Y", "qp-refund-3-en").findings[0].citations = [{ displayLabel: "A", quote: "Mock Review Y" }];
    itemOf(quoted, "Y", "qp-refund-3-en").rawText += " Mock Review Y";
    itemOf(quoted, "Y", "qp-refund-3-en").findings[0].text = itemOf(quoted, "Y", "qp-refund-3-en").rawText;
    const blocked = prepare(quoted, freezeInputs(quoted, T0));
    assert.equal(blocked.key.outputs.find((o) => o.slot === "Y" && o.caseId === "qp-refund-3-en").status, "blinding_impossible");

    const leaky = loadFixture();
    leaky.cases.cases[0].question += " (qp-g-notice-1-ko-c1)";
    // The gold must be re-frozen for the case edit; the leak is still refused.
    assert.throws(() => prepare(leaky, freezeInputs(leaky, T0)), (error) => error instanceof PilotInputError && /식별 정보/.test(error.message));
});

test("order and positions are reproducible from the seed and balanced across judges", () => {
    const bundle = loadFixture();
    bundle.plan.judges = 2;
    const freeze = freezeInputs(bundle, T0);
    const first = prepare(bundle, freeze);
    const second = prepare(structuredClone(bundle), freeze);
    assert.equal(first.packets[0].markdown, second.packets[0].markdown);
    assert.notEqual(first.packets[0].packetDigest, first.packets[1].packetDigest);
    const firstPos = (packet, id) => packet.positions.find((p) => p.outputId === id).position;
    const pairedId = outputIdOf(first, "X", "qp-notice-1-ko");
    assert.notEqual(firstPos(first.packets[0], pairedId), firstPos(first.packets[1], pairedId));
    const counts = first.key.packets[0].firstPositionBySlot;
    assert.equal(counts.X > 0 && counts.Y > 0, true);
    const reseeded = structuredClone(bundle);
    reseeded.plan.seed = 7;
    assert.notEqual(prepare(reseeded, freezeInputs(reseeded, T0)).packets[0].markdown, first.packets[0].markdown);
});

test("one product missing: solo scope is reported and no pair is invented", () => {
    const bundle = loadFixture();
    bundle.plan.products = bundle.plan.products.filter((p) => p.slot === "X");
    delete bundle.outputs.Y;
    const mock = loadMock();
    for (const key of Object.keys(mock.outputs)) if (key.startsWith("Y/")) delete mock.outputs[key];
    const { report } = pipeline({ bundle, mock });
    assert.equal(report.products.X.counts.scored, 12);
    assert.equal(report.pairwise.eligiblePairs, 0);
    assert.equal(report.products.Y, undefined);
});

test("a failed response is not judged; an explicit empty finding list is judged and misses the gold", () => {
    const { report } = pipeline();
    assert.equal(outputOf(report, "Y", "qp-notice-2-en").state, "failed");
    assert.equal(outputOf(report, "Y", "qp-refund-1-en").state, "not_collected");
    assert.equal(report.products.Y.counts.failed, 1);
    assert.equal(report.products.Y.counts.notCollected, 1);
    assert.equal(outputOf(report, "X", "qp-notice-3-en").state, "scored");
    assert.deepEqual(report.pairwise.notPaired, { "Y: failed": 1, "Y: not_collected": 1 });
});

test("an unlocked or incomplete record is never scored", () => {
    const bundle = loadFixture();
    const freeze = freezeInputs(bundle, T0);
    const prepared = prepare(bundle, freeze);
    const blank = structuredClone(prepared.packets[0].record);
    assert.throws(() => lockRecord(blank, { judge: "someone", at: T0 }), PilotInputError);
    const report = buildReport(bundle, freeze, { records: [blank] });
    assert.equal(report.provenance.judgements.accepted, 0);
    assert.equal(report.products.X.counts.scored, 0);
    assert.equal(report.products.X.measurement.status, "unmeasured");
    assert.match(renderReport(report), /품질 미측정/);
    const unjudged = buildReport(bundle, freeze);
    assert.equal(unjudged.products.X.counts.unjudged, 12);
    assert.throws(() => adjudicationTemplate(bundle, freeze, [blank]), PilotInputError);
});

test("changed sources invalidate earlier judgements instead of carrying them over", () => {
    // Gold edited after the freeze: nothing proceeds.
    const bundle = loadFixture();
    const freeze = freezeInputs(bundle, T0);
    bundle.gold.cases["qp-notice-1-ko"].contradictions[0].rationale += " (edited)";
    assert.throws(() => prepare(bundle, freeze), /정답표가 고정 이후 바뀌었습니다/);

    // An output edited after judging: that output's judgement is refused, the rest stand.
    const edited = pipeline({ editAfterJudging: (b) => (itemOf(b, "X", "qp-notice-1-en").findings[0].text += " (edited)") });
    assert.equal(outputOf(edited.report, "X", "qp-notice-1-en").state, "judgement_refused");
    assert.match(outputOf(edited.report, "X", "qp-notice-1-en").reason, /재사용할 수 없습니다/);
    assert.equal(edited.report.products.X.counts.scored, 11);

    // A changed seed (assignment) makes every record belong to another packet.
    const reseeded = pipeline({ editAfterJudging: (b) => (b.plan.seed += 1) });
    assert.equal(reseeded.report.provenance.judgements.accepted, 0);
});

test("a confirmed gap in a complete gold holds that case for both products", () => {
    const mock = loadMock();
    Object.assign(mock.outputs["X/qp-refund-3-en"][0], { verdict: "gold_gap" });
    const { report } = pipeline({ mock });
    assert.equal(outputOf(report, "X", "qp-refund-3-en").state, "gold_defect");
    assert.equal(outputOf(report, "Y", "qp-refund-3-en").state, "gold_defect_hold");
    assert.deepEqual(report.goldDefects, ["qp-refund-3-en"]);
    const undetermined = loadMock();
    Object.assign(undetermined.outputs["X/qp-refund-3-en"][0], { verdict: "undetermined" });
    assert.equal(outputOf(pipeline({ mock: undetermined }).report, "X", "qp-refund-3-en").state, "refused");
});

test("two judges: agreement before consensus is counted and the consensus is what scores", () => {
    const bundle = loadFixture();
    bundle.plan.judges = 2;
    const agreed = pipeline({ bundle: structuredClone(bundle) });
    assert.equal(agreed.report.provenance.judgements.judging, "double");
    assert.equal(agreed.report.agreement.doubleJudgedOutputs, 22);
    assert.equal(agreed.report.agreement.agreedBeforeConsensus, 22);
    const split = pipeline({
        bundle: structuredClone(bundle),
        editAdjudication: (adjudication, prepared) => {
            adjudication.outputs[outputIdOf(prepared, "X", "qp-notice-2-ko")].judges[1] = [{ row: 0, kind: "contradiction", verdict: "gold_gap", goldId: null, sufficiency: "sufficient" }];
        },
    });
    assert.equal(split.report.agreement.agreedBeforeConsensus, 21);
    assert.deepEqual(split.report.products.X.contradiction.precision, agreed.report.products.X.contradiction.precision);
});

test("full product experience and hidden documents are reported apart from the fixed-answer table", () => {
    const fullExperience = loadFixture();
    fullExperience.outputs.Y.conditions.fixedAnswersAccepted = false;
    const run = pipeline({ bundle: fullExperience });
    assert.equal(run.report.products.Y.counts.fullProductExperience, 10);
    assert.equal(run.report.products.Y.counts.scored, 0);
    assert.equal(run.report.pairwise.eligiblePairs, 0);

    const hidden = loadFixture();
    hidden.plan.documentExposure = "hidden";
    hidden.outputs.X.conditions.documentExposure = "hidden";
    const hiddenRun = pipeline({ bundle: hidden });
    assert.equal(hiddenRun.report.products.X.jointDocumentError.applicable, false);
    assert.equal(hiddenRun.report.products.Y.category, "condition_mismatch");
    assert.match(renderReport(hiddenRun.report), /평가 대상 아님/);
});

test("a record edited after adjudication unbinds the adjudication", () => {
    const { report } = pipeline({ editRecords: (records) => (records[0].outputs[0].rows[0].statement += " (edited)") });
    assert.equal(report.provenance.adjudication.state, "invalid");
    assert.equal(report.products.X.counts.scored, 0);
    assert.equal(report.products.X.measurement.status, "unmeasured");
});

test("CLI commands: freeze -> prepare -> report before judging; lock refuses an unfinished record", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pilot-cli-"));
    const cli = path.join(fixtures, "..", "..", "ai-review-blind-pilot.mjs");
    const run = (...args) => spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", cli, ...args], { encoding: "utf8" });
    try {
        const plan = path.join(fixtures, "plan.json");
        assert.equal(run("freeze", "--plan", plan, "--out", dir, "--at", T0).status, 0);
        assert.equal(run("prepare", "--plan", plan, "--out", dir).status, 0);
        assert.equal(run("report", "--plan", plan, "--out", dir).status, 0);
        assert.match(readFileSync(path.join(dir, "report.md"), "utf8"), /품질 미측정/);
        const locked = run("lock", "--record", path.join(dir, "judge-1", "record.json"), "--judge", "someone");
        assert.equal(locked.status, 1);
        assert.match(locked.stderr, /reviewed가 true가 아닙니다/);
        assert.equal(run("adjudicate", "--plan", plan, "--out", dir, "--records", path.join(dir, "judge-1", "record.json")).status, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the CLI demo regenerates byte-identical reports", () => {
    const dirs = [mkdtempSync(path.join(os.tmpdir(), "pilot-a-")), mkdtempSync(path.join(os.tmpdir(), "pilot-b-"))];
    try {
        const outputs = dirs.map((dir) => {
            runDemo(dir);
            return ["report.md", "report.json", "judge-1/packet.md", "operator/key.json", "report-before-judging.md"].map((file) => readFileSync(path.join(dir, file), "utf8"));
        });
        assert.deepEqual(outputs[0], outputs[1]);
        assert.match(outputs[0][4], /품질 미측정/);
    } finally {
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
});
