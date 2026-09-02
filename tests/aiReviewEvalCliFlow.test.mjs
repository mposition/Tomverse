// The two commands, run as commands, over a synthetic run.
//
// The unit tests cover the core's arithmetic. This covers the wiring: that
// `adjudicate:ai-review-eval` writes an artifact `check:ai-review-eval` accepts,
// and that editing the record afterwards makes the gate refuse it. Every defect
// found in this layer so far has been a seam between two scripts rather than a
// wrong calculation inside one, and a unit test on either side sees neither.
//
// Calls no model and touches no register.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AI_REVIEW_EVAL_BLIND_SHEET_RULES,
  AI_REVIEW_EVAL_LANGUAGES,
  AI_REVIEW_EVAL_MODES,
  AI_REVIEW_EVAL_TASK_TYPES,
} from "../lib/aiReviewEvalCore.ts";
import { renderBlindReviewRecordHeader } from "../lib/aiReviewBlindReviewRecord.ts";
import {
  rebuildBlindSheet,
  renderBlindSheet,
} from "../lib/aiReviewEvalBlindSheet.ts";
import { fileDigest } from "../lib/aiReviewEvidenceBundle.ts";
import { datasetDigest } from "../lib/aiReviewEvalRun.ts";
import { approvalBlockFromArtifact } from "../lib/aiReviewApprovalBlock.ts";

const COMMIT = "b".repeat(40);
const RUN = {
  runOrdinal: 1,
  reviewerModelId: "mistral-medium-3-1",
  promptVersion: "comparison-review-v3",
  sheetSeed: 1,
  thresholdVersion: "v1-draft",
};

const testCase = (index) => ({
  id: `en-safety-${String(index).padStart(3, "0")}`,
  language: index % 2 === 0 ? "en" : "ko",
  taskType: "safety_sensitive",
  phenomenon: "direct_contradiction",
  mode: "balanced",
  question: `question ${index}`,
  responses: [
    { label: "a", modelId: "m1", provider: "openai", content: "1889" },
    { label: "b", modelId: "m2", provider: "anthropic", content: "1887" },
  ],
  gold: { contradictions: [{ id: "year", anyOf: ["1887"], description: "the year" }] },
  goldCompleteness: { contradictions: true },
  status: "adopted",
  adoptedBy: "@mposition",
});

const observation = {
  findings: { contradictions: ["B says 1887"], missingPoints: [], differences: [] },
  allText: "the answers disagree about the year",
  reviewerProse: "the answers disagree about the year",
  totalQuotes: 0,
  matchedQuotes: 0,
  schemaValid: true,
};

const run = (args) =>
  spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", ...args],
    { encoding: "utf8", cwd: process.cwd() }
  );

