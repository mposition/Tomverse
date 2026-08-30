// Whether a drawn review package may be handed to people.
//
// The generator already refuses to write a sheet that fails its own blindness
// and independence checks. This re-reads what was actually written, because
// the files on disk are what reach a reviewer, and it adds the conditions that
// belong to this particular draw: the frozen shape, and the separation of the
// two sheets from each other and from the key.
//
// Run BEFORE the key is encrypted and removed -- the population and ordering
// checks need it, and it is the only thing that maps an item back to a pair.
//
// Usage:
//   node --import tsx scripts/check-router-review-sheets.mjs \
//     --draw=<directory> --preregistration=<json> --reviewers=<id>,<id>

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AVAILABLE_MODELS } from "../lib/models.ts";
import { drawShapeProblems } from "../lib/routerHumanReviewSource.ts";

const die = (message) => {
  console.error(message);
  process.exit(1);
};
const flag = (name) => {
  const match = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : null;
};

const drawDirectory = flag("draw") ?? die("--draw=<directory> is required.");
const frozen = JSON.parse(
  readFileSync(flag("preregistration") ?? die("--preregistration=<json> is required."), "utf8")
);
const reviewerIds = (flag("reviewers") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
if (reviewerIds.length !== 2) die("--reviewers=<id>,<id> is required.");

const read = (name) => readFileSync(join(drawDirectory, name), "utf8");
const readJson = (name) => JSON.parse(read(name));

const manifest = readJson("manifest.json");
const key = readJson("key.json").key;
const sheets = reviewerIds.map((id) => readJson(`sheet-${id}.json`));

const problems = [...drawShapeProblems(frozen, manifest)];

const reserve = (manifest.cells ?? []).reduce((n, cell) => n + (cell.reserve?.length ?? 0), 0);
if (reserve !== frozen.expectedCells * 2) {
  problems.push(`the draw holds ${reserve} reserve pair(s), not ${frozen.expectedCells * 2}`);
}

// A sheet item may carry exactly these four fields. Enumerated rather than
// scanned for forbidden words, because the failure to catch is a field nobody
// thought to look for -- an arm, a model id, a digest, a score.
const ALLOWED_ITEM_FIELDS = ["itemId", "question", "answerA", "answerB"];
for (const sheet of sheets) {
  for (const item of sheet.items ?? []) {
    const extra = Object.keys(item).filter((field) => !ALLOWED_ITEM_FIELDS.includes(field));
    if (extra.length > 0) {
      problems.push(`sheet-${sheet.reviewerId} item ${item.itemId} carries ${extra.join(", ")}`);
    }
  }
}

// Population and ordering, resolved through the key because the sheets
// deliberately do not carry a pair id.
const byItem = new Map(key.map((row) => [`${row.reviewerId}|${row.itemId}`, row]));
const resolved = sheets.map((sheet) =>
  (sheet.items ?? []).map((item) => byItem.get(`${sheet.reviewerId}|${item.itemId}`))
);
if (resolved.some((rows) => rows.some((row) => !row))) {
  problems.push("an item on a sheet has no entry in the key, so the draw cannot be resolved");
} else {
  const pairsOf = (rows) => rows.map((row) => row.pairId);
  const [a, b] = resolved;
  if ([...pairsOf(a)].sort().join(",") !== [...pairsOf(b)].sort().join(",")) {
    problems.push("the two sheets do not cover the same pairs");
  }
  if (pairsOf(a).join(",") === pairsOf(b).join(",")) {
    problems.push("both sheets present the pairs in the same order");
  }
  const itemIds = sheets.map((sheet) => (sheet.items ?? []).map((item) => item.itemId));
  const shared = itemIds[0].filter((id) => itemIds[1].includes(id));
  if (shared.length > 0) problems.push(`the two sheets share ${shared.length} item id(s)`);
  for (const [index, rows] of resolved.entries()) {
    if (rows.length !== frozen.expectedPrimaryPairs) {
      problems.push(
        `sheet-${reviewerIds[index]} holds ${rows.length} item(s), not ${frozen.expectedPrimaryPairs}`
      );
    }
  }
}

// What a reviewer actually reads. The question and both answers are the thing
// being graded and are shown verbatim -- a model named inside an answer is the
// answer's own doing and scrubbing it would change what is graded. So they are
// removed by exact text, and only what remains is scanned.
const identifiers = [
  ...new Set(
    AVAILABLE_MODELS.flatMap((model) => [model.id, model.apiModel, model.provider]).filter(Boolean)
  ),
];
for (const sheet of sheets) {
  let scaffold = read(`sheet-${sheet.reviewerId}.md`);
  for (const item of sheet.items ?? []) {
    for (const shown of [item.question, item.answerA, item.answerB]) {
      if (typeof shown === "string" && shown.length > 0) scaffold = scaffold.split(shown).join(" ");
    }
  }
  for (const identifier of identifiers) {
    if (scaffold.toLowerCase().includes(identifier.toLowerCase())) {
      problems.push(`sheet-${sheet.reviewerId}.md names "${identifier}" outside the graded text`);
    }
  }
  // The arm labels, as labels. Checked on the structure rather than the prose,
  // because "baseline traffic" is a phrase a question may legitimately use.
  for (const field of ["aArm", "bArm", "arm", "pairId", "verdict", "score"]) {
    if (JSON.stringify(sheet).includes(`"${field}"`)) {
      problems.push(`sheet-${sheet.reviewerId}.json carries a "${field}" field`);
    }
  }
}

console.log(`Review package — ${drawDirectory}`);
console.log(`  cells      ${(manifest.cells ?? []).length} of ${frozen.expectedCells} frozen`);
console.log(
  `  primary    ${(manifest.cells ?? []).reduce((n, c) => n + (c.primary?.length ?? 0), 0)}` +
    ` of ${frozen.expectedPrimaryPairs} frozen, reserve ${reserve}`
);
console.log(`  sheets     ${reviewerIds.join(", ")}`);

if (problems.length > 0) {
  console.error("\nThis package may not be handed out:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nNothing was uploaded.");
  process.exit(1);
}

console.log("\nOK — the frozen shape, two blind sheets over one population in different orders,");
console.log("no shared item ids, and no model identity outside the text being graded.");
