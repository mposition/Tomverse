import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  VOICE_MIX_PROTOCOL,
  VOICE_MIX_SCORING_VERSION,
  aggregateVoiceMixScores,
  containsVoiceMixForm,
  editDistance,
  normalizeVoiceMixText,
  scoreVoiceMixTranscript,
  voiceMixCorpusProblems,
  voiceMixRunProblems,
} from "../lib/voiceMixEvalCore.ts";

/**
 * VOICE-MIX-01. The scorer is the one part of the evaluation that runs before
 * any recording exists, so it is the part that has to be right first: each
 * failure it reports must be the failure that happened, and a transcript that
 * got something wrong must not score as if it had not. These transcripts are
 * written by hand to plant one failure each; none came from a provider.
 */

const corpusBytes = readFileSync("docs/ops/voice-mix-eval/corpus.v1.json");
const corpus = JSON.parse(corpusBytes.toString("utf8"));
const corpusDigest = createHash("sha256").update(corpusBytes).digest("hex");
const script = (id) => corpus.items.find((item) => item.id === id).script;
const score = (itemId, transcript) =>
  scoreVoiceMixTranscript(corpus, { itemId, take: "planted", repeat: 1, transcript });
const segmentsOmitted = (result, language) =>
  result.segments.filter((segment) => segment.language === language && segment.omitted).length;

test("the shipped corpus passes its own structural checks", () => {
  assert.deepEqual(voiceMixCorpusProblems(corpus), []);
});

test("a transcript identical to the script scores clean on every measure", () => {
  for (const item of corpus.items) {
    const result = score(item.id, item.script);
    assert.equal(result.korean.errors, 0, item.id);
    assert.equal(result.english.errors, 0, item.id);
    assert.deepEqual(result.missingKeyTerms, [], item.id);
    assert.deepEqual(result.missingMeaning, [], item.id);
    assert.notEqual(result.numbersInOrder, false, item.id);
    assert.equal(result.segments.filter((segment) => segment.omitted).length, 0, item.id);
    assert.deepEqual(result.insertedHintTerms, [], item.id);
  }
});

test("punctuation, case, width and Korean spacing are not errors", () => {
  const result = score("dev-04", "please keep the api name in english 설명은 한국어로 해주세요");
  assert.equal(result.english.errors, 0);
  assert.equal(result.korean.errors, 0);
  assert.equal(normalizeVoiceMixText("Ｔｏｍｖｅｒｓｅ!!"), "tomverse");
});

/* ------------------------------------------------ boundary matching ---- */

test("a number does not match inside a longer number", () => {
  assert.equal(containsVoiceMixForm("300 초에서 60 초로", "30"), false);
  assert.equal(containsVoiceMixForm("50개", "5"), false);
  assert.equal(containsVoiceMixForm("30 초", "30"), true);
  assert.equal(containsVoiceMixForm("3개로", "3개"), true);
});

test("a Latin term does not match inside another word, but does beside a Korean particle", () => {
  assert.equal(containsVoiceMixForm("a rapid reply", "API"), false);
  assert.equal(containsVoiceMixForm("이 API의 timeout을", "API"), true);
  assert.equal(containsVoiceMixForm("timeouts", "timeout"), false);
});

test("a hint term inside a longer script word is still counted as inserted", () => {
  const custom = structuredClone(corpus);
  custom.hintVocabulary = ["API"];
  custom.hintPrompt = "API";
  const result = scoreVoiceMixTranscript(custom, {
    itemId: "holdout-06",
    take: "planted",
    repeat: 1,
    transcript: "Let's compare three models side by side and pick the cheapest one API.",
  });
  assert.deepEqual(result.insertedHintTerms, ["API"]);
});

test("forms that normalise to nothing are refused by the corpus check", () => {
  const broken = structuredClone(corpus);
  broken.items[0].keyTerms[0].accept.push("!!");
  assert.ok(voiceMixCorpusProblems(broken).some((problem) => problem.includes("normalises to nothing")));
});

/* ------------------------------------------------- ordered alignment ---- */

test("saying the two halves of a switch in the wrong order is not a clean transcript", () => {
  const result = score("dev-04", "설명은 한국어로 해 주세요. Please keep the API name in English.");
  assert.ok(result.korean.errors + result.english.errors > 0);
  assert.ok(result.segments.some((segment) => segment.omitted), "one half cannot align in order");
});