const build = () => {
  const root = mkdtempSync(join(tmpdir(), "ai-review-cli-"));
  const setDirectory = join(root, "set");
  const runDirectory = join(root, "runs");
  mkdirSync(setDirectory);
  mkdirSync(runDirectory);

  // A full-coverage set. The gate re-checks sample adequacy against the file
  // it resolves the digest to, so anything smaller never reaches the checks
  // this test is about.
  const cases = [];
  for (const language of AI_REVIEW_EVAL_LANGUAGES) {
    for (const taskType of AI_REVIEW_EVAL_TASK_TYPES) {
      for (let index = 0; index < 100; index += 1) {
        const item = testCase(cases.length + 1);
        cases.push({
          ...item,
          language,
          taskType,
          mode: AI_REVIEW_EVAL_MODES[cases.length % AI_REVIEW_EVAL_MODES.length],
        });
      }
    }
  }
  const dataset = {
    version: "decision-v1",
    schemaVersion: 1,
    purpose: "decision",
    frozenAt: "2026-08-31",
    frozenBy: "@mposition",
    frozenDigest: null,
    cases,
  };
  dataset.frozenDigest = datasetDigest(dataset);
  const datasetPath = join(setDirectory, "decision-v1.json");
  writeFileSync(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);

  // Two runs, because an approval rests on two independent ones and the
  // register refuses a single ordinal reported twice.
  const runs = [1, 2].map((runOrdinal) => {
    const stem = `run-${runOrdinal}`;
    const artifactPath = join(runDirectory, `${stem}.json`);
    writeFileSync(
      artifactPath,
      `${JSON.stringify(
        {
          summary: {
            decisionGrade: true,
            datasetPurpose: "decision",
            datasetVersion: dataset.version,
            datasetDigest: datasetDigest(dataset),
            datasetSchemaVersion: 1,
            commitSha: COMMIT,
            workingTreeDirty: false,
            ...RUN,
            runOrdinal,
            seed: 0,
            plannedCases: cases.length,
            completedCases: cases.length,
            sampleAdequate: false,
            zeroToleranceViolations: 0,
          },
          metrics: {},
        },
        null,
        2
      )}\n`
    );
    writeFileSync(
      join(runDirectory, `${stem}.journal.jsonl`),
      `${cases.map((item) => JSON.stringify({ caseId: item.id, observation })).join("\n")}\n`
    );

    const answerKey = Object.fromEntries(
      cases.map((item, index) => [
        `S${String(index + 1).padStart(3, "0")}`,
        { caseId: item.id, gold: item.gold },
      ])
    );
    writeFileSync(
      join(runDirectory, `${stem}--answer-key.json`),
      `${JSON.stringify(answerKey, null, 2)}\n`
    );

    // The sheet a person reads, written because it is evidence: the approval
    // opens it and rebuilds it, so a fixture without one is a fixture that
    // never exercised the check.
    const sheetPath = join(runDirectory, `${stem}--blind-sheet.md`);
    const sheetMarkdown = renderBlindSheet(
      rebuildBlindSheet({
        cases,
        observations: new Map(cases.map((item) => [item.id, observation])),
        answerKey,
      }),
      {
        runOrdinal,
        reviewerModelId: RUN.reviewerModelId,
        promptVersion: RUN.promptVersion,
        datasetVersion: dataset.version,
        seed: RUN.sheetSeed,
        thresholdVersion: RUN.thresholdVersion,
      }
    );
    writeFileSync(sheetPath, sheetMarkdown);

    const recordPath = join(runDirectory, `${stem}--blind-review-record.csv`);
    const writeRecord = (marked = {}) => {
      const header = renderBlindReviewRecordHeader({
        ...RUN,
        runOrdinal,
        datasetDigest: datasetDigest(dataset),
        commitSha: COMMIT,
        blindSheetDigest: fileDigest(sheetMarkdown),
      })
        .replace("# signed-by: ", "# signed-by: @mposition")
        .replace("# signed-at: ", "# signed-at: 2026-08-31");
      const columns = ["label", ...AI_REVIEW_EVAL_BLIND_SHEET_RULES, "note"].join(",");
      const rows = Object.keys(answerKey).map((label) =>
        [
          label,
          ...AI_REVIEW_EVAL_BLIND_SHEET_RULES.map((rule) =>
            marked[label]?.includes(rule) ? "yes" : "no"
          ),
          "",
        ].join(",")
      );
      writeFileSync(recordPath, `${[header, columns, ...rows].join("\n")}\n`);
    };
    writeRecord();
    return { runOrdinal, stem, artifactPath, recordPath, sheetPath, answerKey, writeRecord };
  });

  return {
    root,
    setDirectory,
    datasetPath,
    dataset,
    runDirectory,
    runs,
    // The first run, for the tests that only need one.
    artifactPath: runs[0].artifactPath,
    recordPath: runs[0].recordPath,
    sheetPath: runs[0].sheetPath,
    stem: runs[0].stem,
    writeRecord: runs[0].writeRecord,
  };
};

test("adjudication derives its counts from the files, and refuses a record it cannot use", (t) => {
  const fixture = build();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const first = run([
    "scripts/adjudicate-ai-review-eval.mjs",
    `--artifact=${fixture.artifactPath}`,
    `--record=${fixture.recordPath}`,
    `--dataset=${fixture.datasetPath}`,
  ]);
  assert.equal(first.status, 0, first.stderr);
  const adjudicated = JSON.parse(
    readFileSync(join(fixture.runDirectory, `${fixture.stem}--adjudicated.json`), "utf8")
  );
  assert.equal(adjudicated.summary.adjudicated, true);
  assert.equal(adjudicated.summary.blindReviewCasesJudged, 1200);
  assert.equal(adjudicated.summary.completedCases, 1200);
  assert.equal(adjudicated.summary.zeroToleranceViolations, 0);
  // The seed the SHEET used, kept apart from the run's own seed. The runner
  // defaults to 0 and the sheet generator to 1, and reading one for the other
  // refused an ordinary pair of defaults.
  assert.equal(adjudicated.summary.blindReviewSheetSeed, 1);
  assert.equal(adjudicated.summary.seed, 0);
  assert.ok(adjudicated.summary.blindReviewRecordDigest.startsWith("sha256:"));
  assert.ok(adjudicated.summary.journalDigest.startsWith("sha256:"));

  // A person marks a rule only they can judge; the count moves.
  fixture.writeRecord({ S001: ["fabricated_safety_claim"] });
  const second = run([
    "scripts/adjudicate-ai-review-eval.mjs",
    `--artifact=${fixture.artifactPath}`,
    `--record=${fixture.recordPath}`,
    `--dataset=${fixture.datasetPath}`,
  ]);
  assert.equal(second.status, 0, second.stderr);
  const remade = JSON.parse(
    readFileSync(join(fixture.runDirectory, `${fixture.stem}--adjudicated.json`), "utf8")
  );
  assert.equal(remade.summary.zeroToleranceViolations, 1);
  assert.notEqual(
    remade.summary.blindReviewRecordDigest,
    adjudicated.summary.blindReviewRecordDigest
  );
});

