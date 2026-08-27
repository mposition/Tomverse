/**
 * `docs/ops/tomverse-chat-router-evaluation-set.md` §5.
 *
 * The pilot reported a -43.81pp win-rate delta with the judge grading its own
 * answers on every pair, and `--mode=judge-bias` could not have separated the
 * judge's preference from the models' real difference: it put the judge's own
 * model in the Auto arm and called the result a self-preference rate, which
 * only reads as one if the two models are equally good.
 *
 * What two passes over the SAME answers can settle is how far apart two judges
 * are. These test that, and the refusals that stop a number being produced
 * from passes that cannot be compared.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
    ANSWER_BUNDLE_VERSION,
    answerBundleProblems,
    bundleAnswerIdentities,
    bundleDigest,
    canonicalIdentity,
    parseAnswerBundle,
    sha256,
} from "../lib/routerAnswerBundle.ts";
import {
    calibrateJudges,
    calibrationProblems,
} from "../lib/routerJudgeCalibration.ts";

const luna = { modelId: "gpt-5-6-luna", provider: "openai", apiModel: "gpt-5.6-luna" };
const deepseek = { modelId: "deepseek-v4-flash", provider: "deepseek", apiModel: "deepseek-v4-flash" };
const fable = { modelId: "claude-fable-5", provider: "anthropic", apiModel: "claude-fable-5" };

const answer = (identity, arm, text) => ({ ...identity, arm, text, digest: sha256(text) });

const entry = (index, { firstArm = "auto" } = {}) => {
    const autoSide = answer(deepseek, "auto", `auto answer ${index}`);
    const baselineSide = answer(luna, "baseline", `baseline answer ${index}`);
    return {
        kind: "pair",
        pairId: `p${index}`,
        stratum: "general_question_answering",
        cell: "ko",
        prompt: `question ${index}`,
        first: firstArm === "auto" ? autoSide : baselineSide,
        second: firstArm === "auto" ? baselineSide : autoSide,
    };
};

const bundle = (count = 4) => ({
    header: {
        kind: "header",
        bundleVersion: ANSWER_BUNDLE_VERSION,
        mode: "pilot",
        evaluationSetVersion: "router-eval-development-v0",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        seed: 20260826,
        judgeTemplateVersion: "judge-rubric-v1",
        createdAt: "2026-08-27T02:41:16.553Z",
    },
    entries: Array.from({ length: count }, (unused, index) => entry(index + 1)),
});

const pass = (identity, verdicts, digest) => ({
    identity,
    bundleDigest: digest,
    verdicts: verdicts.map((verdict, index) => ({ pairId: `p${index + 1}`, verdict })),
});

// --- the bundle ------------------------------------------------------------

test("a well-formed bundle has nothing to report", () => {
    assert.deepEqual(answerBundleProblems(bundle()), []);
});

// The digest is the whole reason to record one: without the check it proves
// nothing about what a later pass actually graded.
test("an answer whose digest does not match its text is refused", () => {
    const tampered = bundle();
    tampered.entries[0].first.text = "a different answer";
    assert.match(
        answerBundleProblems(tampered).join(" "),
        /first answer digest does not match its text/
    );
});

test("a bundle missing what a judge needs is refused", () => {
    const noPrompt = bundle();
    delete noPrompt.entries[1].prompt;
    assert.match(answerBundleProblems(noPrompt).join(" "), /pair p2 has no prompt/);

    const noSeed = bundle();
    noSeed.header.seed = 0;
    assert.match(answerBundleProblems(noSeed).join(" "), /no seed, so the display order was not fixed/);

    const repeated = bundle();
    repeated.entries[1].pairId = "p1";
    assert.match(answerBundleProblems(repeated).join(" "), /pair p1 appears more than once/);
});

test("two answers from the same arm is not a comparison", () => {
    const oneSided = bundle();
    oneSided.entries[0].second = { ...oneSided.entries[0].second, arm: "auto" };
    assert.match(answerBundleProblems(oneSided).join(" "), /two auto answers and no comparison/);
});

test("a bundle round-trips through its own line format", () => {
    const original = bundle(3);
    const text = [original.header, ...original.entries].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const parsed = parseAnswerBundle(text);
    assert.deepEqual(answerBundleProblems(parsed), []);
    assert.equal(parsed.entries.length, 3);
    assert.equal(bundleDigest(parsed), bundleDigest(original));
});

// This catalogue has an id whose API model is a different model: claude-opus-4-8
// calls claude-opus-5. An independence check on internal ids would pass a judge
// that wrote the answers.
test("identity is the provider and API model, not the catalogue id", () => {
    const renamedId = { modelId: "claude-opus-4-8", provider: "anthropic", apiModel: "claude-opus-5" };
    const otherId = { modelId: "claude-opus-5", provider: "anthropic", apiModel: "claude-opus-5" };
    assert.notEqual(renamedId.modelId, otherId.modelId);
    assert.equal(canonicalIdentity(renamedId), canonicalIdentity(otherId));
});

test("the bundle names every model that wrote an answer in it", () => {
    assert.deepEqual(bundleAnswerIdentities(bundle()), ["deepseek/deepseek-v4-flash", "openai/gpt-5.6-luna"]);
});

// --- the comparison --------------------------------------------------------

const digest = bundleDigest(bundle());

test("two judges that never disagree shift by zero", () => {
    const verdicts = ["baseline", "auto", "baseline", "equivalent"];
    const result = calibrateJudges(
        pass(luna, verdicts, digest),
        pass(fable, verdicts, digest),
        { seed: 1, resamples: 200 }
    );
    assert.equal(result.pairs, 4);
    assert.equal(result.exactAgreementRate, 1);
    assert.equal(result.judgeShiftPp, 0);
    assert.equal(result.ci95LowerPp, 0);
    assert.equal(result.ci95UpperPp, 0);
});

// The shape the pilot raises: the target judge picks the baseline where the
// reference judge picks Auto.
test("a target judge that favours the baseline more has a positive shift", () => {
    const result = calibrateJudges(
        pass(luna, ["baseline", "baseline", "baseline", "baseline"], digest),
        pass(fable, ["auto", "auto", "baseline", "equivalent"], digest),
        { seed: 1, resamples: 500 }
    );
    // target margin +100pp, reference (-1 -1 +1 0)/4 = -25pp.
    assert.equal(result.targetBaselineMarginPp, 100);
    assert.equal(result.referenceBaselineMarginPp, -25);
    assert.equal(result.judgeShiftPp, 125);
    assert.equal(result.exactAgreementRate, 0.25);
    assert.ok(result.ci95LowerPp > 0, "the interval should sit above zero");
});

test("the cross tab accounts for every pair", () => {
    const result = calibrateJudges(
        pass(luna, ["baseline", "auto", "equivalent", "baseline"], digest),
        pass(fable, ["baseline", "baseline", "equivalent", "auto"], digest),
        { seed: 1, resamples: 100 }
    );
    const total = Object.values(result.crossTab)
        .flatMap((row) => Object.values(row))
        .reduce((sum, count) => sum + count, 0);
    assert.equal(total, 4);
    assert.equal(result.crossTab.baseline.baseline, 1);
    assert.equal(result.crossTab.auto.baseline, 1);
    assert.equal(result.crossTab.equivalent.equivalent, 1);
    assert.equal(result.crossTab.baseline.auto, 1);
});

// Both judges saw the same pair, so a resample has to take or leave both of
// their answers together. Unpaired resampling would widen the interval.
test("the bootstrap is paired and replays from its seed", () => {
    const target = pass(luna, ["baseline", "baseline", "auto", "baseline"], digest);
    const reference = pass(fable, ["auto", "baseline", "auto", "equivalent"], digest);
    const once = calibrateJudges(target, reference, { seed: 20260827, resamples: 400 });
    const again = calibrateJudges(target, reference, { seed: 20260827, resamples: 400 });
    assert.equal(once.ci95LowerPp, again.ci95LowerPp);
    assert.equal(once.ci95UpperPp, again.ci95UpperPp);
    assert.ok(once.ci95LowerPp <= once.judgeShiftPp && once.judgeShiftPp <= once.ci95UpperPp);
});

// --- the refusals ----------------------------------------------------------

test("a reference judge that wrote answers in the bundle is refused", () => {
    const problems = calibrationProblems(
        pass(luna, ["baseline"], digest),
        pass(luna, ["auto"], digest),
        bundleAnswerIdentities(bundle())
    );
    assert.match(problems.join(" "), /both passes were judged by openai\/gpt-5.6-luna/);
    assert.match(problems.join(" "), /wrote answers in this bundle, so it is not independent/);
});

// The id-level trap, as a test: a judge whose catalogue id differs from the
// model it calls must still be caught.
test("independence is checked on the API model, not the catalogue id", () => {
    const writer = { modelId: "claude-opus-4-8", provider: "anthropic", apiModel: "claude-opus-5" };
    const judge = { modelId: "claude-opus-5", provider: "anthropic", apiModel: "claude-opus-5" };
    const problems = calibrationProblems(
        pass(luna, ["baseline"], digest),
        pass(judge, ["auto"], digest),
        [canonicalIdentity(writer)]
    );
    assert.match(problems.join(" "), /wrote answers in this bundle/);
});

test("passes over different bundles or different pairs are refused", () => {
    assert.match(
        calibrationProblems(pass(luna, ["baseline"], digest), pass(fable, ["auto"], "sha256:other")).join(" "),
        /name different bundles/
    );
    const shortReference = { ...pass(fable, ["auto"], digest), verdicts: [] };
    assert.match(
        calibrationProblems(pass(luna, ["baseline", "auto"], digest), shortReference).join(" "),
        /cover different pairs: 2 only in the target/
    );
});

test("comparable passes have nothing to report", () => {
    assert.deepEqual(
        calibrationProblems(
            pass(luna, ["baseline", "auto"], digest),
            pass(fable, ["auto", "auto"], digest),
            bundleAnswerIdentities(bundle())
        ),
        []
    );
});
