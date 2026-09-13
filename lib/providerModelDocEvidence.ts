import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { modelProductSurface } from "@/lib/modelLifecycleTriage";
import {
  OPEN_WORK_ITEM_STATUSES,
  observedPairsOf,
} from "@/lib/modelLifecycleWorkItemCore";
import {
  ANTHROPIC_PRICING_MARKDOWN_URL,
  OPENAI_PRICING_MARKDOWN_URL,
  PROVIDER_MODEL_DOC_PARSER_VERSION,
  PROVIDER_MODEL_DOC_PROVIDERS,
  anthropicModelFromPricing,
  openAiModelMarkdownUrl,
  parseAnthropicPricingPage,
  parseOpenAiModelPage,
  parseOpenAiStandardPricingTable,
  promotionNotices,
  type DocEvidenceSource,
  type ProviderModelDocEvidenceStatus,
  type ProviderModelDocEvidenceSummary,
  type ProviderModelDocParse,
  type ProviderModelDocProvider,
} from "@/lib/providerModelDocsCore";

export type { ProviderModelDocEvidenceSummary };

/**
 * Reads provider documentation for the models waiting in the adoption queue,
 * and records what it found with where it found it.
 *
 * Runs after the daily catalogue scan, on the server. Never from a browser
 * request: an admin opening an adoption form must not make that form's speed
 * and correctness depend on a third-party documentation host answering right
 * then, and the evidence has to be the same evidence for everyone who opens it.
 *
 * Only the queue, not the catalogue. The documents are fetched per model, and
 * the models anybody is deciding about are the ones in the queue; reading a
 * page for every model a provider lists would be a daily crawl of somebody
 * else's documentation for rows nobody will look at.
 */

/** Hosts a documentation read may reach. A redirect anywhere else is a failure, not a follow. */
const DOCUMENT_HOSTS = new Set(["developers.openai.com", "platform.claude.com"]);
const DOCUMENT_TIMEOUT_MS = 10_000;
const DOCUMENT_MAX_BYTES = 1_500_000;
/**
 * Per provider, per run, chosen stalest first so a long queue is read in
 * rotation rather than the same twelve every day and the thirteenth never.
 */
const MAX_MODELS_PER_PROVIDER = 12;
const PAGE_CONCURRENCY = 3;
/**
 * The whole documentation read's share of the check route's 180 seconds. The
 * catalogue scan before it can take most of a minute on its own, and the
 * reconciliation and report still have to run after. No new document is
 * started past this; what was not reached is reported as not read.
 */
const READ_BUDGET_MS = 45_000;

type FetchedDocument =
  | { ok: true; url: string; body: string; digest: string }
  | { ok: false; url: string; status: "not_found" | "fetch_failed"; problem: string };

/** The body, refused as soon as it passes the byte limit rather than after it is all in memory. */
const readLimited = async (response: Response) => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > DOCUMENT_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > DOCUMENT_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const fetchDocument = async (url: string): Promise<FetchedDocument> => {
  const host = new URL(url).hostname;
  if (!DOCUMENT_HOSTS.has(host)) {
    return { ok: false, url, status: "fetch_failed", problem: "host_not_allowed" };
  }
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/markdown, text/plain;q=0.9",
        "User-Agent": "TomverseModelCatalog/1.0",
      },
      cache: "no-store",
      // A documentation page that moved answers with a redirect. Following it
      // would read whatever the new location is -- a family overview, a login
      // page -- and parse its numbers as this model's.
      redirect: "error",
      signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS),
    });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, url, status: "not_found", problem: "http_404" };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, url, status: "fetch_failed", problem: `http_${response.status}` };
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/markdown|text\/plain/i.test(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      // The markdown endpoint answering with HTML is a changed contract. The
      // parsers are written against markdown, and running them over a rendered
      // page would fail in ways that look like a structure change.
      return { ok: false, url, status: "fetch_failed", problem: "unexpected_content_type" };
    }
    const body = await readLimited(response);
    if (body === null) {
      return { ok: false, url, status: "fetch_failed", problem: "document_too_large" };
    }
    return {
      ok: true,
      url,
      body,
      digest: createHash("sha256").update(body).digest("hex"),
    };
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    return { ok: false, url, status: "fetch_failed", problem: timedOut ? "timeout" : "network_error" };
  }
};