test("text from one segment cannot fill in for an omitted segment", () => {
  // "다른" appears in the kept Korean half; the dropped first segment must stay dropped.
  const result = score("holdout-01", "GPT 답변과 다른 점만 알려 주세요.");
  assert.equal(result.segments[0].omitted, true, "Claude");
  assert.equal(result.segments[1].omitted, true, "답변을 요약하고");
  assert.equal(result.segments[3].omitted, false);
});

test("swapped numbers keep both numbers and lose the order", () => {
  const result = score("dev-03", "이 API의 timeout을 육십 초에서 삼십 초로 바꿔 주세요.");
  assert.deepEqual(result.missingNumbers, []);
  assert.equal(result.numbersInOrder, false);
});

test("a dropped negation is a meaning failure, not just a few character errors", () => {
  const result = score("dev-02", "staging에서 확인한 다음 production에는 아직 배포하세요.");
  assert.deepEqual(result.missingMeaning, ["do not deploy"]);
  assert.ok(result.korean.errors <= 2, "the character error count alone would hide it");
});

test("a dropped English clause is an omission, not a translation", () => {
  const result = score("dev-04", "설명은 한국어로 해 주세요.");
  assert.equal(segmentsOmitted(result, "en"), 1);
  assert.equal(result.segments[0].likelyTranslated, false);
});

test("an English clause said back in Korean, in its place, is a likely translation", () => {
  const result = score("dev-04", "API 이름은 영어로 유지해 주시고, 설명은 한국어로 해 주세요.");
  assert.equal(result.segments[0].omitted, true);
  assert.equal(result.segments[0].likelyTranslated, true);
});

test("unrelated Korean added elsewhere does not turn an omission into a translation", () => {
  const result = score("holdout-08", "이 문장은 번역하지 말고 그대로 적어 주세요.");
  assert.equal(result.segments[1].omitted, true);
  assert.equal(result.segments[1].likelyTranslated, false);
});

test("a Korean transliteration keeps the term, is an English word error, and is not a translation", () => {
  const result = score("dev-02", "스테이징에서 확인한 다음 프로덕션에는 아직 배포하지 마세요.");
  assert.deepEqual(result.missingKeyTerms, []);
  assert.equal(result.english.errors > 0, true);
  const english = result.segments.filter((segment) => segment.language === "en");
  assert.ok(english.every((segment) => segment.omitted && segment.transliterated && !segment.likelyTranslated));
});

test("exactly half a segment matched is not an omission; less than half is", () => {
  // holdout-03's English segment has 4 words; 2 of them matched is exactly half.
  const exactlyHalf = score("holdout-03", "The deadline 그러니까 목요일까지 초안을 보내 주세요.");
  assert.equal(exactlyHalf.segments[0].units, 4);
  assert.equal(exactlyHalf.segments[0].matched, 2);
  assert.equal(exactlyHalf.segments[0].omitted, false);
  const lessThanHalf = score("holdout-03", "The 그러니까 목요일까지 초안을 보내 주세요.");
  assert.equal(lessThanHalf.segments[0].omitted, true);
});

test("a hint term nobody said is an insertion; one that was said is not", () => {
  const inserted = score("holdout-07", "Tomverse PDF에서 표만 뽑아서 CSV로 만들어 주세요.");
  assert.deepEqual(inserted.insertedHintTerms, ["Tomverse"]);
  assert.deepEqual(score("dev-01", script("dev-01")).insertedHintTerms, []);
});

test("an unknown item id is refused rather than scored as zero", () => {
  assert.throws(() => score("nope", "anything"), /does not have/);
});

/* ------------------------------------------------------- aggregation ---- */

test("error rates are corpus rates, not a mean of per-transcript rates", () => {
  const short = score("dev-05", "GPT와 MCP는 서로 다른 약어입니다."); // clean
  const wrong = score("holdout-05", "크레딧이 남았으면 알림을 보내 주세요."); // many Korean errors
  const aggregate = aggregateVoiceMixScores([short, wrong], "all");
  const expected = (short.korean.errors + wrong.korean.errors) / (short.korean.units + wrong.korean.units);
  assert.equal(aggregate.koreanCharErrorRate.rate, Math.round(expected * 10_000) / 10_000);
  assert.equal(aggregate.koreanCharErrorRate.units, short.korean.units + wrong.korean.units);
});

