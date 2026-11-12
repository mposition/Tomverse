import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { createReplayAdapter, createScriptedAdapters, loadFixtures } from "./mock";
import {
  loadRetrievalCases, measureProductRetrieval, PRODUCT_RETRIEVAL_CORPORA, type ProductRetrievalCorpus,
} from "./productRetrieval";
import { runQualityLoop, QualityStop } from "./runner";
import { loadKnowledgeCorpus, measureKnowledge } from "./semanticKnowledge";
import type { LiveContext } from "./semanticLive";
import { measureSemanticMemory } from "./semanticMemory";
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
        [--semantic (--rerank-scores <json> | --live --max-calls <n> --save-scores <new-json>)]
        Product retrieval (selectMemoryContext) Recall@5. Plain: no model call, no output files.
        --semantic also measures the rerank path (externalRelevance) next to it.
knowledge-retrieval [--scores <json> | --live --max-calls <n> --save-scores <new-json>]
        Knowledge-file retrieval Recall@6 and MRR: lexical, embed-only, rerank-only, embed+rerank.
        Without --scores only lexical is measured.
Defaults: mode=mock, out=.tmp/memory-quality, iterations=3, max-calls=1000, timeout-ms=60000,
corpus=retrieval-ko.
The run command has no live mode, paid execution, product writes, promotion, network or raw
Memory collection. --live (retrieval --semantic, knowledge-retrieval only) makes PAID provider
calls: it needs COHERE_API_KEY and the model variables, an explicit --max-calls (0 or absent is
refused) and a new --save-scores file; run it with node --conditions=react-server.`;
const commandOptions: Record<string, string[]> = {
  run: ["mode", "out", "responses", "iterations", "max-calls", "timeout-ms"],
  list: ["out"], show: ["out", "run"], stop: ["out", "run"],
  "export-replay": ["out", "run", "file"],
  retrieval: ["corpus", "semantic", "rerank-scores", "live", "max-calls", "save-scores"],
  "knowledge-retrieval": ["scores", "live", "max-calls", "save-scores"],
};
const booleanOptions = new Set(["semantic", "live"]);
function parse(args: string[]) {
  const command = args[0] ?? "help", options: Record<string, string> = {};
  if (command === "help" || command === "--help") return { command: "help", options };
  if (!commandOptions[command]) throw new QualityStop("unknown_command");
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    const name = flag.slice(2);
    if (!flag.startsWith("--") || !commandOptions[command].includes(name) || options[name] !== undefined) {
      throw new QualityStop("unknown_or_invalid_option");
    }
    if (booleanOptions.has(name)) {
      options[name] = "true";
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new QualityStop("unknown_or_invalid_option");
    options[name] = value;
    index += 1;
  }
  return { command, options };
}
export async function main(args: string[], context: LiveContext = {}) {
  const { command, options } = parse(args);
  if (command === "help") return { help: HELP };
  if (command === "knowledge-retrieval") {
    const live = options.live === "true";
    if (live && options.scores) throw new QualityStop("live_and_scores_exclusive");
    if (!live && (options["max-calls"] || options["save-scores"])) throw new QualityStop("live_option_without_live");
    const result = await measureKnowledge({ corpus: await loadKnowledgeCorpus(), options, live, context });
    return { knowledgeRetrieval: result, ...("stopReason" in result ? { stopReason: result.stopReason } : {}) };
  }
  if (command === "retrieval") {
    const corpus = options.corpus ?? "retrieval-ko";
    const names = corpus === "all" ? PRODUCT_RETRIEVAL_CORPORA
      : PRODUCT_RETRIEVAL_CORPORA.filter((name) => name === corpus);
    if (names.length === 0) throw new QualityStop("unknown_corpus");
    const results: Record<string, ReturnType<typeof measureProductRetrieval>> = {};
    const loaded: Record<string, Awaited<ReturnType<typeof loadRetrievalCases>>> = {};
    for (const name of names) {
      loaded[name] = await loadRetrievalCases(name as ProductRetrievalCorpus);
      results[name] = measureProductRetrieval(loaded[name]);
    }
    const live = options.live === "true";
    if (!options.semantic) {
      if (live || options["rerank-scores"] || options["max-calls"] || options["save-scores"]) {
        throw new QualityStop("semantic_required");
      }
      return { retrieval: results };
    }
    if (live && options["rerank-scores"]) throw new QualityStop("live_and_scores_exclusive");
    if (!live && !options["rerank-scores"]) throw new QualityStop("semantic_source_required");
    if (!live && (options["max-calls"] || options["save-scores"])) throw new QualityStop("live_option_without_live");
    if (live && names.length !== 1) throw new QualityStop("live_single_corpus");
    const semantic: Record<string, Awaited<ReturnType<typeof measureSemanticMemory>>> = {};
    for (const name of names) {
      semantic[name] = await measureSemanticMemory({ corpus: name, cases: loaded[name], options, live, context });
    }
    const stopped = Object.values(semantic).find((row) => "stopReason" in row);
    return { retrieval: results, semantic, ...(stopped && "stopReason" in stopped ? { stopReason: stopped.stopReason } : {}) };
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
