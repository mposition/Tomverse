import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EVAL_CELLS,
  EVAL_STRATA,
  adoptedItems,
  evalSampleDigest,
  evalSetProblems,
  uniformCellTargets,
} from "../lib/routerQualityEvalSet.ts";

// A set that is still being edited produces an interval that looks exactly
// like one from a frozen set. These tests are the difference.

const item = (overrides = {}) => ({
  id: "gen-ko-001",
  stratum: "general_question_answering",
  cell: "ko",
  // docs/ops/tomverse-chat-router-evaluation-set.md §8 records language beside
  // stratum and cell, as a pair: the cross-language cell is a direction rather
  // than one language, and collapsing it would lose the ability to ask about
  // Korean prompts separately from Korean answers.
  language: { prompt: "ko", expectedResponse: "ko" },
  source: "drafted",
  status: "candidate",
  adoptedBy: null,
  adoptedAt: null,
  // A drafted item records its drafter, because that drafter is the confound
  // docs/ops/tomverse-chat-router-evaluation-set.md §8 makes a person weigh before adopting.
  draftProvenance: {
    batchId: "test-batch",
    provider: "openai",
    modelId: "gpt-5-5",
    requestedApiModel: "gpt-5.5",
    generationParameters: { max_completion_tokens: 8000 },
    modelVersion: null,
    promptTemplateVersion: "router-eval-draft-v1",
    promptTemplateHash: "0000000000000000",
    generatorCommit: null,
    draftedAt: "2026-08-24T00:00:00.000Z",
  },
  prompt: "전세와 월세의 차이를 설명해 주세요.",
  ...overrides,
});

const developmentSet = (overrides = {}) => ({
  version: "router-eval-development-v0",
  purpose: "development",
  frozenAt: null,
  frozenBy: null,
  baseline: null,
  cellTargets: [],
  items: [item()],
  ...overrides,
});

// frozenDigest is derived rather than written in, so a test that changes the
// items keeps testing what it changed instead of tripping the freeze check.
// The drift tests set it by hand.
const decisionSet = (overrides = {}) => {
  const base = decisionSetFields(overrides);
  return { frozenDigest: evalSampleDigest(base), ...base };
};

const decisionSetFields = (overrides = {}) => ({
  version: "router-eval-decision-v1",
  purpose: "decision",
  frozenAt: "2026-08-10T00:00:00.000Z",
  frozenBy: "qa-lead",
  baseline: {
    modelId: "gpt-5-6-luna",
    catalogueVersion: "catalogue-2026-08-01",
    preRegisteredAt: "2026-08-01T00:00:00.000Z",
    preRegisteredBy: "backend-ai-lead",
    rationale: "the shipping default, so non-inferiority is measured against what users get today",
  },
  cellTargets: [{ stratum: "general_question_answering", cell: "ko", target: 120 }],
  items: [
    item({ status: "adopted", adoptedBy: "qa-lead", adoptedAt: "2026-08-05", source: "real" }),
  ],
  ...overrides,
});

test("every stratum in §2 has at least one cell, and Korean is a cell of its own", () => {
  for (const stratum of EVAL_STRATA) {
    assert.ok(EVAL_CELLS[stratum].length > 0, `${stratum} has no cells`);
  }
  // §2: Korean is first-class everywhere except the stratum that is mixed by
  // construction, where it is half of the only cell.
  assert.deepEqual(EVAL_CELLS.translation_cross_language, ["ko-en"]);
  for (const stratum of EVAL_STRATA.filter((name) => name !== "translation_cross_language")) {
    assert.ok(EVAL_CELLS[stratum].includes("ko"), `${stratum} has no Korean cell`);
  }
});

test("a well-formed development set has nothing to report", () => {
  assert.deepEqual(evalSetProblems(developmentSet()), []);
});

test("a development set is allowed to be nothing but candidates", () => {
  const problems = evalSetProblems(developmentSet(), { expectedPurpose: "development" });
  assert.deepEqual(problems, []);
});

test("a well-formed decision set has nothing to report", () => {
  assert.deepEqual(evalSetProblems(decisionSet(), { expectedPurpose: "decision" }), []);
});

