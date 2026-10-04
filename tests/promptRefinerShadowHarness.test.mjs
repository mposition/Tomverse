import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import {
  canonicalBenchmarkJson,
} from "../lib/routerDevelopmentBenchmark.ts";
import {
  PROMPT_REFINER_SHADOW_MAX_OUTPUT_BYTES,
  evaluatePromptRefinerShadowCase,
  parsePromptRefinerShadowCorpus,
  parsePromptRefinerShadowOutput,
  promptRefinerShadowCorpusDigest,
  validatePromptRefinerShadowCorpus,
} from "../lib/promptRefinerShadowHarness.ts";
import {
  promptRefinerShadowPaths,
  replayPromptRefinerShadowJournal as replayPromptRefinerShadowJournalCore,
  runPromptRefinerShadowHarness as runPromptRefinerShadowHarnessCore,
} from "../lib/promptRefinerShadowJournal.ts";
import {
  PROMPT_REFINER_SHADOW_SOURCE_PATHS,
  validatePromptRefinerShadowSource,
} from "../lib/promptRefinerShadowSource.ts";

const root = resolve(import.meta.dirname, "..");
const corpusText = readFileSync(
  join(root, "docs/ops/prompt-refiner-shadow/corpus-v1.json"),
  "utf8"
);
const corpus = parsePromptRefinerShadowCorpus(corpusText);
const temporary = mkdtempSync(join(tmpdir(), "prompt-refiner-shadow-core-"));
const sourceIdentity = Object.freeze({
  sourceRef: "a".repeat(40),
  identityDigest: "b".repeat(64),
});

const runPromptRefinerShadowHarness = (input) =>
  runPromptRefinerShadowHarnessCore({ ...input, sourceIdentity });
const replayPromptRefinerShadowJournal = (input) =>
  replayPromptRefinerShadowJournalCore({ ...input, sourceIdentity });

after(() => {
  const target = resolve(temporary);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith("prompt-refiner-shadow-core-"));
  rmSync(target, { recursive: true });
});

function journal(name) {
  return join(temporary, `${name}.jsonl`);
}

function texts(path) {
  const paths = promptRefinerShadowPaths(path);
  return {
    paths,
    journalText: readFileSync(paths.journal, "utf8"),
    witnessText: readFileSync(paths.witness, "utf8"),
  };
}

const hash = (value) =>
  createHash("sha256").update(canonicalBenchmarkJson(value), "utf8").digest("hex");

function redigest(value) {
  const unsigned = structuredClone(value);
  delete unsigned.contentDigest;
  value.contentDigest = promptRefinerShadowCorpusDigest(unsigned);
  return value;
}

function appendRehashed(journalText, witnessText, event) {
  const entries = journalText.trimEnd().split("\n").map(JSON.parse);
  const body = {
    seq: entries.length,
    previousDigest: entries.at(-1).entryDigest,
    event,
  };
  const entry = { ...body, entryDigest: hash(body) };
  return {
    journalText: `${journalText}${canonicalBenchmarkJson(entry)}\n`,
    witnessText: `${witnessText}${canonicalBenchmarkJson({ seq: entry.seq, entryDigest: entry.entryDigest })}\n`,
  };
}

function ioFailingFsync({ journalPath, target, occurrence, message }) {
  const opened = new Map();
  let flushes = 0;
  const expectedPath =
    target === "journal" ? resolve(journalPath) : resolve(`${journalPath}.witness.jsonl`);
  return {
    openSync(path, ...args) {
      const descriptor = fs.openSync(path, ...args);
      opened.set(descriptor, resolve(path));
      return descriptor;
    },
    closeSync(descriptor) {
      opened.delete(descriptor);
      return fs.closeSync(descriptor);
    },
    readSync: fs.readSync,
    writeSync: fs.writeSync,
    fsyncSync(descriptor) {
      if (opened.get(descriptor) === expectedPath && ++flushes === occurrence) {
        throw new Error(message);
      }
      return fs.fsyncSync(descriptor);
    },
    fstatSync: fs.fstatSync,
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    unlinkSync: fs.unlinkSync,
    lstatSync: fs.lstatSync,
  };
}

