// Apply the existing single-case preparation/check path to a stored run.
// No provider calls, automatic judgement, signatures or score artifacts.
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = args.find((value) => value.startsWith("--dir="));
const at = args.indexOf("--dir");
const directory = flag?.slice(6) ?? (at >= 0 ? args[at + 1] : undefined);
if (!directory || directory.startsWith("--")) {
  console.error(
    "--dir=<judgement bundle directory> is required. Add --check for read-only validation.",
  );
  process.exit(1);
}
try {
  const root = resolve(directory);
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!entries.length)
    throw new Error("The directory contains no case bundles.");
  let failed = 0;
  for (const entry of entries) {
    const result = spawnSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        fileURLToPath(
          new URL("./draft-ai-review-judgement.mjs", import.meta.url),
        ),
        `--dir=${join(root, entry.name)}`,
        ...(args.includes("--check") ? ["--check"] : []),
      ],
      { encoding: "utf8" },
    );
    console.log(`\n=== ${entry.name} ===\n${result.stdout ?? ""}`);
    if (result.stderr) console.error(result.stderr);
    if (result.status !== 0) {
      failed++;
      if (result.error) console.error(result.error.message);
    }
  }
  console.log(
    `${entries.length} bundle(s) processed; ${failed} command(s) failed. Existing records were not replaced. No provider was called.`,
  );
  if (!args.includes("--check"))
    console.log(
      "Prepared drafts are not completed judgements. Run again with --check after a person fills them in.",
    );
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