// §7. The two sets exist so that tuning against one does not contaminate the
// other, and running a decision run against the development set is exactly
// the contamination the split prevents.
test("a development set cannot stand in for a decision set", () => {
  const problems = evalSetProblems(developmentSet(), { expectedPurpose: "decision" });
  assert.match(problems.join(" "), /a decision set was required/);
});

test("a decision set full of candidates is refused", () => {
  const problems = evalSetProblems(
    decisionSet({ items: [item(), item({ id: "gen-ko-002" })] }),
    { expectedPurpose: "decision" }
  );
  assert.match(problems.join(" "), /still candidates/);
});

// §8/§10. An adopted item with no adopter adopted itself, which is the one
// step the procedure reserves for a person.
test("an adopted item must name who adopted it and when", () => {
  const problems = evalSetProblems(
    decisionSet({ items: [item({ status: "adopted", adoptedBy: null, adoptedAt: null })] })
  );
  assert.match(problems.join(" "), /records no adopter and date/);
});

test("a decision set must carry a freeze record", () => {
  const problems = evalSetProblems(decisionSet({ frozenAt: null, frozenBy: null }));
  assert.match(problems.join(" "), /freeze record/);
});

test("a decision set must pre-register a complete baseline", () => {
  assert.match(
    evalSetProblems(decisionSet({ baseline: null })).join(" "),
    /pre-register its baseline/
  );
  for (const field of [
    "modelId",
    "catalogueVersion",
    "preRegisteredAt",
    "preRegisteredBy",
    "rationale",
  ]) {
    const baseline = { ...decisionSet().baseline };
    delete baseline[field];
    assert.ok(
      evalSetProblems(decisionSet({ baseline })).length > 0,
      `a baseline with no ${field} was accepted`
    );
  }
});

// §4, at the set level rather than the report level: a baseline named after
// the set was frozen was named with the questions already in hand.
test("a baseline pre-registered after the freeze is refused", () => {
  const problems = evalSetProblems(
    decisionSet({
      baseline: { ...decisionSet().baseline, preRegisteredAt: "2026-08-11T00:00:00.000Z" },
    })
  );
  assert.match(problems.join(" "), /after the set was frozen/);
});

test("a decision set with no cell targets cannot have a short cell", () => {
  const problems = evalSetProblems(decisionSet({ cellTargets: [] }));
  assert.match(problems.join(" "), /must declare its cell targets/);
});

test("an item outside §2's strata and cells is caught", () => {
  assert.match(
    evalSetProblems(developmentSet({ items: [item({ stratum: "vibes" })] })).join(" "),
    /unknown stratum/
  );
  assert.match(
    evalSetProblems(developmentSet({ items: [item({ cell: "fr" })] })).join(" "),
    /not a cell of/
  );
  // A Korean cell on the mixed stratum is a real mistake: that stratum's whole
  // point is that the input is mixed.
  assert.match(
    evalSetProblems(
      developmentSet({
        items: [item({ stratum: "translation_cross_language", cell: "ko" })],
      })
    ).join(" "),
    /not a cell of/
  );
});

test("a cell target naming a cell that does not exist would never be filled", () => {
  const problems = evalSetProblems(
    decisionSet({
      cellTargets: [{ stratum: "coding", cell: "fr", target: 10 }],
    })
  );
  assert.match(problems.join(" "), /unknown cell/);
});

test("duplicate ids are caught, because one item would silently answer twice", () => {
  const problems = evalSetProblems(developmentSet({ items: [item(), item()] }));
  assert.match(problems.join(" "), /more than once/);
});

test("an item with no prompt, source or status is incomplete", () => {
  for (const field of ["prompt", "source", "status"]) {
    const broken = item();
    delete broken[field];
    assert.ok(
      evalSetProblems(developmentSet({ items: [broken] })).length > 0,
      `an item with no ${field} was accepted`
    );
  }
});

test("an empty or non-object set is a problem, not an empty pass", () => {
  assert.ok(evalSetProblems(null).length > 0);
  assert.ok(evalSetProblems(developmentSet({ items: [] })).length > 0);
});

test("adopted items exclude candidates", () => {
  const set = developmentSet({
    items: [item(), item({ id: "gen-ko-002", status: "adopted", adoptedBy: "a", adoptedAt: "b" })],
  });
  assert.equal(adoptedItems(set).length, 1);
  assert.equal(adoptedItems(set)[0].id, "gen-ko-002");
});