test("the frozen corpus is balanced, synthetic, digested and deterministic", () => {
  assert.equal(corpus.cases.length, 16);
  assert.equal(corpus.cases.filter((item) => item.language === "ko").length, 8);
  assert.equal(corpus.cases.filter((item) => item.language === "en").length, 8);
  assert.equal(corpus.dataClassification, "synthetic_test_only");
  assert.ok(corpus.cases.every((item) => evaluatePromptRefinerShadowCase(item).behavioralOutcomeMatched));
  assert.ok(corpus.cases.every((item) => evaluatePromptRefinerShadowCase(item).structuralBoundaryViolations === 0));

  const unsigned = structuredClone(corpus);
  delete unsigned.contentDigest;
  assert.equal(promptRefinerShadowCorpusDigest(unsigned), corpus.contentDigest);

  const tampered = structuredClone(corpus);
  tampered.cases[0].sourceText += " changed";
  assert.throws(() => validatePromptRefinerShadowCorpus(tampered), /corpus_digest/);
  assert.throws(
    () => parsePromptRefinerShadowCorpus(corpusText.replace('"schemaVersion"', '"schemaVersion"\n, "schemaVersion"')),
    /corpus_json_duplicate_key|corpus_json_syntax/
  );

  const credentialLike = structuredClone(corpus);
  credentialLike.cases[0].sourceText =
    "Use this synthetic-looking credential sk_abcdefghijklmnop safely.";
  redigest(credentialLike);
  assert.throws(
    () => validatePromptRefinerShadowCorpus(credentialLike),
    /case_not_synthetic_safe/
  );

  const characterOverflow = structuredClone(corpus);
  const overlongRefinement = "가".repeat(16_001);
  characterOverflow.cases[0].fixtureOutput = JSON.stringify({
    refinedPrompt: overlongRefinement,
  });
  characterOverflow.cases[0].expected = {
    status: "suggested",
    failureCode: null,
    refinedPrompt: overlongRefinement,
  };
  redigest(characterOverflow);
  assert.throws(
    () => validatePromptRefinerShadowCorpus(characterOverflow),
    /expected_refined_prompt_invalid_string/
  );
});

test("strict output parsing rejects repair, extra fields, duplicate keys, BOM, blanks and no-change", () => {
  const sourceText = "Explain the tradeoff.";
  assert.deepEqual(
    parsePromptRefinerShadowOutput({
      sourceText,
      outputText: '{"refinedPrompt":"Explain the tradeoff in a two-column comparison."}',
    }),
    {
      status: "suggested",
      failureCode: null,
      refinedPrompt: "Explain the tradeoff in a two-column comparison.",
    }
  );
  for (const outputText of [
    "prose before {\"refinedPrompt\":\"different\"}",
    "```json\n{\"refinedPrompt\":\"different\"}\n```",
    '{"refinedPrompt":"different","extra":true}',
    '{"refinedPrompt":"one","refinedPrompt":"two"}',
    '{"refinedPrompt":1}',
    '\ufeff{"refinedPrompt":"different"}',
    "\ufeff",
    " ".repeat(PROMPT_REFINER_SHADOW_MAX_OUTPUT_BYTES + 1),
  ]) {
    assert.deepEqual(parsePromptRefinerShadowOutput({ sourceText, outputText }), {
      status: "failed",
      failureCode: "invalid_response",
      refinedPrompt: null,
    });
  }
  for (const outputText of ["", "   ", '{"refinedPrompt":"   "}']) {
    assert.equal(
      parsePromptRefinerShadowOutput({ sourceText, outputText }).failureCode,
      "empty_response"
    );
  }
  assert.equal(
    parsePromptRefinerShadowOutput({
      sourceText,
      outputText: '{"refinedPrompt":"  Explain the tradeoff.  "}',
    }).failureCode,
    "no_change"
  );
  assert.equal(
    parsePromptRefinerShadowOutput({
      sourceText,
      outputText: "x".repeat(PROMPT_REFINER_SHADOW_MAX_OUTPUT_BYTES + 1),
    }).failureCode,
    "invalid_response"
  );
  assert.equal(
    parsePromptRefinerShadowOutput({
      sourceText,
      outputText: JSON.stringify({ refinedPrompt: "a".repeat(16_001) }),
    }).failureCode,
    "invalid_response"
  );
});

test("structural boundary evidence and behavioral fixture evidence remain separate", () => {
  const injection = structuredClone(
    corpus.cases.find((item) => item.category === "prompt_injection")
  );
  const normal = evaluatePromptRefinerShadowCase(injection);
  assert.equal(normal.structuralBoundaryViolations, 0);
  assert.equal(normal.behavioralOutcomeMatched, true);

  injection.expected = {
    status: "failed",
    failureCode: "invalid_response",
    refinedPrompt: null,
  };
  const changedExpectation = evaluatePromptRefinerShadowCase(injection);
  assert.equal(changedExpectation.structuralBoundaryViolations, 0);
  assert.equal(changedExpectation.behavioralOutcomeMatched, false);
});

