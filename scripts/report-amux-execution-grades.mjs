import { readFileSync, statSync } from "node:fs";

import { deriveAmuxExecutionGrade } from "../lib/amux/executionGradeCore.ts";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--input") {
  throw new Error("Usage: npm run report:amux-execution-grades -- --input <task-proposals.json>");
}

let source;
try {
  const file = statSync(args[1]);
  if (!file.isFile() || file.size > 8 * 1024 * 1024) {
    throw new Error("invalid input file");
  }
  source = readFileSync(args[1], "utf8");
  if (Buffer.byteLength(source, "utf8") > 8 * 1024 * 1024) {
    throw new Error("input file changed while reading");
  }
} catch {
  throw new Error("Execution grade report input must be a readable file no larger than 8 MiB");
}
let proposals;
try {
  proposals = JSON.parse(source);
} catch {
  throw new Error("Execution grade report input is not valid JSON");
}
if (!Array.isArray(proposals) || proposals.length > 10_000) {
  throw new Error("Execution grade report expects an array of at most 10,000 Task proposals");
}

const grades = ["routine", "advanced", "frontier"];
const proposed = { routine: 0, advanced: 0, frontier: 0, unknown: 0 };
const derived = { routine: 0, advanced: 0, frontier: 0 };
const transitions = {};

for (const [index, task] of proposals.entries()) {
  if (task === null || typeof task !== "object" || Array.isArray(task)) {
    throw new Error(`Task proposal ${index} must be an object`);
  }
  const signal = grades.includes(task.proposedGrade) ? task.proposedGrade : "unknown";
  const grade = deriveAmuxExecutionGrade({
    taskRole: task.taskRole,
    expectedPaths: task.expectedPaths,
    proposedGrade: task.proposedGrade,
  });
  proposed[signal] += 1;
  derived[grade] += 1;
  const transition = `${signal}->${grade}`;
  transitions[transition] = (transitions[transition] ?? 0) + 1;
}

// Aggregate counts only: paths, titles and identifiers never enter stdout.
console.log(JSON.stringify({ total: proposals.length, proposed, derived, transitions }, null, 2));