type EvidenceWrite = {
  provider: ProviderModelDocProvider;
  apiModel: string;
  status: ProviderModelDocEvidenceStatus;
  sources: DocEvidenceSource[];
  parse: ProviderModelDocParse | null;
  problems: string[];
};

const writeEvidence = async (write: EvidenceWrite, fetchedAt: Date) => {
  const data = {
    status: write.status,
    sources: write.sources as unknown as Prisma.InputJsonValue,
    parserVersion: PROVIDER_MODEL_DOC_PARSER_VERSION,
    fields:
      write.parse?.status === "parsed"
        ? (write.parse.fields as unknown as Prisma.InputJsonValue)
        : // Cleared on a failed read rather than kept. An adoption form showing
          // yesterday's price beside today's parse failure would be showing a
          // number the parser can no longer vouch for.
          Prisma.DbNull,
    problems: write.problems as Prisma.InputJsonValue,
    fetchedAt,
  };
  await prisma.providerModelDocEvidence.upsert({
    where: { provider_apiModel: { provider: write.provider, apiModel: write.apiModel } },
    create: { provider: write.provider, apiModel: write.apiModel, ...data },
    update: data,
  });
};

/**
 * The (provider, apiModel) pairs in the open adoption queue that a supported
 * provider lists, each provider's list ordered stalest evidence first and cut
 * at the cap. What the cap leaves out is returned too, so the report says so.
 */
const queueTargets = async () => {
  const items = await prisma.modelLifecycleWorkItem.findMany({
    where: { action: "add", status: { in: [...OPEN_WORK_ITEM_STATUSES] } },
    select: { provider: true, apiModel: true, evidence: true },
  });
  const supported = new Set<string>(PROVIDER_MODEL_DOC_PROVIDERS);
  const candidates = new Map<ProviderModelDocProvider, Set<string>>();
  for (const item of items) {
    for (const pair of observedPairsOf(item)) {
      if (!supported.has(pair.provider)) continue;
      if (modelProductSurface(pair.apiModel) !== "chat") continue;
      const provider = pair.provider as ProviderModelDocProvider;
      const set = candidates.get(provider) ?? new Set<string>();
      set.add(pair.apiModel);
      candidates.set(provider, set);
    }
  }
  const selected = new Map<ProviderModelDocProvider, string[]>();
  const overCap: Array<{ provider: string; apiModel: string; reason: "cap" }> = [];
  if (candidates.size === 0) return { selected, overCap };
  const existing = await prisma.providerModelDocEvidence.findMany({
    where: {
      OR: [...candidates.entries()].map(([provider, models]) => ({
        provider,
        apiModel: { in: [...models] },
      })),
    },
    select: { provider: true, apiModel: true, fetchedAt: true },
  });
  const lastRead = new Map(
    existing.map((row) => [`${row.provider} ${row.apiModel}`, row.fetchedAt.getTime()])
  );
  for (const [provider, models] of candidates) {
    const ordered = [...models].sort(
      (a, b) =>
        (lastRead.get(`${provider} ${a}`) ?? 0) - (lastRead.get(`${provider} ${b}`) ?? 0) ||
        a.localeCompare(b)
    );
    selected.set(provider, ordered.slice(0, MAX_MODELS_PER_PROVIDER));
    for (const apiModel of ordered.slice(MAX_MODELS_PER_PROVIDER)) {
      overCap.push({ provider, apiModel, reason: "cap" });
    }
  }
  return { selected, overCap };
};

const inBatches = async <T>(values: readonly T[], size: number, run: (value: T) => Promise<void>) => {
  for (let index = 0; index < values.length; index += size) {
    await Promise.all(values.slice(index, index + size).map(run));
  }
};

