// Diagnosing a conflicted back-merge (scripts/back-merge-ancestry-core.mjs).
//
// Automating the resolution was authorised on 2026-10-03, attempted twice, and
// withdrawn: two rounds of independent review each produced a counterexample,
// and the second cannot be fixed by refining a line comparison. Both are pinned
// below, because the next person to have this idea should meet the evidence
// before writing the code rather than after.
//
// The module therefore reports and never admits. The first test here is the one
// that matters most: it asserts the module exposes no admission at all.

import assert from "node:assert/strict";
import test from "node:test";

import * as core from "../scripts/back-merge-ancestry-core.mjs";
import {
  classifyUnavailable,
  describeDivergence,
  divergenceReport,
  pathDivergence,
} from "../scripts/back-merge-ancestry-core.mjs";

/* ------------------------------------------------- the module grants nothing */

test("the module exposes no admission, by design", () => {
  // A caller that found one would be asking for permission to push, which is
  // what the two counterexamples below refused.
  for (const name of Object.keys(core)) {
    assert.doesNotMatch(
      name,
      /admit|approve|allow|safe|decide/i,
      `${name} reads like permission; this module reports`
    );
  }
  const report = divergenceReport({
    conflicts: [{ path: "a.json", base: "a\n", ours: "a\nb\n", theirs: "a\n" }],
    treeWouldEqualDevelop: true,
  });
  assert.equal("admitted" in report, false);
  assert.match(describeDivergence(report), /not a go-ahead/);
  assert.match(describeDivergence(report), /WITH A MERGE COMMIT/);
});

/* ----------------------------------------- the two counterexamples, recorded */

test("counterexample 1: a blank line main inserted is still a line", () => {
  // Round 0, against a line-SET criterion that filtered whitespace. main
  // inserts a blank line between A and B; develop inserts C there. The set test
  // saw main as adding nothing and the tree still equalled develop's, so both
  // guards passed while main's edit was dropped.
  const entry = pathDivergence({
    path: "lib/copy.ts",
    base: "const A = 1;\nconst B = 2;\n",
    theirs: "const A = 1;\n\nconst B = 2;\n",
    ours: "const A = 1;\nconst C = 3;\nconst B = 2;\n",
  });
  assert.equal(entry.mainLinesPresent, false);
  assert.match(entry.note, /visibly drop/);
});