test("aggregates keep each measure apart, give segment denominators, and split by stratum", () => {
  const scores = [
    score("dev-03", "이 API의 timeout을 육십 초에서 삼십 초로 바꿔 주세요."),
    score("holdout-01", script("holdout-01")),
    score("holdout-07", "Tomverse PDF에서 표만 뽑아서 CSV로 만들어 주세요."),
  ];
  const holdout = aggregateVoiceMixScores(scores, "holdout");
  assert.equal(holdout.transcripts, 2);
  assert.ok(holdout.omittedSegments.en.total > 0);
  assert.deepEqual(holdout.hintInsertion, { transcripts: 1, terms: 1 });
  assert.equal(aggregateVoiceMixScores(scores, "holdout", "hint-target").transcripts, 1);
  assert.equal(aggregateVoiceMixScores(scores, "holdout", "hint-absent").transcripts, 1);
  assert.deepEqual(aggregateVoiceMixScores(scores, "dev").numberOrder, { kept: 0, total: 1 });
  assert.equal("recognitionRate" in holdout, false);
});

/* --------------------------------------------------------- integrity ---- */

test("the hint vocabulary may only name what dev scripts say, and the prompt carries all of it", () => {
  const leaked = structuredClone(corpus);
  leaked.hintVocabulary = [...leaked.hintVocabulary, "Claude"];
  assert.ok(voiceMixCorpusProblems(leaked).some((problem) => problem.includes("does not come from a dev script")));
  const prompt = structuredClone(corpus);
  prompt.hintPrompt = "Tomverse";
  assert.ok(voiceMixCorpusProblems(prompt).some((problem) => problem.includes("hint prompt does not carry")));
});

const holdoutIds = corpus.items.filter((item) => item.split === "holdout").map((item) => item.id);
const takes = ["a/quiet", "a/noise", "b/quiet", "b/noise"];
const manifest = {
  corpus: corpus.version,
  corpusDigest,
  scoringVersion: VOICE_MIX_SCORING_VERSION,
  items: holdoutIds,
  takes,
  repeats: VOICE_MIX_PROTOCOL.repeats,
  arms: [
    { arm: "no-hint", model: "m", prompt: null },
    { arm: "hint", model: "m", prompt: corpus.hintPrompt },
  ],
};
const fullRun = (arm, prompt, model = "m") => ({
  arm,
  model,
  prompt,
  entries: manifest.items.flatMap((itemId) =>
    takes.flatMap((take) =>
      [1, 2, 3].map((repeat) => ({ itemId, take, repeat, transcript: script(itemId) }))
    )
  ),
});
const runProblems = (m, runs, digest = corpusDigest) => voiceMixRunProblems(corpus, digest, m, runs);
const bothArms = () => [fullRun("no-hint", null), fullRun("hint", corpus.hintPrompt)];

test("a run exactly as registered has no integrity problems", () => {
  assert.deepEqual(runProblems(manifest, bothArms()), []);
});

test("missing, duplicated, extra and unpaired entries are refused", () => {
  const partial = fullRun("hint", corpus.hintPrompt);
  partial.entries = partial.entries.slice(1);
  partial.entries.push({ ...partial.entries[0] });
  partial.entries.push({ itemId: "holdout-03", take: "c/quiet", repeat: 1, transcript: "x" });
  const problems = runProblems(manifest, [fullRun("no-hint", null), partial]);
  assert.ok(problems.some((problem) => problem.includes("missing")));
  assert.ok(problems.some((problem) => problem.includes("duplicate")));
  assert.ok(problems.some((problem) => problem.includes("unregistered")));
  const oneArm = runProblems(manifest, [fullRun("no-hint", null)]);
  assert.ok(oneArm.some((problem) => problem.includes("arm hint has no run")));
});

test("a different model or prompt than registered is refused", () => {
  const otherModel = { ...fullRun("no-hint", null), model: "other" };
  const otherPrompt = fullRun("hint", "Tomverse only");
  const problems = runProblems(manifest, [otherModel, otherPrompt]);
  assert.ok(problems.some((problem) => problem.includes("registered m")));
  assert.ok(problems.some((problem) => problem.includes("prompt other than")));
});