test("adjudication refuses a journal missing cases and writes nothing", (t) => {
  const fixture = build();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const journalPath = join(fixture.runDirectory, `${fixture.stem}.journal.jsonl`);
  const lines = readFileSync(journalPath, "utf8").trim().split("\n");
  writeFileSync(journalPath, `${lines.slice(0, lines.length - 5).join("\n")}\n`);

  const result = run([
    "scripts/adjudicate-ai-review-eval.mjs",
    `--artifact=${fixture.artifactPath}`,
    `--record=${fixture.recordPath}`,
    `--dataset=${fixture.datasetPath}`,
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /was never scored/);
});

test("adjudication refuses an empty answer key rather than reporting five rules judged over nothing", (t) => {
  const fixture = build();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  writeFileSync(join(fixture.runDirectory, `${fixture.stem}--answer-key.json`), "{}\n");
  const result = run([
    "scripts/adjudicate-ai-review-eval.mjs",
    `--artifact=${fixture.artifactPath}`,
    `--record=${fixture.recordPath}`,
    `--dataset=${fixture.datasetPath}`,
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /answer key is empty/);
});

/** The register a gate run would read, written beside the fixture. */
const writeRegister = (fixture, adjudicated) => {
  const first = JSON.parse(readFileSync(adjudicated[0].path, "utf8")).summary;
  const registerPath = join(fixture.root, "register.json");
  writeFileSync(
    registerPath,
    `${JSON.stringify(
      [
        {
          reviewerModelId: first.reviewerModelId,
          promptVersion: first.promptVersion,
          status: "approved",
          owner: "fixture",
          registeredAt: "2026-08-31",
          evalBudget: null,
          evaluation: {
            runs: adjudicated.map(({ path, block }) => {
              const summary = JSON.parse(readFileSync(path, "utf8")).summary;
              return {
                artifactRef: path,
                runOrdinal: summary.runOrdinal,
                evaluatedCommit: summary.commitSha,
                datasetDigest: summary.datasetDigest,
                reviewerModelId: summary.reviewerModelId,
                promptVersion: summary.promptVersion,
                ...block,
              };
            }),
            datasetVersion: first.datasetVersion,
            datasetSchemaVersion: 1,
            datasetDigest: first.datasetDigest,
            languages: ["ko", "en"],
            sampleCounts: {},
            thresholdVersion: "v1-draft",
            zeroToleranceRulesHumanJudged: 5,
            blindReviewRef: first.humanBlindReviewRef,
            approver: "fixture",
            approvedAt: "2026-08-31",
            expiresAt: "2026-11-30",
            knownLimitations: "",
          },
        },
      ],
      null,
      2
    )}\n`
  );
  return registerPath;
};

/** The lines the gate printed under one of its section headings. */
const section = (stdout, heading) => {
  const lines = stdout.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^AI Review /.test(line.trim()));
  return (end < 0 ? rest : rest.slice(0, end)).filter((line) => line.trim() !== "");
};

test("the gate itself accepts the evidence, and refuses it once a verdict is edited", (t) => {
  // The link this closes. The tests above run adjudication; if the gate stopped
  // calling the shared evidence core tomorrow, all of them would still pass. So
  // this runs check:ai-review-eval as a command, over an isolated register and
  // evaluation-set directory, and pins both directions.
  const fixture = build();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const adjudicated = fixture.runs.map((entry) => {
    const result = run([
      "scripts/adjudicate-ai-review-eval.mjs",
      `--artifact=${entry.artifactPath}`,
      `--record=${entry.recordPath}`,
      `--dataset=${fixture.datasetPath}`,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const path = join(fixture.runDirectory, `${entry.stem}--adjudicated.json`);
    return {
      path,
      block: approvalBlockFromArtifact(JSON.parse(readFileSync(path, "utf8"))),
    };
  });

  const registerPath = writeRegister(fixture, adjudicated);
  const gate = (extra = []) =>
    run([
      "scripts/check-ai-review-eval-dataset.mjs",
      `--register=${registerPath}`,
      `--dataset-dir=${fixture.setDirectory}`,
      ...extra,
    ]);

  const clean = gate();
  // The override is announced, so a fixture run can never be read as a
  // statement about what this repository approved.
  assert.match(clean.stdout, /NOT the committed register/);

  const evidence = section(clean.stdout, "AI Review approved-entry evidence");
  const verdicts = evidence.filter((line) => /^\s+(ok|FAIL)\s/.test(line));
  assert.equal(verdicts.length, 2, clean.stdout);
  for (const line of verdicts) assert.match(line, /^\s+ok\s/, clean.stdout);
  // What the pass did NOT judge is printed beside it, so an "ok" cannot be
  // read as more than it is: no threshold set is signed, so no coverage bar
  // exists to apply.
  const notes = evidence.filter((line) => line.trim().startsWith("note"));
  assert.equal(notes.length, 2, clean.stdout);
  for (const line of notes) assert.match(line, /coverage not judged/);

  // The register-shape check still refuses, and for exactly one reason: the
  // threshold set is a proposal nobody has signed. That is permanent and
  // correct, so this asserts it is the ONLY remaining complaint rather than
  // asserting an exit code the repository can never produce.
  const shape = section(clean.stdout, "AI Review reviewer-pair register")
    .filter((line) => line.trim().startsWith("-"));
  assert.equal(shape.length, 1, clean.stdout);
  assert.match(shape[0], /is a proposal and has no approver/);
  // And exactly one: a set nobody approved is not separately guilty of not
  // saying when, so the date rule stays quiet rather than reporting one
  // absence twice.

  // A verdict changed in the record, and adjudication NOT re-run. The artifact
  // is stale; nothing about its own shape says so.
  fixture.runs[0].writeRecord({ S001: ["fabricated_safety_claim"] });
  const stale = gate();
  const staleEvidence = section(stale.stdout, "AI Review approved-entry evidence");
  assert.match(staleEvidence.join("\n"), /FAIL .* run 1/);
  assert.match(staleEvidence.join("\n"), /blindReviewRecordDigest/);
  assert.match(
    staleEvidence.join("\n"),
    /zeroToleranceViolations: the artifact says 0, the evidence says 1/
  );
  // The second run's record was not touched, so it still passes.
  assert.match(staleEvidence.join("\n"), /ok\s+.*run 2/);
  assert.equal(stale.status, 1);

  // And the pre-registration path refuses the same evidence, which it used to
  // pass: it checked the artifact's summary and stopped.
  const loose = gate([`--artifact=${adjudicated[0].path}`]);
  const looseSection = section(loose.stdout, "AI Review evaluation run artifact");
  assert.match(looseSection.join("\n"), /FAIL/);
  assert.match(looseSection.join("\n"), /blindReviewRecordDigest/);
});

test("the sheet a person read is evidence: deleted, or altered, and the gate refuses", (t) => {
  // The approval opened the record, the answer key and the journal, and never
  // the sheet -- the one artefact a human actually read. So a correct sheet, a
  // deleted sheet, a sheet of different questions and a sheet edited after the
  // verdicts were written were the same evidence.
  const fixture = build();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const adjudicated = fixture.runs.map((entry) => {
    const result = run([
      "scripts/adjudicate-ai-review-eval.mjs",
      `--artifact=${entry.artifactPath}`,
      `--record=${entry.recordPath}`,
      `--dataset=${fixture.datasetPath}`,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const path = join(fixture.runDirectory, `${entry.stem}--adjudicated.json`);
    return {
      path,
      block: approvalBlockFromArtifact(JSON.parse(readFileSync(path, "utf8"))),
    };
  });
  const registerPath = writeRegister(fixture, adjudicated);
  const gate = () =>
    run([
      "scripts/check-ai-review-eval-dataset.mjs",
      `--register=${registerPath}`,
      `--dataset-dir=${fixture.setDirectory}`,
    ]);

  const clean = section(gate().stdout, "AI Review approved-entry evidence");
  assert.equal(clean.filter((line) => /^\s+ok\s/.test(line)).length, 2);

  // Edited after the verdicts were written.
  const original = readFileSync(fixture.runs[0].sheetPath, "utf8");
  writeFileSync(
    fixture.runs[0].sheetPath,
    original.replace("question 1", "a completely different question")
  );
  const altered = section(gate().stdout, "AI Review approved-entry evidence").join("\n");
  assert.match(altered, /FAIL .* run 1/);
  assert.match(altered, /blindSheetDigest/);
  assert.match(altered, /not the sheet this answer key and run produce/);

  // Deleted.
  rmSync(fixture.runs[0].sheetPath);
  const gone = section(gate().stdout, "AI Review approved-entry evidence").join("\n");
  assert.match(gone, /the blind sheet is missing/);
  // The untouched second run still passes throughout.
  assert.match(gone, /ok\s+.*run 2/);
});

test("a signature date that is not a date, and a threshold version that does not exist", (t) => {
  const fixture = build();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const adjudicate = () =>
    run([
      "scripts/adjudicate-ai-review-eval.mjs",
      `--artifact=${fixture.artifactPath}`,
      `--record=${fixture.recordPath}`,
      `--dataset=${fixture.datasetPath}`,
    ]);

  // `signed-at: someday` used to pass adjudication and the approval check
  // alike, because only emptiness was tested.
  const record = readFileSync(fixture.recordPath, "utf8");
  writeFileSync(
    fixture.recordPath,
    record.replace("# signed-at: 2026-08-31", "# signed-at: someday")
  );
  const undated = adjudicate();
  assert.equal(undated.status, 1);
  assert.match(undated.stderr, /signature date "someday" is not a date/);

  // Naming a bar that is not in this tree is a failure, not a note: the
  // evidence claims to have been produced under a threshold nobody can look up.
  writeFileSync(
    fixture.recordPath,
    record.replace("# threshold-version: v1-draft", "# threshold-version: v-does-not-exist")
  );
  const unknown = adjudicate();
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /"v-does-not-exist", which does not exist/);

  // And naming nothing at all. The runbook described this as an ok plus a
  // scope note for a while; it never was, because the record's identity check
  // requires the version. Pinned so the contract and the behaviour cannot
  // drift apart again -- and pinned NEGATIVELY too: no coverage note.
  writeFileSync(
    fixture.recordPath,
    record
      .split("\n")
      .filter((line) => !line.startsWith("# threshold-version:"))
      .join("\n")
  );
  const absent = adjudicate();
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /does not state thresholdVersion/);
  assert.doesNotMatch(absent.stderr, /coverage not judged/);
});

test("evidence with no threshold version fails the gate, and gets no coverage note", (t) => {
  // The same contract from the other side: an artifact that reached the
  // register without a version must FAIL rather than pass with a note.
  const fixture = build();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const adjudicated = fixture.runs.map((entry) => {
    const result = run([
      "scripts/adjudicate-ai-review-eval.mjs",
      `--artifact=${entry.artifactPath}`,
      `--record=${entry.recordPath}`,
      `--dataset=${fixture.datasetPath}`,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const path = join(fixture.runDirectory, `${entry.stem}--adjudicated.json`);
    return {
      path,
      block: approvalBlockFromArtifact(JSON.parse(readFileSync(path, "utf8"))),
    };
  });
  const registerPath = writeRegister(fixture, adjudicated);

  // Strip the version the register names AND the one the artifact recorded,
  // which is every place the gate could find one.
  const register = JSON.parse(readFileSync(registerPath, "utf8"));
  delete register[0].evaluation.thresholdVersion;
  writeFileSync(registerPath, JSON.stringify(register, null, 2));
  for (const { path } of adjudicated) {
    const artifact = JSON.parse(readFileSync(path, "utf8"));
    delete artifact.summary.blindReviewThresholdVersion;
    writeFileSync(path, JSON.stringify(artifact, null, 2));
  }

  const result = run([
    "scripts/check-ai-review-eval-dataset.mjs",
    `--register=${registerPath}`,
    `--dataset-dir=${fixture.setDirectory}`,
  ]);
  const evidence = section(result.stdout, "AI Review approved-entry evidence").join("\n");
  assert.match(evidence, /FAIL/);
  assert.match(evidence, /no threshold version/);
  assert.doesNotMatch(evidence, /coverage not judged/);
  assert.equal(result.status, 1);
});
