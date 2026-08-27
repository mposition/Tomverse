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

import { AVAILABLE_MODELS, getModel } from "../lib/models.ts";
import { evaluationRecordProblems } from "../lib/routerQualityEvalCore.ts";
import { calibrationArtefactProblems } from "../lib/routerJudgeCalibration.ts";
import {
  cellFill,
  freezeDrift,
  evalSetProblems,
  unrecordedProvenanceItems,
} from "../lib/routerQualityEvalSet.ts";
import { duplicatePrompts } from "../lib/routerEvalReviewSheet.ts";

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
  const problems = [...evalSetProblems(set)];

  // Duplicate IDS are caught by evalSetProblems; duplicate TEXT is not, and it
  // is the one that matters here. The same prompt under two ids is one item
  // counted twice, which inflates a cell towards its target without adding
  // anything for the Router to be measured on.
  for (const duplicate of duplicatePrompts(set.items ?? [])) {
    problems.push(
      `${duplicate.ids.join(", ")} share one prompt; the same question under two ids ` +
        "fills a cell without adding evidence"
    );
  }

  // docs/ops/tomverse-chat-router-evaluation-set.md §2. Cells are independent, so fill is reported per cell and never pooled.
  // A short cell is only an ERROR once a person has said the pool is finished:
  // during collection every cell is short, and a check that is red throughout
  // the work it is meant to supervise stops being read.
  const fill = cellFill(set);
  const short = fill.filter((cell) => cell.short > 0);
  if (set.pilotReady === true && short.length > 0) {
    for (const cell of short) {
      problems.push(
        `${cell.stratum}/${cell.cell} has ${cell.adopted} adopted of ${cell.target}; ` +
          "the file declares pilotReady"
      );
    }
  }

  report(`${path} (${set.purpose ?? "no purpose"})`, problems);

  if (fill.some((cell) => cell.target > 0)) {
    const source = (set.cellTargets ?? []).length > 0 ? "frozen cellTargets" : "proposedPilotCellTarget (a proposal, not the docs/ops/tomverse-chat-router-evaluation-set.md §11 freeze record)";
    console.log(`\n       cell fill against ${source}`);
    for (const cell of fill) {
      const bar = cell.short === 0 ? "full" : `short ${cell.short}`;
      console.log(
        `         ${`${cell.stratum}/${cell.cell}`.padEnd(44)}` +
          `${String(cell.adopted).padStart(3)} adopted  ` +
          `${String(cell.candidates).padStart(3)} candidate  of ${cell.target}  ${bar}`
      );
    }
    const totalAdopted = fill.reduce((sum, cell) => sum + cell.adopted, 0);
    const totalTarget = fill.reduce((sum, cell) => sum + cell.target, 0);
    console.log(
      `         ${"total".padEnd(44)}${String(totalAdopted).padStart(3)} adopted of ${totalTarget}` +
        (set.pilotReady === true ? "  [pilotReady]" : "  [collection in progress]")
    );
  }

  // The baseline decides what a run is compared against, so a run reported
  // without one has no verdict in it. Printed next to the fill because the two
  // together are what docs/ops/tomverse-chat-router-evaluation-set.md §11 asks of
  // a set before it is frozen: a stated target, and a stated thing to beat.
  const baseline = set.baseline ?? null;
  console.log(
    baseline?.modelId
      ? `\n       baseline ${baseline.modelId}, pre-registered ${baseline.preRegisteredAt ?? "at no stated time"} ` +
          `by ${baseline.preRegisteredBy ?? "nobody named"}, catalogue ${baseline.catalogueVersion ?? "unpinned"}`
      : "\n       no baseline pre-registered — a run against this set would have nothing to beat"
  );
  // freezeDrift, not `set.frozenAt`: a date in the file says a person typed
  // one, and the question a reader has is whether the set still holds what was
  // frozen. Reported for a development set too -- it is not a failure there,
  // but it is the same fact, and a check that only mentions drift once it is
  // fatal teaches nobody to look for it.
  const drift = freezeDrift(set);
  console.log(
    drift
      ? `       ${drift}`
      : `       frozen ${set.frozenAt} by ${set.frozenBy}, sample digest verified`
  );
  // The judge and the seed decide what the numbers mean as much as the
  // baseline does: who grades, and which answer they read first. Printed here
  // so a reader can see all three fixed points at once, or see one missing.
  console.log(
    set.judge?.modelId
      ? `       judge ${set.judge.modelId}, pre-registered ${set.judge.preRegisteredAt ?? "at no stated time"} ` +
          `by ${set.judge.preRegisteredBy ?? "nobody named"}`
      : "       no judge pre-registered — nothing fixes who grades the pairs"
  );
  console.log(
    set.seed?.value
      ? `       seed ${set.seed.value}, pre-registered ${set.seed.preRegisteredAt ?? "at no stated time"} ` +
          `by ${set.seed.preRegisteredBy ?? "nobody named"}`
      : "       no seed pre-registered — the arm ordering was not fixed in advance"
  );

  // A drafted item recording provider "unrecorded" satisfies the schema while
  // reconstructing nothing. Counted here so the gap is visible rather than
  // reading as a filled field.
  const unrecorded = unrecordedProvenanceItems(set);
  if (unrecorded.length > 0) {
    console.log(
      `\n       ${unrecorded.length} drafted item(s) have no reconstructable drafter ` +
        `(provider "unrecorded"): ${unrecorded.slice(0, 4).map((item) => item.id).join(", ")}` +
        `${unrecorded.length > 4 ? ", …" : ""}`
    );
    console.log(
      "         Not a failure — a truthful record of a real gap. docs/ops/tomverse-chat-router-evaluation-set.md §8 makes the drafter a\n" +
        "         confound the reviewer weighs, so an item that cannot name one is weaker\n" +
        "         evidence and a reviewer may reject it on that ground alone."
    );
  }
};

const checkReport = (path) => {
  const record = readJson(path);
  if (record.__unreadable) {
    report(path, [`could not be read: ${record.__unreadable}`]);
    return;
  }

  // The judge identity is taken from the report rather than the catalogue: the
  // check has to work on a report written months ago, against a catalogue that
  // has since moved, and a calibration is of the model that actually graded.
  const judge = getModel(String(record.judge?.identity ?? ""));
  const problems = [
    ...evaluationRecordProblems(record, {
      routableModelIds,
      checkCalibration: judge
        ? (artefact) =>
            calibrationArtefactProblems(artefact, {
              judgeIdentity: {
                modelId: judge.id,
                provider: judge.provider,
                apiModel: judge.apiModel,
              },
              judgeTemplateVersion: String(record.versions?.template ?? ""),
              evaluationSetPurpose: String(record.evaluationSetPurpose ?? ""),
            })
        : undefined,
    }),
  ];
  if (!judge && record.judge?.isRoutableModel === true) {
    problems.push(
      `its judge "${String(record.judge?.identity)}" is not in the catalogue, so the calibration ` +
        "it cites cannot be checked against the model that graded"
    );
  }

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
