// Checks the concept call's answer and, only if it passes, writes it as the
// day's concepts (the Higgsfield image path, owner 2026-11-08). The concept
// call cannot write files; what it answers reaches the image calls only
// through this check.
//   node check-concepts.mjs <answer.txt> <concepts-out.json> --feature <id> [--history job/history.json] [--day yyyymmdd]
// Exit 0 written, 1 refused (nothing is written; the reason is printed), 2 usage.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkConcepts } from "./concepts-core.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const [answerPath, outPath] = args.filter((value, index) => !value.startsWith("--") && !args[index - 1]?.startsWith("--"));
const feature = flag("--feature");
if (!answerPath || !outPath || !feature) {
  console.error("usage: node check-concepts.mjs <answer.txt> <concepts-out.json> --feature <id> [--history <history.json>] [--day yyyymmdd]");
  process.exit(2);
}
const fail = (message) => {
  console.error(JSON.stringify({ step: "check-concepts", error: message }));
  process.exit(1);
};
if (!existsSync(answerPath)) fail("no answer was saved");

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const historyPath = flag("--history") ?? path.join(toolDir, "job", "history.json");
const history = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : [];

// The concepts are the answer's one JSON line with concepts in it.
let answer = null;
for (const line of readFileSync(answerPath, "utf8").split(/\r?\n/u)) {
  try {
    const value = JSON.parse(line.trim());
    if (value && typeof value === "object" && Array.isArray(value.concepts)) {
      answer = value;
      break;
    }
  } catch {
    // not the concepts line
  }
}
if (!answer) fail("the answer holds no concepts line");

const problem = checkConcepts(answer, { feature, history, day: flag("--day"), toolDir });
if (problem) fail(problem);

mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
writeFileSync(outPath, `${JSON.stringify({ feature, concepts: answer.concepts }, null, 1)}\n`);
console.log(JSON.stringify({ ok: true, concepts: answer.concepts.map((concept) => concept.id), out: outPath }));