test("counterexample 2: develop may contain every line main added and still neutralise it", () => {
  // Round 1, and the end of the idea. main inserts a throw; develop inserts the
  // same lines wrapped in a block comment. main's lines ARE a subsequence of
  // develop's, nothing is deleted, and the tree is develop's -- so every
  // line-based test passes while main's exception never executes.
  const entry = pathDivergence({
    path: "lib/guard.ts",
    base: "function guard(x) {\n  return x;\n}\n",
    theirs: 'function guard(x) {\n  throw new Error("refused");\n  return x;\n}\n',
    ours: 'function guard(x) {\n  /*\n  throw new Error("refused");\n  */\n  return x;\n}\n',
  });

  // The observations the module can make are all reassuring, and all beside the
  // point: this is why there is no admission to pass.
  assert.equal(entry.mainLinesPresent, true);
  assert.equal(entry.resurrects, null);
  assert.match(entry.note, /not proof that main's change still takes effect/);

  const report = divergenceReport({ conflicts: [entry], treeWouldEqualDevelop: true });
  assert.equal(report.contentNeutral, true);
  assert.equal("admitted" in report, false);
});

/* ----------------------------------------------------- the observations hold */

test("a line only main has is reported as a visible drop", () => {
  // The hotfix shape: main carries a fix develop never received.
  const entry = pathDivergence({
    path: "lib/stripe.ts",
    base: "const timeout = 5000;\n",
    theirs: "const timeout = 30000;\n",
    ours: "const timeout = 5000;\nconst retries = 2;\n",
  });
  assert.equal(entry.mainLinesPresent, false);
});

test("a line main removed and develop still has is reported as a resurrection", () => {
  const entry = pathDivergence({
    path: "lib/flags.ts",
    base: "export const legacy = true;\nexport const next = false;\n",
    theirs: "export const next = false;\n",
    ours: "export const legacy = true;\nexport const next = false;\n",
  });
  assert.equal(entry.resurrects, "export const legacy = true;");
  assert.match(entry.note, /resurrect/);
});

test("a duplicate main deleted is counted, not collapsed", () => {
  const entry = pathDivergence({
    path: "lib/dup.ts",
    base: "x\nx\ny\n",
    theirs: "x\ny\n",
    ours: "x\nx\ny\n",
  });
  assert.equal(entry.resurrects, "x");
});

test("order is part of the change", () => {
  const entry = pathDivergence({ path: "lib/order.ts", base: "a\nb\n", theirs: "b\na\n", ours: "a\nb\nc\n" });
  assert.equal(entry.mainLinesPresent, false);
});

test("absent, binary and unreadable are three different answers", () => {
  // Review round 2: all three were collapsed into "develop does not have this
  // path; keeping develop would delete it", so a binary file present on both
  // sides read as a deletion conflict, and a failed read read as one too.
  const absent = pathDivergence({
    path: "a",
    base: "x\n",
    theirs: "x\n",
    ours: { unavailable: "absent" },
  });
  assert.match(absent.note, /develop does not have this path; keeping develop would delete it/);

  const binary = pathDivergence({
    path: "a.png",
    base: "x\n",
    theirs: "x\n",
    ours: { unavailable: "binary" },
  });
  assert.match(binary.note, /not text/);
  assert.doesNotMatch(binary.note, /delete/, "a binary file both sides have is not a deletion");

  const unreadable = pathDivergence({
    path: "a",
    base: "x\n",
    theirs: { unavailable: "unreadable" },
    ours: "x\n",
  });
  assert.match(unreadable.note, /could not be read, so nothing is claimed/);
  assert.doesNotMatch(unreadable.note, /resurrect/);

  for (const entry of [absent, binary, unreadable]) assert.equal(entry.undetermined, true);

  // An absent main is still reported as the resurrection risk it is.
  assert.match(
    pathDivergence({ path: "a", base: "x\n", theirs: { unavailable: "absent" }, ours: "x\n" }).note,
    /resurrect/
  );
  assert.match(
    pathDivergence({ path: "a", base: { unavailable: "absent" }, theirs: "x\n", ours: "x\n" }).note,
    /merge base/
  );
  assert.match(pathDivergence({ path: "", base: "x\n", theirs: "x\n", ours: "x\n" }).note, /no path/);
});

test("the tree comparison has three states, and unknown is not false", () => {
  // Review round 2: a failed git command was printed as "would still change
  // files", which is a claim nobody had checked.
  assert.equal(divergenceReport({ conflicts: [], treeWouldEqualDevelop: true }).contentNeutral, true);
  assert.match(describeDivergence(divergenceReport({ conflicts: [], treeWouldEqualDevelop: true })), /would change no file/);

  assert.equal(divergenceReport({ conflicts: [], treeWouldEqualDevelop: false }).contentNeutral, false);
  assert.match(describeDivergence(divergenceReport({ conflicts: [], treeWouldEqualDevelop: false })), /would still change files/);

  for (const unknown of [undefined, null, "true", 1]) {
    const report = divergenceReport({ conflicts: [], treeWouldEqualDevelop: unknown });
    assert.equal(report.contentNeutral, null, String(unknown));
    assert.match(describeDivergence(report), /could not be made here/);
  }
});

test("absence is claimed only when the tree lookup succeeded and found nothing", () => {
  // Review round 3: every failure of the read was classified as absent, so a
  // missing or corrupt object, a bad ref or an unreadable repository printed
  // "keeping develop would delete it" -- a deletion risk asserted as fact. The
  // round also noted the tests injected `unavailable` directly and so could not
  // catch the misclassification; this covers the classifier itself.
  assert.equal(classifyUnavailable({ listed: false, listFailed: false }), "absent");
  assert.equal(classifyUnavailable({ listed: true, listFailed: false }), "unreadable");
  assert.equal(classifyUnavailable({ listed: false, listFailed: true }), "unreadable");
  assert.equal(classifyUnavailable({ listed: true, listFailed: true }), "unreadable");
  // Anything it cannot read as a definite "the lookup worked" is not absence.
  for (const listed of [undefined, null, "false", 0]) {
    assert.equal(classifyUnavailable({ listed, listFailed: true }), "unreadable", String(listed));
  }
});
