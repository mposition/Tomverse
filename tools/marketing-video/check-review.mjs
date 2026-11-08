// Checks a review call's answer (the Higgsfield image path, owner 2026-11-08)
// and writes it only if it has the agreed shape:
//   node check-review.mjs <answer.txt> <review-out.json> --stage guide|content --concept <concepts.json> --id <concept id> --locale <locale>
// The review is a separate model call with Read on its own folder and nothing
// else; this check is what turns its answer into boxes and verdicts the
// scripts act on. In the content stage the words the reviewer read are
// compared here, character for character, with the approved words: the
// verdict is "pass" only when they match, whatever the reviewer said.
// Exit 0 written, 1 refused (nothing written), 2 usage.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { checkReview } from "./review-core.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const [answerPath, outPath] = args.filter((value, index) => !value.startsWith("--") && !args[index - 1]?.startsWith("--"));
const stage = flag("--stage");
const conceptsPath = flag("--concept");
const id = flag("--id");
const locale = flag("--locale");
if (!answerPath || !outPath || !["guide", "content"].includes(stage) || !conceptsPath || !id || !locale) {
  console.error("usage: node check-review.mjs <answer.txt> <review-out.json> --stage guide|content --concept <concepts.json> --id <id> --locale <locale>");
  process.exit(2);
}
const fail = (message) => {
  console.error(JSON.stringify({ step: "check-review", error: message }));
  process.exit(1);
};
if (!existsSync(answerPath)) fail("no answer was saved");
const concept = JSON.parse(readFileSync(conceptsPath, "utf8")).concepts?.find((entry) => entry.id === id);
if (!concept) fail(`no concept ${id}`);

const result = checkReview(readFileSync(answerPath, "utf8"), { stage, concept, locale });
if (result.problem) fail(result.problem);
mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(result.review, null, 1)}\n`);
console.log(JSON.stringify({ ok: true, id, stage, locale, verdict: result.review.verdict }));
