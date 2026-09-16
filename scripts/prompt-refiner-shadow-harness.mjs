// Provider-free deterministic fixtures only. There is no live/provider mode.
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROMPT_REFINER_SHADOW_MAX_CORPUS_BYTES,
  parsePromptRefinerShadowCorpus,
} from "../lib/promptRefinerShadowHarness.ts";
import { runPromptRefinerShadowHarness } from "../lib/promptRefinerShadowJournal.ts";
import {
  PROMPT_REFINER_SHADOW_CORPUS_PATH,
  PROMPT_REFINER_SHADOW_SOURCE_PATHS,
  validatePromptRefinerShadowSource,
} from "../lib/promptRefinerShadowSource.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readBoundedUtf8(path, maximum) {
  if (lstatSync(path).isSymbolicLink()) throw new Error("source_symlink");
  const descriptor = openSync(path, "r");
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximum) throw new Error("source_file_size_or_type");
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset !== stat.size) throw new Error("source_changed_during_read");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } finally {
    closeSync(descriptor);
  }
}

const gitEnvironment = {
  ...process.env,
  GIT_NO_LAZY_FETCH: "1",
  GIT_TERMINAL_PROMPT: "0",
};

const git = (args) =>
  execFileSync("git", args, {
    cwd: root,
    env: gitEnvironment,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

function requireLocalGitObject(objectName) {
  try {
    git(["cat-file", "-e", objectName]);
  } catch {
    throw new Error("source_object_missing_no_lazy_fetch");
  }
}

function parseOptions() {
  const options = new Map();
  for (const argument of process.argv.slice(2)) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argument);
    if (!match || !["journal", "source-ref", "max-cases", "resume", "help"].includes(match[1])) {
      throw new Error("unknown_argument_no_live_or_plugin_mode");
    }
    if (options.has(match[1])) throw new Error("duplicate_argument");
    if (["resume", "help"].includes(match[1])) {
      if (match[2] !== undefined) throw new Error("flag_takes_no_value");
      options.set(match[1], true);
    } else {
      if (!match[2]) throw new Error("argument_value_required");
      options.set(match[1], match[2]);
    }
  }
  return options;
}

function main() {
  const options = parseOptions();
  if (options.has("help")) {
    if (options.size !== 1) throw new Error("help_must_be_alone");
    console.log(
      "Provider-free Prompt Refiner shadow verification; fixed synthetic corpus, zero provider calls and zero cost.\n" +
        "npm run shadow:prompt-refiner -- --journal=NEW_OR_EXISTING_JSONL --source-ref=FULL_40_HEX_SHA [--max-cases=N] [--resume]\n" +
        "A stopped or cleanly interrupted journal requires --resume. An unknown intent, mismatch, stale lock, truncation or witness disagreement is never repaired or retried."
    );
    return;
  }
  if (!options.has("journal") || !options.has("source-ref")) {
    throw new Error("journal_and_source_ref_required");
  }
  const sourceRef = options.get("source-ref");
  if (!/^[a-f0-9]{40}$/.test(sourceRef)) {
    throw new Error("source_ref_required_full_sha");
  }
  requireLocalGitObject(`${sourceRef}^{commit}`);
  if (git(["rev-parse", "--verify", `${sourceRef}^{commit}`]).trim() !== sourceRef) {
    throw new Error("source_ref_invalid");
  }
  for (const path of PROMPT_REFINER_SHADOW_SOURCE_PATHS) {
    requireLocalGitObject(`${sourceRef}:${path}`);
  }
  const anchored = Object.fromEntries(
    PROMPT_REFINER_SHADOW_SOURCE_PATHS.map((path) => [path, git(["show", `${sourceRef}:${path}`])])
  );
  const current = Object.fromEntries(
    PROMPT_REFINER_SHADOW_SOURCE_PATHS.map((path) => [
      path,
      readBoundedUtf8(resolve(root, path), path === PROMPT_REFINER_SHADOW_CORPUS_PATH
        ? PROMPT_REFINER_SHADOW_MAX_CORPUS_BYTES
        : 1024 * 1024),
    ])
  );
  const source = validatePromptRefinerShadowSource({ sourceRef, anchored, current });
  const corpus = parsePromptRefinerShadowCorpus(current[PROMPT_REFINER_SHADOW_CORPUS_PATH]);
  const maxCasesText = options.get("max-cases");
  if (maxCasesText !== undefined && !/^[1-9][0-9]*$/.test(maxCasesText)) {
    throw new Error("max_cases_ascii_decimal_required");
  }
  const maxCases = maxCasesText === undefined ? undefined : Number(maxCasesText);
  const report = runPromptRefinerShadowHarness({
    corpus,
    sourceIdentity: source,
    journalPath: resolve(options.get("journal")),
    resume: options.has("resume"),
    maxCases,
  });
  process.stdout.write(`${JSON.stringify({ ...report, source }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : "failed";
  console.error(
    `prompt-refiner-shadow: ${/^[a-zA-Z0-9_.:-]+$/.test(message) ? message : "input_output_or_snapshot_error"}`
  );
  process.exitCode = 1;
}
