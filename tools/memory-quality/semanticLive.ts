import { access, writeFile } from "node:fs/promises";
import { SEMANTIC_RETRIEVAL_ENV, SEMANTIC_RETRIEVAL_LIMITS } from "../../lib/semanticRetrievalCore";
import { QualityStop } from "./runner";

/**
 * Shared guards for the paid `--live` path of the semantic comparisons.
 *
 * This is an operator-run measuring tool, not the product: it does not use the
 * product's budget bucket, switches or cache. What replaces them is a hard call
 * ceiling the operator must type (`--max-calls`), a refusal to start when the
 * plan would not fit under it, one request per call and no retry (an unknown
 * outcome could be billed twice), and a save file that is created exclusively
 * so a paid result is never overwritten. Nothing here prints the credential.
 */

type Env = Record<string, string | undefined>;
type FetchImpl = typeof fetch;
export type LiveContext = { env?: Env; fetchImpl?: FetchImpl };
export type EmbedKind = "search_document" | "search_query";

const MODEL_ID = /^[a-z0-9][a-z0-9._:-]{1,79}$/i;

export class LiveStop extends QualityStop {
  constructor(code: string, public failure: string | null = null) { super(code); }
}

export type LiveConfig = {
  maxCalls: number; saveScores: string;
  rerankModel: string; embedModel: string | null; embedDimension: number | null;
};

const text = (env: Env, name: string) => env[name]?.trim() || null;

/**
 * Every precondition of a paid run, checked before the first request. The order
 * is fixed so the refusal names the first missing thing: the ceiling, then the
 * environment, then the save file.
 */
export async function resolveLive(
  options: Record<string, string>, context: LiveContext, needs: { embed: boolean },
): Promise<LiveConfig> {
  const raw = options["max-calls"];
  const maxCalls = raw === undefined ? 0 : Number(raw);
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0) throw new QualityStop("max_calls_invalid");
  if (maxCalls === 0) throw new QualityStop("max_calls_required");

  const env = context.env ?? process.env;
  const rerankModel = text(env, SEMANTIC_RETRIEVAL_ENV.rerankModel);
  const embedModel = text(env, SEMANTIC_RETRIEVAL_ENV.embedModel);
  const dimensionText = text(env, SEMANTIC_RETRIEVAL_ENV.embedDimension);
  const embedDimension = dimensionText === null ? null : Number(dimensionText);
  if (!text(env, SEMANTIC_RETRIEVAL_ENV.apiKey) || !rerankModel || (needs.embed && !embedModel)) {
    throw new QualityStop("live_env_missing");
  }
  if (!MODEL_ID.test(rerankModel) || (embedModel !== null && !MODEL_ID.test(embedModel)) ||
      (embedDimension !== null && (!Number.isSafeInteger(embedDimension) || embedDimension <= 0))) {
    throw new QualityStop("live_env_invalid");
  }

  const saveScores = options["save-scores"];
  if (!saveScores) throw new QualityStop("save_scores_required");
  await assertAbsent(saveScores);
  return { maxCalls, saveScores, rerankModel, embedModel: needs.embed ? embedModel : null, embedDimension };
}

async function assertAbsent(path: string) {
  try { await access(path); } catch { return; }
  throw new QualityStop("save_scores_exists");
}

/** Created exclusively: an existing file, even one that appeared during the run, is never replaced. */
export async function saveNewScores(path: string, value: unknown) {
  try {
    await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  } catch (error) {
    throw new QualityStop((error as NodeJS.ErrnoException).code === "EEXIST" ? "save_scores_exists" : "save_scores_failed");
  }
}

export class CallMeter {
  calls = 0;
  searchUnits = 0;
  /** Rerank calls whose response did not say what it billed. */
  searchUnitsUnreported = 0;
  embedInputTokens = 0;
  constructor(readonly maxCalls: number) {}
  /** Counted before the request leaves: a call that fails may still have been billed. */
  take() {
    if (this.calls >= this.maxCalls) throw new LiveStop("max_calls_reached");
    this.calls += 1;
  }
  summary() {
    return {
      calls: this.calls, maxCalls: this.maxCalls, searchUnits: this.searchUnits,
      searchUnitsUnreported: this.searchUnitsUnreported, embedInputTokens: this.embedInputTokens,
    };
  }
}

export const embedBatchCount = (inputs: number) =>
  Math.ceil(inputs / SEMANTIC_RETRIEVAL_LIMITS.maxEmbedInputsPerRequest);

export type LiveClient = {
  meter: CallMeter;
  rerank(query: string, documents: readonly string[]): Promise<number[]>;
  embed(inputType: EmbedKind, texts: readonly string[]): Promise<Int8Array[]>;
};

/**
 * The product's own two HTTP calls (`callRerank`, `callEmbed`) behind the meter.
 *
 * Loaded on demand: the client file is `server-only`, which throws outside the
 * `react-server` resolution condition, and the offline commands must keep
 * working without it.
 */
export async function openLiveClient(config: LiveConfig, context: LiveContext): Promise<LiveClient> {
  let client: typeof import("../../lib/semanticRetrievalClient");
  try {
    client = await import("../../lib/semanticRetrievalClient");
  } catch {
    throw new QualityStop("live_client_unavailable");
  }
  const meter = new CallMeter(config.maxCalls);
  const options = { env: context.env ?? process.env, ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}) };
  return {
    meter,
    async rerank(query, documents) {
      meter.take();
      const result = await client.callRerank({ model: config.rerankModel, query, documents }, options);
      if (!result.ok) throw new LiveStop("live_call_failed", result.failure);
      if (result.value.searchUnits === null) meter.searchUnitsUnreported += 1;
      else meter.searchUnits += result.value.searchUnits;
      return result.value.scores;
    },
    async embed(inputType, texts) {
      const vectors: Int8Array[] = [];
      for (let start = 0; start < texts.length; start += SEMANTIC_RETRIEVAL_LIMITS.maxEmbedInputsPerRequest) {
        const batch = texts.slice(start, start + SEMANTIC_RETRIEVAL_LIMITS.maxEmbedInputsPerRequest);
        meter.take();
        const result = await client.callEmbed({
          model: config.embedModel!, dimension: config.embedDimension, inputType, texts: batch,
        }, { ...options, indexing: inputType === "search_document" });
        if (!result.ok) throw new LiveStop("live_call_failed", result.failure);
        meter.embedInputTokens += result.value.inputTokens ?? 0;
        vectors.push(...result.value.vectors);
      }
      return vectors;
    },
  };
}