test("a full local run completes with content-free zero-call zero-cost evidence", () => {
  const path = journal("complete");
  const report = runPromptRefinerShadowHarness({
    corpus,
    journalPath: path,
    resume: false,
  });
  assert.deepEqual(
    {
      status: report.status,
      processedCases: report.processedCases,
      structuralBoundaryPopulation: report.structuralBoundaryPopulation,
      structuralBoundaryViolations: report.structuralBoundaryViolations,
      behavioralOutcomePopulation: report.behavioralOutcomePopulation,
      behavioralOutcomeMatches: report.behavioralOutcomeMatches,
      providerCalls: report.providerCalls,
      costMicroUsd: report.costMicroUsd,
    },
    {
      status: "completed",
      processedCases: 16,
      structuralBoundaryPopulation: 16,
      structuralBoundaryViolations: 0,
      behavioralOutcomePopulation: 16,
      behavioralOutcomeMatches: 16,
      providerCalls: 0,
      costMicroUsd: 0,
    }
  );
  const evidence = texts(path);
  for (const item of corpus.cases) {
    assert.doesNotMatch(evidence.journalText, new RegExp(item.sourceText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    if (item.expected.refinedPrompt) {
      assert.doesNotMatch(evidence.journalText, new RegExp(item.expected.refinedPrompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  }
  assert.doesNotMatch(JSON.stringify(report), /sourceText|fixtureOutput|refinedPrompt/);
  assert.throws(
    () => runPromptRefinerShadowHarness({ corpus, journalPath: path, resume: false }),
    /existing_journal_requires_resume/
  );
  assert.throws(
    () => runPromptRefinerShadowHarness({ corpus, journalPath: path, resume: true }),
    /journal_not_resumable/
  );
});

test("controlled stops resume in deterministic corpus order", () => {
  const path = journal("resume");
  const first = runPromptRefinerShadowHarness({
    corpus,
    journalPath: path,
    resume: false,
    maxCases: 5,
  });
  assert.equal(first.status, "stopped");
  assert.equal(first.stopReason, "case_limit");
  assert.equal(first.processedCases, 5);
  assert.equal(first.resumable, true);

  const second = runPromptRefinerShadowHarness({
    corpus,
    journalPath: path,
    resume: true,
    maxCases: 4,
  });
  assert.equal(second.status, "stopped");
  assert.equal(second.processedCases, 9);

  const final = runPromptRefinerShadowHarness({
    corpus,
    journalPath: path,
    resume: true,
  });
  assert.equal(final.status, "completed");
  assert.equal(final.processedCases, 16);
  assert.equal(final.providerCalls, 0);
});

test("a structural or behavioral mismatch stops non-resumably without a call", () => {
  const mismatched = structuredClone(corpus);
  mismatched.cases[0].expected = {
    status: "failed",
    failureCode: "invalid_response",
    refinedPrompt: null,
  };
  redigest(mismatched);
  const validated = validatePromptRefinerShadowCorpus(mismatched);
  const path = journal("behavioral-mismatch");
  const report = runPromptRefinerShadowHarness({
    corpus: validated,
    journalPath: path,
    resume: false,
  });
  assert.equal(report.status, "stopped");
  assert.equal(report.stopReason, "behavioral_fixture_mismatch");
  assert.equal(report.resumable, false);
  assert.equal(report.processedCases, 1);
  assert.equal(report.providerCalls, 0);
  assert.equal(report.costMicroUsd, 0);
  assert.throws(
    () =>
      runPromptRefinerShadowHarness({
        corpus: validated,
        journalPath: path,
        resume: true,
      }),
    /journal_not_resumable/
  );

  const completedStop = texts(path);
  const interruptedJournal =
    completedStop.journalText.split("\n").slice(0, 3).join("\n") + "\n";
  const interruptedWitness =
    completedStop.witnessText.split("\n").slice(0, 4).join("\n") + "\n";
  const replay = replayPromptRefinerShadowJournal({
    corpus: validated,
    journalText: interruptedJournal,
    witnessText: interruptedWitness,
  });
  assert.equal(replay.status, "interrupted");
  assert.equal(replay.unknownCases, 0);
  assert.equal(replay.resumable, false);

  const interruptedPath = journal("behavioral-mismatch-interrupted");
  const interruptedFiles = promptRefinerShadowPaths(interruptedPath);
  writeFileSync(interruptedFiles.journal, interruptedJournal);
  writeFileSync(interruptedFiles.witness, interruptedWitness);
  assert.throws(
    () =>
      runPromptRefinerShadowHarness({
        corpus: validated,
        journalPath: interruptedPath,
        resume: true,
      }),
    /journal_not_resumable/
  );
});

test("a mismatch on the final case records a replayable non-resumable stop", () => {
  const mismatched = structuredClone(corpus);
  mismatched.cases.at(-1).expected = {
    status: "failed",
    failureCode: "invalid_response",
    refinedPrompt: null,
  };
  redigest(mismatched);
  const validated = validatePromptRefinerShadowCorpus(mismatched);
  const path = journal("final-behavioral-mismatch");
  const report = runPromptRefinerShadowHarness({
    corpus: validated,
    journalPath: path,
    resume: false,
  });
  assert.equal(report.status, "stopped");
  assert.equal(report.stopReason, "behavioral_fixture_mismatch");
  assert.equal(report.resumable, false);
  assert.equal(report.processedCases, 16);
  assert.equal(report.remainingCases, 0);
  const evidence = texts(path);
  const replay = replayPromptRefinerShadowJournal({
    corpus: validated,
    journalText: evidence.journalText,
    witnessText: evidence.witnessText,
  });
  assert.equal(replay.status, "stopped");
  assert.equal(replay.resumable, false);
});

test("an interrupted intent is unknown and never redispatched", () => {
  const completePath = journal("unknown-source");
  runPromptRefinerShadowHarness({ corpus, journalPath: completePath, resume: false });
  const complete = texts(completePath);
  const journalLines = complete.journalText.split("\n").slice(0, 2).join("\n") + "\n";
  const witnessLines = complete.witnessText.split("\n").slice(0, 3).join("\n") + "\n";
  const replay = replayPromptRefinerShadowJournal({
    corpus,
    journalText: journalLines,
    witnessText: witnessLines,
  });
  assert.equal(replay.status, "interrupted");
  assert.equal(replay.unknownCases, 1);
  assert.equal(replay.resumable, false);

  const path = journal("unknown");
  const paths = promptRefinerShadowPaths(path);
  writeFileSync(paths.journal, journalLines);
  writeFileSync(paths.witness, witnessLines);
  assert.throws(
    () => runPromptRefinerShadowHarness({ corpus, journalPath: path, resume: true }),
    /journal_not_resumable/
  );
  assert.equal(readFileSync(paths.journal, "utf8"), journalLines);
});

test("intent fsync failures cannot become a witnessed evaluation or a fresh retry", () => {
  for (const [target, occurrence] of [
    ["journal", 2],
    ["witness", 3],
  ]) {
    const path = journal(`intent-${target}-fsync`);
    const message = `synthetic_${target}_intent_fsync_failure`;
    assert.throws(
      () =>
        runPromptRefinerShadowHarness({
          corpus,
          journalPath: path,
          resume: false,
          io: ioFailingFsync({
            journalPath: path,
            target,
            occurrence,
            message,
          }),
        }),
      new RegExp(message)
    );
    assert.throws(
      () =>
        runPromptRefinerShadowHarness({
          corpus,
          journalPath: path,
          resume: true,
        }),
      /journal_witness_mismatch|journal_not_resumable/
    );
  }
});

test("a clean interruption between cases can resume, while stale locks fail closed", () => {
  const completePath = journal("interruption-source");
  runPromptRefinerShadowHarness({ corpus, journalPath: completePath, resume: false });
  const complete = texts(completePath);
  const journalLines = complete.journalText.split("\n").slice(0, 3).join("\n") + "\n";
  const witnessLines = complete.witnessText.split("\n").slice(0, 4).join("\n") + "\n";
  const path = journal("interrupted");
  const paths = promptRefinerShadowPaths(path);
  writeFileSync(paths.journal, journalLines);
  writeFileSync(paths.witness, witnessLines);
  const replay = replayPromptRefinerShadowJournal({ corpus, journalText: journalLines, witnessText: witnessLines });
  assert.equal(replay.status, "interrupted");
  assert.equal(replay.unknownCases, 0);
  assert.equal(replay.resumable, true);
  assert.equal(runPromptRefinerShadowHarness({ corpus, journalPath: path, resume: true }).status, "completed");

  const lockedPath = journal("locked");
  const locked = promptRefinerShadowPaths(lockedPath);
  writeFileSync(locked.lock, "operator-owned stale or active lock");
  assert.throws(
    () => runPromptRefinerShadowHarness({ corpus, journalPath: lockedPath, resume: false }),
    /lock_unavailable_no_stale_recovery/
  );
});

test("a final-terminal interruption finalizes without an invalid resume event", () => {
  const completePath = journal("final-interruption-source");
  runPromptRefinerShadowHarness({
    corpus,
    journalPath: completePath,
    resume: false,
  });
  const complete = texts(completePath);
  const journalLines = complete.journalText.trimEnd().split("\n");
  const witnessLines = complete.witnessText.trimEnd().split("\n");
  assert.equal(JSON.parse(journalLines.at(-1)).event.kind, "run_completed");

  const path = journal("final-interrupted");
  const paths = promptRefinerShadowPaths(path);
  const interruptedJournal = `${journalLines.slice(0, -1).join("\n")}\n`;
  const interruptedWitness = `${witnessLines.slice(0, -1).join("\n")}\n`;
  writeFileSync(paths.journal, interruptedJournal);
  writeFileSync(paths.witness, interruptedWitness);
  const replay = replayPromptRefinerShadowJournal({
    corpus,
    journalText: interruptedJournal,
    witnessText: interruptedWitness,
  });
  assert.equal(replay.status, "interrupted");
  assert.equal(replay.unknownCases, 0);
  assert.equal(replay.remainingCases, 0);
  assert.equal(replay.resumable, true);

  const report = runPromptRefinerShadowHarness({
    corpus,
    journalPath: path,
    resume: true,
  });
  assert.equal(report.status, "completed");
  const finalized = texts(path);
  const appendedEvents = finalized.journalText
    .slice(interruptedJournal.length)
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line).event.kind);
  assert.deepEqual(appendedEvents, ["run_completed"]);
});

test("journal replay rejects truncation, rollback, duplicate terminals and conflicting results", () => {
  const path = journal("tamper");
  runPromptRefinerShadowHarness({ corpus, journalPath: path, resume: false });
  const full = texts(path);
  assert.throws(
    () => replayPromptRefinerShadowJournal({ corpus, journalText: full.journalText.slice(0, -1), witnessText: full.witnessText }),
    /journal_truncated/
  );

  const olderJournal = full.journalText.split("\n").slice(0, 3).join("\n") + "\n";
  assert.throws(
    () => replayPromptRefinerShadowJournal({ corpus, journalText: olderJournal, witnessText: full.witnessText }),
    /journal_witness_mismatch/
  );

  const baseJournal = full.journalText.split("\n").slice(0, 3).join("\n") + "\n";
  const baseWitness = full.witnessText.split("\n").slice(0, 4).join("\n") + "\n";
  const firstTerminal = JSON.parse(baseJournal.trimEnd().split("\n").at(-1)).event;
  const duplicated = appendRehashed(baseJournal, baseWitness, firstTerminal);
  assert.throws(
    () => replayPromptRefinerShadowJournal({ corpus, ...duplicated }),
    /duplicate_or_orphan_terminal/
  );

  const conflicting = structuredClone(firstTerminal);
  conflicting.behavioralOutcomeMatched = !conflicting.behavioralOutcomeMatched;
  const conflictJournal = full.journalText.split("\n").slice(0, 2).join("\n") + "\n";
  const conflictWitness = full.witnessText.split("\n").slice(0, 3).join("\n") + "\n";
  const conflict = appendRehashed(conflictJournal, conflictWitness, conflicting);
  assert.throws(
    () => replayPromptRefinerShadowJournal({ corpus, ...conflict }),
    /terminal_result_mismatch/
  );
});

test("source validation permits only the fixed exact-byte allowlist", () => {
  const files = Object.fromEntries(
    PROMPT_REFINER_SHADOW_SOURCE_PATHS.map((path) => [path, `bytes:${path}\n`])
  );
  const sourceRef = "a".repeat(40);
  const valid = validatePromptRefinerShadowSource({
    sourceRef,
    anchored: files,
    current: files,
  });
  assert.equal(valid.sourceRef, sourceRef);
  assert.equal(Object.keys(valid.files).length, PROMPT_REFINER_SHADOW_SOURCE_PATHS.length);
  assert.match(valid.identityDigest, /^[a-f0-9]{64}$/);
  const reversed = Object.fromEntries(Object.entries(files).reverse());
  assert.equal(
    validatePromptRefinerShadowSource({
      sourceRef,
      anchored: reversed,
      current: reversed,
    }).identityDigest,
    valid.identityDigest
  );
  assert.throws(
    () => validatePromptRefinerShadowSource({
      sourceRef,
      anchored: files,
      current: { ...files, [PROMPT_REFINER_SHADOW_SOURCE_PATHS[0]]: "drift" },
    }),
    /runtime_source_drift/
  );
  assert.throws(
    () => validatePromptRefinerShadowSource({
      sourceRef,
      anchored: { ...files, "untrusted/plugin.mjs": "code" },
      current: files,
    }),
    /source_path_allowlist/
  );
});
