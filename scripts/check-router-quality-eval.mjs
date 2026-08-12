// Whether a Router quality evaluation may be cited as ROUTE-01 evidence.
//
// Two things get checked, and they fail independently:
//
//   - the evaluation set, against docs/ops/tomverse-chat-router-evaluation-set.md
//     (§2 strata, §7 development/decision split, §8 adoption records, §4
//     baseline pre-registration);
//   - the report a run produced, against §9's list of what a decision-grade
//     record must carry, plus ROUTE-01's own -2pp bound.
//
// A perfect interval computed over a set that was still being edited passes
// neither check alone, which is why both run.
//
// Usage:
//   node --import tsx scripts/check-router-quality-eval.mjs
//   ... --set=<path>       validate an evaluation set file
//   ... --report=<path>    validate a report emitted by scripts/eval-router-quality.mjs
//
// With no arguments it validates every set file committed under
// docs/ops/router-evaluation-set/ and says plainly that no decision report
// exists yet, rather than passing silently and reading as approval.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { AVAILABLE_MODELS } from "../lib/models.ts";
import { evaluationRecordProblems } from "../lib/routerQualityEvalCore.ts";
import { evalSetProblems } from "../lib/routerQualityEvalSet.ts";

const SET_DIRECTORY = "docs/ops/router-evaluation-set";
const MARGIN_PP = -2;

const argValue = (name) => {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : "";
};

const routableModelIds = AVAILABLE_MODELS.map((model) => model.id);
let failures = 0;

const report = (label, problems) => {
  if (problems.length === 0) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}`);
  for (const problem of problems) console.log(`         - ${problem}`);
};

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { __unreadable: String(error) };
  }
};

const checkSet = (path) => {
  const set = readJson(path);
  if (set.__unreadable) {
    report(path, [`could not be read: ${set.__unreadable}`]);
    return;
  }
  // Purpose is read from the file rather than asserted: a development set is
  // *allowed* to be full of candidates, and demanding otherwise would make
  // the drafting stage impossible. What the file may not do is claim to be a
  // decision set without carrying a decision set's records.
  report(`${path} (${set.purpose ?? "no purpose"})`, [...evalSetProblems(set)]);
};

const checkReport = (path) => {
  const record = readJson(path);
  if (record.__unreadable) {
    report(path, [`could not be read: ${record.__unreadable}`]);
    return;
  }

  const problems = [...evaluationRecordProblems(record, { routableModelIds })];

  // A pilot or bias run is a valid artefact and an invalid citation. §7 keeps
  // them apart precisely because a pilot's numbers look exactly like a
  // decision run's.
  if (record.mode !== "decision") {
    problems.push(
      `this is a ${String(record.mode)} run; only --mode=decision produces ROUTE-01 evidence`
    );
  }
  if (record.evaluationSetPurpose !== "decision") {
    problems.push(
      `it ran against a ${String(record.evaluationSetPurpose)} set, which §7 keeps separate from the decision set`
    );
  }
  if (record.outcome !== "measured") {
    problems.push(
      `the run was ${String(record.outcome)}: ${(record.outcomeReasons ?? []).join("; ") || "no reason recorded"}`
    );
  }
  if (record.truncatedByCost === true) {
    problems.push("the run stopped at its cost ceiling, so the set was only partly evaluated");
  }
  // §7 again. A second run against the same frozen set reports how well the
  // Router fits its own test set, which is not what the gate is asking.
  if (typeof record.decisionSetUseIndex === "number" && record.decisionSetUseIndex > 1) {
    problems.push(
      `this is use ${record.decisionSetUseIndex} of set ${String(record.evaluationSetVersion)}; ` +
        "a decision set that has been run against before is replaced, not reused"
    );
  }

  report(path, problems);

  if (problems.length === 0) {
    const lower = record.ci95LowerPp;
    console.log(
      `       delta ${Number(record.pointEstimatePp).toFixed(2)}pp, ` +
        `95% lower bound ${Number(lower).toFixed(2)}pp against a ${MARGIN_PP}pp margin — ` +
        `${lower >= MARGIN_PP ? "met" : "NOT met"}`
    );
    console.log(
      "       Meeting the metric is not approval. ROUTE-01's approvedBy and evidenceRefs\n" +
        "       are human entries in docs/release-gates/tomverse-chat-v1.yaml."
    );
  }
};

const setPath = argValue("set");
const reportPath = argValue("report");

console.log("Router quality evaluation — ROUTE-01 evidence check\n");

if (setPath) {
  console.log("Evaluation sets");
  checkSet(setPath);
} else if (existsSync(SET_DIRECTORY)) {
  console.log("Evaluation sets");
  const files = readdirSync(SET_DIRECTORY).filter((name) => name.endsWith(".json"));
  if (files.length === 0) {
    console.log(`  none committed under ${SET_DIRECTORY}`);
  }
  for (const file of files) checkSet(join(SET_DIRECTORY, file));
}

console.log("\nRun reports");
if (reportPath) {
  checkReport(reportPath);
} else {
  // Said out loud, because an empty section that printed nothing would read
  // as a pass, and "no decision run has happened" is the actual state.
  console.log("  none supplied. Pass --report=<path> to validate one.");
  console.log(
    "  No decision-grade run exists in this repository, so ROUTE-01 has no evidence\n" +
      "  and remains pending regardless of what the shadow numbers show."
  );
}

if (failures > 0) {
  console.log(
    `\n${failures} file(s) failed. Nothing here may be cited as ROUTE-01 evidence.`
  );
  process.exit(1);
}
console.log("\nNo problems found in what was checked.");
