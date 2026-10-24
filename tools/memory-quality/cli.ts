import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { createReplayAdapter, createScriptedAdapters, loadFixtures } from "./mock";
import {
  loadRetrievalCases, measureProductRetrieval, PRODUCT_RETRIEVAL_CORPORA, type ProductRetrievalCorpus,
} from "./productRetrieval";
import { runQualityLoop, QualityStop } from "./runner";
import { createRunStore, listRuns, readEvents, requestStop, runPath } from "./store";

const HELP = `Memory quality agent (local synthetic data only)
node --import tsx tools/memory-quality/cli.ts <command> [options]
run     --mode mock|replay --out <directory> [--responses <json>] [--iterations <n>]
        [--max-calls <n>] [--timeout-ms <n>]
list    --out <directory>
show    --out <directory> --run <id>
stop    --out <directory> --run <id>
export-replay --out <directory> --run <id> --file <new-json-file>
retrieval [--corpus retrieval-ko|development|validation|all]
        Product retrieval (selectMemoryContext) Recall@5; no model call, no output files.
Defaults: mode=mock, out=.tmp/memory-quality, iterations=3, max-calls=1000, timeout-ms=60000,
corpus=retrieval-ko.
No live mode, paid execution, product writes, promotion, network or raw Memory collection.`;
const commandOptions: Record<string, string[]> = {
  run: ["mode", "out", "responses", "iterations", "max-calls", "timeout-ms"],
  list: ["out"], show: ["out", "run"], stop: ["out", "run"],
  "export-replay": ["out", "run", "file"],
  retrieval: ["corpus"],
};
function parse(args: string[]) {
  const command = args[0] ?? "help", options: Record<string, string> = {};
  if (command === "help" || command === "--help") return { command: "help", options };
  if (!commandOptions[command]) throw new QualityStop("unknown_command");
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag.startsWith("--") || !commandOptions[command].includes(flag.slice(2)) ||
      !value || value.startsWith("--") || options[flag.slice(2)] !== undefined) {
      throw new QualityStop("unknown_or_invalid_option");
    }
    options[flag.slice(2)] = value;
  }
  return { command, options };
}
export async function main(args: string[]) {
  const { command, options } = parse(args);
  if (command === "help") return { help: HELP };
  if (command === "retrieval") {
    const corpus = options.corpus ?? "retrieval-ko";
    const names = corpus === "all" ? PRODUCT_RETRIEVAL_CORPORA
      : PRODUCT_RETRIEVAL_CORPORA.filter((name) => name === corpus);
    if (names.length === 0) throw new QualityStop("unknown_corpus");
    const results: Record<string, ReturnType<typeof measureProductRetrieval>> = {};
    for (const name of names) results[name] = measureProductRetrieval(await loadRetrievalCases(name as ProductRetrievalCorpus));
    return { retrieval: results };
  }
  const output = resolve(options.out ?? ".tmp/memory-quality");
  if (command === "list") return { runs: await listRuns(output) };
  if (command !== "run") {
    if (!options.run) throw new QualityStop("run_id_required");
    if (command === "stop") return requestStop(output, options.run);
    const events = await readEvents(runPath(output, options.run));
    if (command === "export-replay") {
      if (!options.file) throw new QualityStop("file_required");
      const entries = new Map(events.filter((event) => event.type === "model_output")
        .map((event) => [event.requestDigest, { requestDigest: event.requestDigest, output: event.output }]));
      await writeFile(resolve(options.file), JSON.stringify([...entries.values()], null, 2) + "\n", { flag: "wx" });
      return { entries: entries.size, file: resolve(options.file) };
    }
    return {
      id: options.run,
      result: events.findLast((event) => event.type === "finished") ?? { state: "unfinished" },
      candidates: events.filter((event) => ["candidate", "candidate_rejected", "candidate_frozen"].includes(event.type)),
      evaluations: events.filter((event) => ["baseline", "development_evaluation", "validation_evaluation",
        "invalid_evaluation"].includes(event.type)).map((event) => ({
        type: event.type, candidateId: event.candidateId, comparison: event.comparison,
        summary: (event.evaluation as { summary?: unknown })?.summary,
        baseline: (event.baseline as { summary?: unknown })?.summary,
      })),
    };
  }
  const mode = options.mode ?? "mock";
  if (mode !== "mock" && mode !== "replay") {
    throw new QualityStop(mode === "live" ? "paid_execution_disabled" : "unknown_mode");
  }
  if ((mode === "replay") !== Boolean(options.responses)) throw new QualityStop("replay_responses_required");
  const adapters = mode === "mock" ? await createScriptedAdapters() : null;
  const replay = mode === "replay" ? createReplayAdapter(z.array(z.object({
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/), output: z.unknown(),
  }).strict()).parse(JSON.parse(await readFile(resolve(options.responses), "utf8")))) : null;
  const store = await createRunStore(output);
  try {
    const result = await runQualityLoop({
      ...await loadFixtures(), store, mode,
      model: adapters?.model ?? replay!, judge: adapters?.judge ?? replay!,
      maxIterations: Number(options.iterations ?? 3), maxCalls: Number(options["max-calls"] ?? 1000),
      timeoutMs: Number(options["timeout-ms"] ?? 60000),
    });
    return { id: store.id, directory: store.directory, ...result };
  } catch (error) {
    const result = { type: "finished", stopReason: error instanceof QualityStop ? error.code : "preflight_refused",
      recommendation: "none", measuredQualityAchieved: false, promoted: false, paidCalls: 0, decisionGrade: false };
    await store.record(result);
    return { id: store.id, directory: store.directory, ...result };
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if ("stopReason" in result && !["iteration_limit", "duplicate_candidate"].includes(String(result.stopReason))) {
      process.exitCode = 2;
    }
  }).catch((error) => {
    console.error(JSON.stringify({ error: error instanceof QualityStop ? error.code : "cli_failed" }));
    process.exitCode = 2;
  });
}
