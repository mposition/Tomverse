// Write the review sheet for one batch of Router evaluation candidates.
//
//   npm run make:router-eval-review-sheet -- --batch=router-eval-gen-ko-001
//   npm run make:router-eval-review-sheet -- --all
//
// The sheet is what a person judges from, and its one requirement is that it
// is the only file they need to open. Everything else here follows from that:
// the prompts are inlined in full, the machine checks are run and their
// results printed, and the near-duplicate ranking is computed over the whole
// corpus rather than the batch.
//
// ## It carries no verdict
//
// §8 and §11 of docs/ops/tomverse-chat-router-evaluation-set.md reserve
// adoption for a person. This script never sets `status: adopted`, never fills
// `adoptedBy` or `adoptedAt`, and writes the verdict rows empty. If a sheet
// comes back with verdicts in it, a person put them there.
//
// Regenerating overwrites. Judgements live in the set file once a person
// records them, not in the generated Markdown.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { renderReviewSheet, batchItems } from "../lib/routerEvalReviewSheet.ts";

const SET_PATH = "docs/ops/router-evaluation-set/development-v0.json";
const SHEET_DIRECTORY = "docs/ops/router-evaluation-set/batches";

const args = process.argv.slice(2);
const argValue = (name) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const setPath = argValue("set") ?? SET_PATH;
const batch = argValue("batch");
const all = args.includes("--all");

if (!batch && !all) {
  console.error(
    "--batch=<batchId> or --all is required.\n\n" +
      "A batch is a draftProvenance.batchId shared by the items drafted together."
  );
  process.exit(1);
}

let set;
try {
  set = JSON.parse(readFileSync(setPath, "utf8"));
} catch (error) {
  console.error(`Could not read ${setPath}: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const corpus = set.items ?? [];
const batchIds = all
  ? [...new Set(corpus.map((item) => item.draftProvenance?.batchId).filter(Boolean))]
  : [batch];

if (batchIds.length === 0) {
  console.error("No item in the set carries a draftProvenance.batchId.");
  process.exit(1);
}

mkdirSync(SHEET_DIRECTORY, { recursive: true });

let written = 0;
for (const batchId of batchIds) {
  const items = batchItems(set, batchId);
  if (items.length === 0) {
    console.error(`  skipped ${batchId}: no items carry that batchId`);
    continue;
  }
  // The cell is in the filename because a reviewer picks a sheet by what it
  // asks of them, and "the Korean coding batch" is how they will think of it.
  const cells = [...new Set(items.map((item) => `${item.stratum}/${item.cell}`))];
  const slug = cells.length === 1 ? cells[0].replace(/[/_]/g, "-") : "mixed";
  const file = path.join(SHEET_DIRECTORY, `${batchId}-${slug}.md`);
  writeFileSync(file, `${renderReviewSheet({ set, batchId, corpus })}\n`, "utf8");
  console.log(`  ${file}  (${items.length} candidate(s))`);
  written += 1;
}

console.log(
  `\n${written} sheet(s) written. Nothing was adopted: every item stays status: candidate\n` +
    "until a person records an adopter and a date, which the evaluation-set procedure\n" +
    "reserves for them: docs/ops/tomverse-chat-router-evaluation-set.md."
);