test("a manifest that departs from the registered protocol is refused", () => {
  const cases = [
    [{ ...manifest, items: holdoutIds.slice(1) }, "exactly the corpus holdout items"],
    [{ ...manifest, items: ["dev-01"] }, "exactly the corpus holdout items"],
    [{ ...manifest, takes: ["a/quiet", "a/noise"] }, "speakers are registered"],
    [{ ...manifest, takes: ["a/quiet", "b/quiet"] }, "conditions are registered"],
    [{ ...manifest, takes: ["a/quiet", "a/noise", "b/quiet"] }, "every speaker records every condition"],
    [{ ...manifest, repeats: 1 }, "repeats must be"],
    [{ ...manifest, arms: [manifest.arms[0]] }, "exactly no-hint and hint"],
    [{ ...manifest, arms: [manifest.arms[0], { ...manifest.arms[1], prompt: "Tomverse" }] }, "exactly the corpus hintPrompt"],
    [{ ...manifest, arms: [{ ...manifest.arms[0], prompt: "x" }, manifest.arms[1]] }, "sends no prompt"],
    [{ ...manifest, arms: [manifest.arms[0], { ...manifest.arms[1], model: "other" }] }, "same model"],
    [{ ...manifest, takes: ["a-quiet", "a/noise", "b/quiet", "b/noise"] }, "takes must be speaker/condition"],
    [{ ...manifest, takes: ["a/quiet", "a/quiet", "b/quiet", "b/noise"] }, "takes repeat"],
    [{ ...manifest, arms: [{ arm: "no-hint", prompt: null }, { arm: "hint", prompt: corpus.hintPrompt }] }, "registers no model"],
  ];
  for (const [candidate, expected] of cases) {
    assert.ok(
      runProblems(candidate, bothArms()).some((problem) => problem.includes(expected)),
      `expected a problem containing "${expected}"`
    );
  }
});

test("a run that names no model is refused even when the manifest names none", () => {
  const noModel = { ...manifest, arms: [{ arm: "no-hint", prompt: null }, { arm: "hint", prompt: corpus.hintPrompt }] };
  const runs = bothArms().map((run) => {
    const withoutModel = { ...run };
    delete withoutModel.model;
    return withoutModel;
  });
  const problems = runProblems(noModel, runs);
  assert.ok(problems.some((problem) => problem.includes("names no model")));
  assert.ok(problems.some((problem) => problem.includes("registers no model")));
});

test("a manifest registered against another corpus file is refused", () => {
  assert.ok(runProblems(manifest, bothArms(), "0".repeat(64)).some((problem) => problem.includes("different corpus file")));
});

test("edit distance is the plain Levenshtein distance", () => {
  assert.equal(editDistance([..."kitten"], [..."sitting"]), 3);
  assert.equal(editDistance([], [..."abc"]), 3);
});

/* --------------------------------------------------------------- CLI ---- */

const cli = (args) =>
  spawnSync(process.execPath, ["--import", "tsx", "scripts/score-voice-mix-eval.mjs", ...args], { encoding: "utf8" });

test("the CLI refuses an unregistered run and holdout items in a pipeline check", () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-mix-"));
  const write = (name, value) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const manifestPath = write("manifest.json", manifest);
  const good = [write("a.json", fullRun("no-hint", null)), write("b.json", fullRun("hint", corpus.hintPrompt))];

  const ok = cli(["--manifest", manifestPath, "--transcripts", good[0], "--transcripts", good[1], "--json"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).runs.length, 2);

  const partial = cli(["--manifest", manifestPath, "--transcripts", good[0]]);
  assert.equal(partial.status, 1);

  const noManifest = cli(["--transcripts", good[0]]);
  assert.equal(noManifest.status, 2);

  const pipelineHoldout = cli(["--pipeline-check", "--transcripts", good[0]]);
  assert.equal(pipelineHoldout.status, 1);

  const devRun = write("dev.json", {
    arm: "no-hint",
    model: "m",
    prompt: null,
    entries: [{ itemId: "dev-01", take: "tts", repeat: 1, transcript: script("dev-01") }],
  });
  const pipeline = cli(["--pipeline-check", "--transcripts", devRun]);
  assert.equal(pipeline.status, 0, pipeline.stderr);
  assert.match(pipeline.stdout, /Not evidence/);
});
