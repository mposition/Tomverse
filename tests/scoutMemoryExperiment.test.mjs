import assert from "node:assert/strict";
import test from "node:test";
import {
  ARM_NAMES,
  SCENARIOS,
  EXPERIMENT_VERSION,
  experimentCase,
  armProbe,
  scoreArm,
  summarizeTrials,
  trialStats,
  dailyScenario,
} from "../lib/scoutMemoryExperiment.ts";
import {
  rankMicroUsd,
  rankSyntheticDocuments,
} from "../lib/scoutMemoryCohere.ts";
import { MEMORY_PROBE_LOCALES } from "../lib/productResearchScoutMemoryCases.ts";
import { walkMemoryComparison } from "../lib/productResearchScoutMemoryWalk.mjs";
const day = "2026-11-12";
test("the same source and question can isolate retrieval, wrong decisions and abstention in every language", () => {
  for (const lang of MEMORY_PROBE_LOCALES) {
    assert.equal(
      new Set(
        ["12", "13", "14", "15"].map((d) =>
          dailyScenario("2026-11-" + d, lang),
        ),
      ).size,
      4,
    );
    for (const scenario of SCENARIOS) {
      const c = experimentCase(day, lang, scenario),
        oracle = armProbe(c, "oracle"),
        wrong = armProbe(c, "cohere", [0, 1, 2]),
        baseline = armProbe(c, "current");
      assert.equal(oracle.visible, scenario !== "absent");
      for (const p of [oracle, wrong, baseline]) {
        assert.equal(p.messages.at(-1).content, c.source.question);
        assert.deepEqual(p.messages[0], oracle.messages[0]);
      }
      assert.equal(wrong.visible, false);
      assert.equal(
        scoreArm(c, oracle, JSON.stringify(c.source.gold)).exact,
        true,
      );
      if (scenario !== "absent") {
        const answer = { ...c.source.gold, D: "UNKNOWN" };
        assert.deepEqual(scoreArm(c, oracle, JSON.stringify(answer)), {
          retrieved: true,
          exact: false,
          decision: true,
          exceptions: false,
          correctFields: 3,
          abstained: false,
        });
      } else
        assert.equal(
          scoreArm(c, oracle, JSON.stringify(c.source.gold)).retrieved,
          null,
        );
      if (scenario === "cross-language")
        assert.notEqual(c.sourceLanguage, lang);
    }
  }
});
test("rank indices must be complete, unique and in bounds; only usage returned by Cohere is priced", async (t) => {
  let json = {
    results: [{ index: 2 }, { index: 0 }, { index: 1 }],
    meta: { billed_units: { input_tokens: 920 } },
  };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.cohere.com/v2/rerank");
    const data = JSON.parse(init.body);
    assert.equal(data.model, "rerank-v5.0-fast");
    assert.deepEqual(data.documents, ["a", "b", "c"]);
    assert.equal(init.redirect, "error");
    return Response.json(json);
  });
  const run = () =>
    rankSyntheticDocuments("fixture", "question", ["a", "b", "c"]);
  assert.deepEqual(await run(), { indices: [2, 0, 1], billedTokens: 920 });
  assert.ok(Math.abs(rankMicroUsd(920) - 18.4) < 1e-9);
  assert.equal(rankMicroUsd(null), null);
  json = { results: [{ index: 1 }, { index: 1 }, { index: 2 }] };
  await assert.rejects(run, /invalid_ranking/);
  json = { results: [{ index: 1 }, { index: 3 }, { index: 0 }] };
  await assert.rejects(run, /invalid_ranking/);
});
test("Admin compares only complete triples of identical model and source and separates no-decision controls", () => {
  const row = {
    version: EXPERIMENT_VERSION,
    day,
    locale: "ko",
    scenario: "buried",
    model: "m",
    sourceDigest: "a",
    retrieved: true,
    decision: true,
    exceptions: false,
    exact: false,
    abstained: false,
    elapsedMs: 120,
    answerMicroUsd: 5,
    retrievalMicroUsd: 0,
  };
  const rows = ARM_NAMES.map((arm) => ({ ...row, arm }));
  const extra = { ...row, sourceDigest: "b", arm: "oracle" };
  const control = ARM_NAMES.map((arm) => ({
    ...row,
    arm,
    sourceDigest: "n",
    scenario: "absent",
    retrieved: null,
    abstained: true,
    exact: true,
  }));
  const grouped = summarizeTrials(
    [...rows, ...control, extra, { ...extra, arm: "current", model: "other" }],
    "m",
  )[0];
  assert.equal(grouped.pairs, 2);
  assert.equal(grouped.observed, 7);
  for (const a of grouped.arms) {
    assert.equal(a.sources, 1);
    assert.equal(a.retrieved, 1);
    assert.equal(a.exact, 0);
    assert.equal(a.abstained, 1);
    assert.equal(a.meanMicroUsd, 5);
  }
  assert.equal(
    trialStats([{ ...row, answerMicroUsd: null }]).meanMicroUsd,
    null,
  );
});
test("the daily comparison covers all three arms per language and stops on disabled or capped responses", async () => {
  const targets = [];
  await walkMemoryComparison(day, async (t) => {
    targets.push(t);
    return { judged: true };
  });
  assert.equal(targets.length, 24);
  assert.equal(new Set(targets).size, 24);
  for (const response of [
    { disabled: true },
    { reason: "daily_cap_reached" },
  ]) {
    let calls = 0;
    await walkMemoryComparison(day, async () => {
      calls++;
      return response;
    });
    assert.equal(calls, 1);
  }
});
