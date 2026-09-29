import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { scanLocalIntakeInput } from "../lib/amux/localIntakeCore.ts";
import { buildCodexIntakeArgs } from "../lib/amux/localIntakeCodex.ts";
import { buildLocalIntakePrompt } from "../lib/amux/localIntakeTool.ts";

/**
 * Prepare one local AMUX intake command.
 *
 * npm run local:amux-intake -- --input <file> --snapshot <file>
 *
 * This script does not spawn Codex. A live model call stays refused until a
 * separate DPA and region approval. --execute prints live_call_refused.
 */

const flag = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const main = () => {
  if (process.argv.includes("--execute")) {
    console.error("live_call_refused");
    process.exit(2);
  }
  const inputPath = flag("--input");
  const snapshotPath = flag("--snapshot");
  if (!inputPath || !snapshotPath) {
    console.error("schema_rejected");
    process.exit(1);
  }
  const text = readFileSync(inputPath, "utf8");
  const scanned = scanLocalIntakeInput(text);
  if (!scanned.ok) {
    console.error(scanned.code);
    process.exit(1);
  }
  const snapshotJson = readFileSync(snapshotPath, "utf8");
  const model = flag("--model");
  const reasoningEffort = flag("--effort");
  if (!model || !reasoningEffort) {
    console.error("frontier_model_unavailable");
    process.exit(1);
  }
  const schemaPath =
    flag("--schema") ??
    fileURLToPath(new URL("../lib/amux/local-intake-package.schema.json", import.meta.url));
  const outputPath = flag("--output") ?? resolve(tmpdir(), "amux-local-intake-last.json");
  let args;
  try {
    args = buildCodexIntakeArgs({
      model,
      reasoningEffort,
      schemaPath,
      outputPath,
      cwd: flag("--cwd") ?? process.cwd(),
      timeoutMs: 120_000,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "frontier_model_unavailable");
    process.exit(1);
  }
  buildLocalIntakePrompt({ operatorText: text, snapshotJson });
  console.log(
    JSON.stringify({
      spawned: false,
      calls: 0,
      sandbox: "read-only",
      shell: false,
      model,
      reasoningEffort,
      argCount: args.length,
    }),
  );
};

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) main();
