/**
 * Automatic coding catalogue drafts for newly discovered code-specialized
 * models (owner decision 2026-11-21).
 *
 * A model such as qwen3-coder-flash has no reason to enter Chat, so the model
 * discovery queue sends it to the coding catalogue. This step goes one further
 * and makes the dedicated-model draft itself -- the same paid LLM call the
 * "Coding draft" form makes (lib/modelCatalogDraftLlm.ts), over the same
 * official pages -- so the operator opens a finished draft instead of a form.
 *
 * Off unless MODEL_DISCOVERY_CODING_AUTO_DRAFT_ENABLED is exactly "true": a
 * paid call made without a person is the owner's to switch on, and nothing in
 * the code turns it on. It stores a draft and nothing else. Turning a model on
 * stays an operator's action on the coding catalogue screen, with its own
 * audit entry and judge.
 *
 * Bounds, all deterministic and all before the paid call:
 * - at most CODING_AUTO_DRAFT_MAX_PER_RUN model calls per scan;
 * - only newly filed items (never a retry of an earlier day's item);
 * - only providers a draft can read, and only when a default price page exists
 *   (the draft reads that page alone: provider terms and retention pages are
 *   no longer part of a coding draft, owner decision 2026-11-21);
 * - never a model the coding catalogue already has a row or draft for, checked
 *   before the call and again when the draft is stored (create-only: an
 *   operator's own draft made meanwhile is never overwritten);
 * - the same draft model and page host checks as the manual draft;
 * - a deadline checked before every step in turn, with no race: a page read is
 *   capped inside what is left, and the model call starts only with its own
 *   timeout plus a margin for the store still left. Nothing starts after the
 *   deadline, because nothing is left running to start it.
 * A failed or timed out call is recorded and never retried: its outcome is
 * unknown, and the operator's "Coding draft" button is the retry.
 *
 * Agent spending, not user credits: nothing here touches a credit or a Chat
 * budget. The stored draft is audited as the system actor, in the same
 * transaction (storeCatalogDraft).
 */
import "server-only";

import { codingDraftSighting } from "@/lib/codingCatalogDraftLink";
import { codingDraftSources } from "@/lib/adminModelCatalogFlow";
import { storeCatalogDraft } from "@/lib/modelCatalogAdmin";
import { defaultPriceSources, MODEL_ID_PATTERN } from "@/lib/modelCatalogCore";
import {
  CATALOG_DRAFT_LLM_TIMEOUT_MS,
  catalogDraftLlmFromEnv,
  DraftRefusal,
  fetchOfficialPage,
  type CatalogDraftLlm,
  type DraftPage,
} from "@/lib/modelCatalogDraftLlm";
import { modelProductSurface } from "@/lib/modelLifecycleTriage";
import { prisma } from "@/lib/prisma";

export const MODEL_DISCOVERY_CODING_AUTO_DRAFT_ENV = "MODEL_DISCOVERY_CODING_AUTO_DRAFT_ENABLED";
/** Paid draft calls one scan may make. A small bound on spending nobody asked for in the moment. */
export const CODING_AUTO_DRAFT_MAX_PER_RUN = 5;
/** What the store (one short transaction) needs after the model call returns. */
const STORE_MARGIN_MS = 5_000;
/** The model call starts only with this much left: its own timeout, then the store. */
const LLM_WINDOW_MS = CATALOG_DRAFT_LLM_TIMEOUT_MS + STORE_MARGIN_MS;
/** A page read needs at least this much beyond the model call's window to be worth starting. */
const MIN_PAGE_MS = 1_000;
const DEFAULT_WINDOW_MS = 150_000;

export const codingAutoDraftEnabled = (env: Readonly<Record<string, string | undefined>> = process.env) =>
  env[MODEL_DISCOVERY_CODING_AUTO_DRAFT_ENV] === "true";

export type CodingAutoDraftCandidate = {
  provider: string;
  apiModel: string;
  observedVia?: readonly { provider: string; apiModel: string }[];
};

/**
 * The code-specialized items a scan filed, by the same triage the queue shows
 * (modelProductSurface), never a second classifier. The weekly research's code
 * proposals are not candidates: they name providers Tomverse is not connected
 * to, which a draft cannot read.
 */
export const codingAutoDraftCandidates = (input: {
  scan: readonly CodingAutoDraftCandidate[];
}): CodingAutoDraftCandidate[] => input.scan.filter((item) => modelProductSurface(item.apiModel) === "coding");

export type CodingAutoDraftSkipReason =
  | "not_draft_provider"
  | "invalid_model_id"
  | "no_default_source"
  | "already_in_catalogue"
  | "duplicate";

export type CodingAutoDraftSummary = {
  status: "off" | "draft_llm_not_configured" | "ran";
  considered: number;
  /** Catalogue ids a draft was stored for. */
  drafted: string[];
  skipped: Array<{ apiModel: string; reason: CodingAutoDraftSkipReason }>;
  /** A call or page read that failed; the outcome of a call is not retried. */
  failed: Array<{ apiModel: string; code: string }>;
  /** Why the loop ended before its candidates did. */
  stopped: "cap" | "time_budget" | "unknown_outcome" | null;
};

