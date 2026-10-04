// Every human review draw committed to this repository holds the shape it was
// agreed to hold, and the primary and diagnostic draws stay apart.
//
// This runs in CI, unlike the commands that produce these files. The failure
// it exists to catch is a manifest edited after the fact -- a cell quietly
// short of four, a reserve that is also a primary, a diagnostic pair that has
// wandered into the sixty, a substitution recorded against a verdict. Every
// one of those produces a file that still looks like a draw.
//
// It checks what is committed. When nothing is, it says so and passes: the
// human review has not happened yet, and this check is not the place that
// decides it must.
//
// The procedure is docs/ops/tomverse-chat-router-evaluation-set.md.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  ADJUDICATE_ON_DISAGREEMENT,
  DIAGNOSTIC_DISAGREEMENTS_PER_CELL,
  HUMAN_PRIMARY_PER_CELL,
  HUMAN_RESERVE_PER_CELL,
  HUMAN_REVIEWERS_PER_PAIR,
  STRUCTURAL_SUBSTITUTION_REASONS,
  manifestProblems,
} from "../lib/routerHumanReviewSample.ts";
import { diagnosticProblems, primaryFootprint } from "../lib/routerHumanReviewDiagnostic.ts";

const ROOT = "docs/ops/router-human-review";

const problems = [];
const note = (where, message) => problems.push(`${where}: ${message}`);

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    note(path, `is not readable JSON (${String(error)})`);
    return null;
  }
};

const directories = existsSync(ROOT)
  ? readdirSync(ROOT)
      .map((name) => join(ROOT, name))
      .filter((path) => statSync(path).isDirectory())
  : [];

const primaries = new Map();
const diagnostics = new Map();

for (const directory of directories) {
  const primaryPath = join(directory, "manifest.json");
  const diagnosticPath = join(directory, "diagnostic-draw.json");
  if (existsSync(primaryPath)) {
    const manifest = readJson(primaryPath);
    if (manifest) primaries.set(primaryPath, manifest);
  }
  if (existsSync(diagnosticPath)) {
    const draw = readJson(diagnosticPath);
    if (draw) diagnostics.set(diagnosticPath, draw);
  }
  if (existsSync(primaryPath) && existsSync(diagnosticPath)) {
    note(directory, "holds both a primary manifest and a diagnostic draw. One directory, one draw.");
  }
}

for (const [path, manifest] of primaries) {
  // manifestProblems already enforces the per-cell counts, the reviewer count,
  // adjudication, disjointness and the seed. Repeating them here would be two
  // statements of one rule that could drift apart.
  for (const problem of manifestProblems(manifest)) note(path, problem);

  const cells = manifest.cells ?? [];
  const primaryTotal = cells.reduce((sum, cell) => sum + (cell.primary?.length ?? 0), 0);
  const reserveTotal = cells.reduce((sum, cell) => sum + (cell.reserve?.length ?? 0), 0);
  if (cells.length > 0) {
    if (primaryTotal !== cells.length * HUMAN_PRIMARY_PER_CELL) {
      note(path, `holds ${primaryTotal} primary pair(s) across ${cells.length} cells`);
    }
    if (reserveTotal !== cells.length * HUMAN_RESERVE_PER_CELL) {
      note(path, `holds ${reserveTotal} reserve pair(s) across ${cells.length} cells`);
    }
  }

  for (const substitution of manifest.substitutions ?? []) {
    if (!STRUCTURAL_SUBSTITUTION_REASONS.includes(substitution.reason)) {
      note(
        path,
        `replaces ${substitution.pairId} for "${substitution.reason}". A reserve is spent when a pair ` +
          `cannot be reviewed, never for how it was judged: ${STRUCTURAL_SUBSTITUTION_REASONS.join(", ")}`
      );
    }
    for (const field of ["pairId", "replacedBy", "detail", "at", "by"]) {
      if (typeof substitution[field] !== "string" || substitution[field] === "") {
        note(path, `a substitution has no ${field}`);
      }
    }
  }
}

for (const [path, draw] of diagnostics) {
  const named = [...primaries.entries()].find(
    ([, manifest]) => manifest.populationDigest === draw.primaryPopulationDigest
  );
  if (!named) {
    note(path, "names a primary sample that is not committed, so its overlap cannot be checked");
    continue;
  }
  for (const problem of diagnosticProblems(draw, named[1])) note(path, problem);

  const spokenFor = primaryFootprint(named[1]);
  for (const cell of draw.cells ?? []) {
    if ((cell.pairIds?.length ?? 0) > DIAGNOSTIC_DISAGREEMENTS_PER_CELL) {
      note(path, `${cell.cell} draws ${cell.pairIds.length}, over the ${DIAGNOSTIC_DISAGREEMENTS_PER_CELL} agreed`);
    }
    for (const pairId of cell.pairIds ?? []) {
      if (spokenFor.has(pairId)) note(path, `${pairId} is in ${named[0]} as well as this supplement`);
    }
  }
}

if (problems.length > 0) {
  console.error("Human review draw check failed.\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    `\nThe contract is ${HUMAN_PRIMARY_PER_CELL} primary and ${HUMAN_RESERVE_PER_CELL} reserve per cell, ` +
      `${HUMAN_REVIEWERS_PER_PAIR} reviewers per pair, adjudication ${ADJUDICATE_ON_DISAGREEMENT ? "on" : "off"} ` +
      `disagreement, at most ${DIAGNOSTIC_DISAGREEMENTS_PER_CELL} diagnostic pair(s) per cell, and no pair in\n` +
      "both draws. Redraw with the commands rather than editing a manifest."
  );
  process.exit(1);
}

if (primaries.size === 0 && diagnostics.size === 0) {
  console.log(
    `No human review draw is committed under ${ROOT}/, so there is nothing to check. ` +
      "This check does not decide whether one is owed."
  );
} else {
  console.log(
    `Human review draw check passed: ${primaries.size} primary manifest(s) and ` +
      `${diagnostics.size} diagnostic draw(s) hold the agreed shape, and no pair is in both.`
  );
}
