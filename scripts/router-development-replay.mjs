// Offline only: fixed local source imports; no provider, credentials, journal or live mode.
import { closeSync, fstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AVAILABLE_MODELS } from "../lib/models.ts";
import { benchmarkDigest, DEVELOPMENT_LIMITS, parseBenchmarkJson, parseDevelopmentCorpus } from "../lib/routerDevelopmentBenchmark.ts";
import { replayDevelopment } from "../lib/routerDevelopmentReplay.ts";
import { REPLAY_COLLECTOR_SOURCE_PATHS, REPLAY_CORPUS_PATH, REPLAY_IMPLEMENTATION_PATHS, validateReplaySourceFiles } from "../lib/routerDevelopmentReplaySource.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function readBoundedText(path, maximum = DEVELOPMENT_LIMITS.documentBytes) {
  const descriptor = openSync(resolve(path), "r");
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximum) throw new Error("replay_input_file_size_or_type");
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(descriptor, buffer, size, buffer.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > maximum) throw new Error("replay_input_byte_limit");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
  } finally { closeSync(descriptor); }
}
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: DEVELOPMENT_LIMITS.documentBytes, stdio: ["ignore", "pipe", "pipe"] });

function main() {
  const options = new Map();
  const required = ["manifest", "answers", "candidate", "observation-source-ref"];
  for (const argument of process.argv.slice(2)) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argument);
    if (!match || ![...required, "output", "help"].includes(match[1])) throw new Error("replay_unknown_argument_no_live_mode");
    if (options.has(match[1])) throw new Error("replay_duplicate_argument");
    if (match[1] === "help" ? match[2] !== undefined : !match[2]) throw new Error("replay_argument_value");
    options.set(match[1], match[2] ?? true);
  }
  if (options.has("help")) {
    if (options.size !== 1) throw new Error("replay_help_alone");
    console.log("Offline DEVELOPMENT selection replay; no provider calls or credentials.\n" +
      "npm run benchmark:router:replay -- --manifest=PATH --answers=PATH --candidate=PATH --observation-source-ref=FULL_40_HEX_SHA [--output=NEW_PATH]\n" +
      "The source ref is a separately chosen trusted original commit. Imported manifests cannot choose source paths.\n" +
      "Output defaults to stdout; existing files are refused. Benchmark selection comparison and product compatibility are separate; incomplete whole-population deltas remain null.");
    return;
  }
  if (required.some((key) => !options.has(key))) throw new Error("replay_required_arguments");
  const ref = options.get("observation-source-ref");
  if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error("replay_observation_source_ref_required_full_sha");
  if (Object.keys(process.env).some((key) => /^CHAT_MODEL_.*_(INPUT_USD_PER_MILLION|OUTPUT_USD_PER_MILLION|CACHED_INPUT_PRICE_MULTIPLIER|MAX_OUTPUT_TOKENS|RESERVATION_OUTPUT_TOKENS)$/i.test(key))) throw new Error("replay_pricing_environment_overrides");
  if (git(["rev-parse", "--verify", `${ref}^{commit}`]).trim() !== ref) throw new Error("replay_observation_source_ref_invalid");
  const fixedPaths = [...REPLAY_COLLECTOR_SOURCE_PATHS, REPLAY_CORPUS_PATH];
  const anchored = Object.fromEntries(fixedPaths.map((path) => [path, git(["show", `${ref}:${path}`])]));
  const current = Object.fromEntries(fixedPaths.map((path) => [path, readBoundedText(resolve(root, path))]));
  const observationSource = validateReplaySourceFiles({ observationSourceRef: ref, anchored, current });
  const replayPaths = [...fixedPaths, ...REPLAY_IMPLEMENTATION_PATHS].sort();
  const replaySource = {
    commit: git(["rev-parse", "HEAD"]).trim(),
    dirty: git(["status", "--porcelain", "--", ...replayPaths]).trim().length > 0,
    files: Object.fromEntries(replayPaths.map((path) => [path, benchmarkDigest(current[path] ?? readBoundedText(resolve(root, path)))])),
  };
  const manifestText = readBoundedText(options.get("manifest"));
  const answersText = readBoundedText(options.get("answers"));
  const candidateText = readBoundedText(options.get("candidate"), DEVELOPMENT_LIMITS.corpusBytes);
  const report = replayDevelopment({
    corpus: parseDevelopmentCorpus(current[REPLAY_CORPUS_PATH]), corpusText: current[REPLAY_CORPUS_PATH], models: AVAILABLE_MODELS,
    manifest: parseBenchmarkJson(manifestText), answers: parseBenchmarkJson(answersText), candidate: parseBenchmarkJson(candidateText),
    observationSource, replaySource,
  });
  const output = { ...report, inputFileDigests: { manifest: benchmarkDigest(manifestText), answers: benchmarkDigest(answersText), candidate: benchmarkDigest(candidateText) } };
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (options.has("output")) {
    const destination = resolve(options.get("output"));
    writeFileSync(destination, serialized, { flag: "wx", encoding: "utf8" });
    console.log(JSON.stringify({ output: destination, paired: report.benchmarkDomain.paired }));
  } else process.stdout.write(serialized);
}

try { main(); }
catch (error) {
  const message = error instanceof Error ? error.message : "replay_failed";
  console.error(`router-development-replay: ${/^[a-zA-Z0-9_.:-]+$/.test(message) ? message : "replay_input_output_or_snapshot_error"}`);
  process.exitCode = 1;
}