export type CodingAutoDraftDeps = {
  draftLlm: () => Promise<CatalogDraftLlm | null>;
  entryExists: (modelId: string) => Promise<boolean>;
  /** `maxMs` caps the read inside what is left of the deadline. */
  fetchPage: (provider: string, url: string, maxMs: number) => Promise<DraftPage>;
  /** "exists" when the row appeared meanwhile: nothing was written. */
  store: (input: { modelId: string; draft: unknown }) => Promise<"stored" | "exists">;
  now: () => number;
};

const defaultDeps: CodingAutoDraftDeps = {
  draftLlm: () => catalogDraftLlmFromEnv(),
  entryExists: async (modelId) =>
    (await prisma.modelCatalogEntry.count({ where: { category: "coding", modelId } })) > 0,
  fetchPage: (provider, url, maxMs) => fetchOfficialPage(provider, url, maxMs),
  store: ({ modelId, draft }) => storeCatalogDraft({ category: "coding", modelId, draft, system: true }),
  now: () => Date.now(),
};

const emptySummary = (status: CodingAutoDraftSummary["status"], considered = 0): CodingAutoDraftSummary => ({
  status,
  considered,
  drafted: [],
  skipped: [],
  failed: [],
  stopped: null,
});

export async function runCodingAutoDraft(input: {
  candidates: readonly CodingAutoDraftCandidate[];
  /** Epoch ms the request must be finished by; defaults to a window from now. */
  deadlineAt?: number;
  env?: Readonly<Record<string, string | undefined>>;
  deps?: Partial<CodingAutoDraftDeps>;
}): Promise<CodingAutoDraftSummary> {
  // First, and before anything is read: a switch that is off costs nothing.
  if (!codingAutoDraftEnabled(input.env)) return emptySummary("off");
  const deps = { ...defaultDeps, ...input.deps };
  const candidates = input.candidates;
  if (candidates.length === 0) return emptySummary("ran");
  const llm = await deps.draftLlm();
  if (!llm) return emptySummary("draft_llm_not_configured", candidates.length);

  const summary = emptySummary("ran", candidates.length);
  const deadlineAt = input.deadlineAt ?? deps.now() + DEFAULT_WINDOW_MS;
  const seen = new Set<string>();
  let attempts = 0;

  for (const candidate of candidates) {
    const sighting = codingDraftSighting(candidate);
    const modelId = sighting?.apiModel ?? candidate.apiModel;
    const skip = (reason: CodingAutoDraftSkipReason) => summary.skipped.push({ apiModel: modelId, reason });
    if (!sighting) {
      skip("not_draft_provider");
      continue;
    }
    if (!MODEL_ID_PATTERN.test(modelId)) {
      skip("invalid_model_id");
      continue;
    }
    const key = modelId.toLowerCase();
    if (seen.has(key)) {
      skip("duplicate");
      continue;
    }
    seen.add(key);
    const price = defaultPriceSources(sighting.provider)[0];
    if (!price) {
      skip("no_default_source");
      continue;
    }
    if (await deps.entryExists(modelId)) {
      skip("already_in_catalogue");
      continue;
    }
    if (attempts >= CODING_AUTO_DRAFT_MAX_PER_RUN) {
      summary.stopped = "cap";
      break;
    }
    const remaining = () => deadlineAt - deps.now();
    // Nothing is worth starting if the model call could not start after the pages.
    if (remaining() < LLM_WINDOW_MS + MIN_PAGE_MS) {
      summary.stopped = "time_budget";
      break;
    }

    // The same page the manual form reads: the price page. Each step is checked
    // against what is left; no step is left running behind a deadline.
    const sources = codingDraftSources({ priceUrl: price }, defaultPriceSources(sighting.provider));
    const pages: DraftPage[] = [];
    let pageFailure: string | null = null;
    for (const url of sources) {
      const left = remaining();
      if (left < LLM_WINDOW_MS + MIN_PAGE_MS) break;
      try {
        pages.push(await deps.fetchPage(sighting.provider, url, left - LLM_WINDOW_MS));
      } catch (error) {
        pageFailure = error instanceof DraftRefusal ? error.code : "fetch_failed";
        break;
      }
    }
    if (pageFailure) {
      summary.failed.push({ apiModel: modelId, code: pageFailure });
      continue;
    }
    // The paid call starts only with its own timeout and the store still left.
    if (pages.length < sources.length || remaining() < LLM_WINDOW_MS) {
      summary.stopped = "time_budget";
      break;
    }
    attempts += 1;
    try {
      const draft = await llm.draftCodingProfile({ provider: sighting.provider, apiModelId: modelId, pages });
      if ((await deps.store({ modelId, draft })) === "exists") skip("already_in_catalogue");
      else summary.drafted.push(modelId);
    } catch (error) {
      const name = (error as { name?: unknown })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        // The call may have been charged without an answer. Not retried.
        summary.failed.push({ apiModel: modelId, code: "timeout_outcome_unknown" });
        summary.stopped = "unknown_outcome";
        break;
      }
      const code = error instanceof DraftRefusal ? error.code : (error as { code?: unknown })?.code;
      summary.failed.push({ apiModel: modelId, code: typeof code === "string" ? code : "draft_failed" });
    }
  }

  console.info(
    JSON.stringify({
      event: "model_discovery_coding_auto_draft",
      considered: summary.considered,
      drafted: summary.drafted.length,
      skipped: summary.skipped.length,
      failed: summary.failed.length,
      stopped: summary.stopped,
    })
  );
  return summary;
}