export async function collectProviderModelDocEvidence(
  now = new Date()
): Promise<ProviderModelDocEvidenceSummary> {
  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > READ_BUDGET_MS;
  const summary: ProviderModelDocEvidenceSummary = {
    attempted: 0,
    byStatus: { parsed: 0, not_found: 0, fetch_failed: 0, parse_failed: 0 },
    degraded: 0,
    failures: [],
    notAttempted: [],
    unacknowledgedNotices: [],
  };
  const record = async (write: EvidenceWrite) => {
    summary.attempted += 1;
    summary.byStatus[write.status] += 1;
    if (write.status === "parsed" && write.problems.length) summary.degraded += 1;
    if (write.status !== "parsed" || write.problems.length) {
      summary.failures.push({
        provider: write.provider,
        apiModel: write.apiModel,
        status: write.status === "parsed" ? "parsed_with_problems" : write.status,
        problems: write.problems,
      });
    }
    await writeEvidence(write, now);
  };
  const skip = (provider: ProviderModelDocProvider, apiModel: string) =>
    summary.notAttempted.push({ provider, apiModel, reason: "time_budget" });

  const { selected, overCap } = await queueTargets();
  summary.notAttempted.push(...overCap);

  const noteNotices = (provider: ProviderModelDocProvider, markdown: string) => {
    for (const sentence of promotionNotices(provider, markdown).unacknowledged) {
      summary.unacknowledgedNotices.push({ provider, sentence });
    }
  };

  const anthropicModels = selected.get("anthropic") ?? [];
  if (anthropicModels.length) {
    if (outOfTime()) anthropicModels.forEach((apiModel) => skip("anthropic", apiModel));
    else {
      const page = await fetchDocument(ANTHROPIC_PRICING_MARKDOWN_URL);
      // The page is looked up by the display name the models API returns, which
      // the scan already stored against the exact pair.
      const entries = await prisma.providerModelCatalogEntry.findMany({
        where: { provider: "anthropic", apiModel: { in: anthropicModels } },
        select: { apiModel: true, displayName: true },
      });
      const names = new Map(entries.map((entry) => [entry.apiModel, entry.displayName]));
      const parsedPage = page.ok ? parseAnthropicPricingPage(page.body) : null;
      if (page.ok) noteNotices("anthropic", page.body);
      for (const apiModel of anthropicModels) {
        if (!page.ok || !parsedPage) {
          await record({
            provider: "anthropic",
            apiModel,
            status: page.ok ? "parse_failed" : page.status === "not_found" ? "fetch_failed" : page.status,
            sources: [{ url: page.url, digest: null }],
            parse: null,
            problems: [page.ok ? "parse_skipped" : page.problem],
          });
          continue;
        }
        const parse = anthropicModelFromPricing(parsedPage, names.get(apiModel) ?? null);
        await record({
          provider: "anthropic",
          apiModel,
          status: parse.status,
          sources: [{ url: page.url, digest: page.digest }],
          parse,
          problems: parse.problems,
        });
      }
    }
  }

  const openAiModels = selected.get("openai") ?? [];
  if (openAiModels.length) {
    if (outOfTime()) openAiModels.forEach((apiModel) => skip("openai", apiModel));
    else {
      const pricing = await fetchDocument(OPENAI_PRICING_MARKDOWN_URL);
      const table = pricing.ok ? parseOpenAiStandardPricingTable(pricing.body) : null;
      if (pricing.ok) noteNotices("openai", pricing.body);
      await inBatches(openAiModels, PAGE_CONCURRENCY, async (apiModel) => {
        if (outOfTime()) {
          skip("openai", apiModel);
          return;
        }
        const page = await fetchDocument(openAiModelMarkdownUrl(apiModel));
        const sources = [
          { url: page.url, digest: page.ok ? page.digest : null },
          { url: pricing.url, digest: pricing.ok ? pricing.digest : null },
        ];
        if (!page.ok) {
          await record({ provider: "openai", apiModel, status: page.status, sources, parse: null, problems: [page.problem] });
          return;
        }
        const parse = parseOpenAiModelPage({ apiModel, modelPage: page.body, pricingTable: table });
        // Why the table could not be used travels with every model that needed
        // it, beside the parser's own "pricing_table_unavailable".
        const tableProblems = pricing.ok
          ? (table?.problems ?? []).map((problem) => `pricing_table:${problem}`)
          : [`pricing_table:${pricing.problem}`];
        const problems = [...parse.problems, ...tableProblems];
        await record({
          provider: "openai",
          apiModel,
          status: parse.status,
          sources,
          parse: parse.status === "parsed" ? { ...parse, problems } : parse,
          problems,
        });
      });
    }
  }

  return summary;
}