test("uniform targets cover every cell of every stratum", () => {
  const targets = uniformCellTargets(60);
  const cells = EVAL_STRATA.reduce((total, stratum) => total + EVAL_CELLS[stratum].length, 0);
  assert.equal(targets.length, cells);
  assert.ok(targets.every((target) => target.target === 60));
  assert.deepEqual(evalSetProblems(decisionSet({ cellTargets: targets })), []);
});

// The committed pool is what the harness is pointed at first, so a typo in it
// would be found by an operator mid-run rather than here.
test("the committed candidate pool is well formed and covers every cell", () => {
  const path = "docs/ops/router-evaluation-set/development-v0.json";
  const set = JSON.parse(readFileSync(path, "utf8"));

  assert.deepEqual(evalSetProblems(set, { expectedPurpose: "development" }), []);

  const covered = new Set(set.items.map((entry) => `${entry.stratum}/${entry.cell}`));
  for (const stratum of EVAL_STRATA) {
    for (const cell of EVAL_CELLS[stratum]) {
      assert.ok(covered.has(`${stratum}/${cell}`), `the pool has no item for ${stratum}/${cell}`);
    }
  }
  // docs/ops/tomverse-chat-router-evaluation-set.md §8: a model-drafted pool is
  // a candidate pool, and adoption is a human act. This used to assert that
  // nothing was adopted, which held only until a person adopted something --
  // it fixed a state rather than the rule. The rule is that an adopted item
  // names who adopted it and when; an agent writing `adopted` has no adopter
  // to name, so the assertion still catches exactly what it was for.
  for (const entry of set.items) {
    assert.ok(
      entry.status === "candidate" || entry.status === "adopted",
      `${entry.id} has status ${entry.status}`
    );
    if (entry.status === "adopted") {
      assert.ok(entry.adoptedBy, `${entry.id} is adopted but names no adopter`);
      assert.ok(entry.adoptedAt, `${entry.id} is adopted but records no date`);
    } else {
      assert.equal(entry.adoptedBy, null, `${entry.id} is a candidate but names an adopter`);
      assert.equal(entry.adoptedAt, null, `${entry.id} is a candidate but records a date`);
    }
  }
  assert.equal(
    adoptedItems(set).length,
    set.items.filter((entry) => entry.status === "adopted").length
  );
});

// The gate check is the thing an operator runs before citing a report, so its
// refusals are worth more than its acceptances.
const runCheck = (args) => {
  try {
    return {
      code: 0,
      output: execFileSync("node", ["--import", "tsx", "scripts/check-router-quality-eval.mjs", ...args], {
        encoding: "utf8",
      }),
    };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
};

test("the gate check says plainly that no decision run exists", { timeout: 120_000 }, () => {
  const { code, output } = runCheck([]);
  assert.equal(code, 0);
  assert.match(output, /No decision-grade run exists/);
  assert.match(output, /development-v0\.json/);
});

test("the gate check refuses a pilot report as ROUTE-01 evidence", { timeout: 120_000 }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "route01-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "pilot.json");
  const record = {
    mode: "pilot",
    evaluationSetPurpose: "development",
    evaluationSetVersion: "router-eval-development-v0",
    cellCounts: { "coding/ko": 12 },
    startedAt: "2026-08-12T00:00:00.000Z",
    baseline: {
      modelId: "gpt-5-6-luna",
      catalogueVersion: "catalogue-2026-08-01",
      preRegisteredAt: "2026-08-01T00:00:00.000Z",
    },
    versions: { router: "router-decision-v1", estimator: "e", planner: "none", template: "t" },
    sampleSize: 12,
    discordantPairs: 4,
    pairedUnit: "one question, two arms",
    ciMethod: "bootstrap_percentile",
    seed: 1,
    pointEstimatePp: 8,
    ci95LowerPp: -1,
    ci95UpperPp: 17,
    outcome: "measured",
    judge: { identity: "human-panel-a", isRoutableModel: false },
    exclusions: [],
  };
  writeFileSync(file, JSON.stringify(record), "utf8");

  const { code, output } = runCheck([`--report=${file}`]);
  assert.equal(code, 1, "a pilot report was accepted as ROUTE-01 evidence");
  assert.match(output, /only --mode=decision produces ROUTE-01 evidence/);
  assert.match(output, /§7 keeps separate/);
});
