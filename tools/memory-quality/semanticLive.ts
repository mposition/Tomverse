import { access, open, rename, unlink } from "node:fs/promises";
import { SEMANTIC_RETRIEVAL_ENV, SEMANTIC_RETRIEVAL_LIMITS } from "../../lib/semanticRetrievalCore";
import { QualityStop } from "./runner";

/**
 * Shared guards for the paid `--live` path of the semantic comparisons.
 *
 * This is an operator-run measuring tool, not the product: it does not use the
 * product's budget bucket, switches or cache. What replaces them is a hard call
 * ceiling the operator must type (`--max-calls`), a refusal to start when the
 * plan would not fit under it, one request per call and no retry (an unknown
 * outcome could be billed twice), and a save file that is claimed exclusively
 * before the first request and rewritten after every one -- so a paid result
 * is never overwritten by another run, a path that cannot be written refuses
 * the run before anything is spent, and an interrupted run keeps what it paid
 * for. Nothing here prints the credential.
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

/** Writes a whole file and flushes it; `writeFile` loops until every byte is written. */
async function writeWhole(path: string, flag: "wx" | "w", body: string) {
  const handle = await open(path, flag);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * The save file of one paid run, claimed before the first request.
 *
 * Created with "wx": an existing file -- even one that appeared since the
 * early check -- is never replaced, and a path whose directory is missing or
 * cannot be written is refused here, while nothing has been spent. If the
 * first snapshot cannot be written the claimed file is removed again, so a
 * retry is not refused by an empty file this run left behind.
 *
 * Every later snapshot is written in full to a sibling temporary file and then
 * renamed over the save file, which replaces it in one step. The file on disk
 * is therefore always a complete snapshot -- the previous one until the new
 * one is whole -- and a crash, a full disk or a short write can lose at most
 * the request that was being recorded, never the ones recorded before it.
 */
export class SaveTarget {
  private constructor(readonly path: string) {}

  static async claim(path: string, first: unknown): Promise<SaveTarget> {
    try {
      await writeWhole(path, "wx", JSON.stringify(first, null, 2) + "\n");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") await unlink(path).catch(() => undefined);
      throw new QualityStop(code === "EEXIST" ? "save_scores_exists" : "save_scores_unwritable");
    }
    return new SaveTarget(path);
  }

  /** Replaces the snapshot. A failure stops the run: the next request would be unrecorded. */
  async write(value: unknown) {
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      await writeWhole(temporary, "w", JSON.stringify(value, null, 2) + "\n");
      await rename(temporary, this.path);
    } catch {
      await unlink(temporary).catch(() => undefined);
      throw new QualityStop("save_scores_failed");
    }
  }

  /** Nothing is held open between snapshots; kept so callers have one place to end a run. */
  async close() {}
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
  /**
   * Embeds in batches of the provider's request size. `afterBatch` runs after
   * every paid batch with the vectors so far, so the caller can record them
   * before the next request is made.
   */
  embed(
    inputType: EmbedKind,
    texts: readonly string[],
    afterBatch?: (vectorsSoFar: readonly Int8Array[]) => Promise<void>,
  ): Promise<Int8Array[]>;
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
    async embed(inputType, texts, afterBatch) {
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
        if (afterBatch) await afterBatch(vectors);
      }
      return vectors;
    },
  };
}
