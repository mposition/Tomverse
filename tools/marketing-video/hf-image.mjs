// Makes one Higgsfield picture behind the daily credit cap (hf-image-core.mjs):
//   node hf-image.mjs --prompt-file <file> --out <file.png> [--ref <picture>]... [--label <text>] [--job-dir job]
// Exit 0 made, 3 refused before anything was sent (cap, request, price), 1 anything else.
import { readFileSync } from "node:fs";

import { makeImage } from "./hf-image-core.mjs";

const args = process.argv.slice(2);
const values = (name) => args.flatMap((value, index) => (args[index - 1] === name ? [value] : []));
const [promptFile] = values("--prompt-file");
const [out] = values("--out");
if (!promptFile || !out) {
  console.error("usage: node hf-image.mjs --prompt-file <file> --out <file.png> [--ref <picture>]... [--label <text>] [--job-dir job]");
  process.exit(1);
}
const result = await makeImage({
  prompt: readFileSync(promptFile, "utf8"),
  references: values("--ref"),
  out,
  label: values("--label")[0],
  jobDir: values("--job-dir")[0] ?? "job",
});
console.log(JSON.stringify({ step: "hf-image", ...result }));
const BEFORE_SENDING = new Set(["no_daily_cap", "daily_cap_reached", "unknown_outcome_pending", "cost_unreadable", "cost_above_call_ceiling", "model_not_allowed", "aspect_ratio_not_allowed", "count_not_one", "use_unlim_not_allowed"]);
process.exit(result.ok ? 0 : BEFORE_SENDING.has(result.reason) ? 3 : 1);
