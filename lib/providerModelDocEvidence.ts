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
  type AnthropicPricingPage,
  promotionNotices,
  type DocEvidenceSource,
  type ProviderModelDocEvidenceStatus,
  type ProviderModelDocEvidenceSummary,
  type ProviderModelDocParse,
  type ProviderModelDocProvider,
} from "@/lib/providerModelDocsCore";
import {
  PROVIDER_MODEL_DOC_HOSTS,
  PROVIDER_MODEL_DOC_SOURCES,
  machineReadableDocProviders,
  type ProviderModelDocSource,
} from "@/lib/providerModelDocSources";
import { genericModelFromDocs, modelPageNoticeAppliesTo } from "@/lib/providerModelDocTables";

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

/**
 * Hosts a documentation read may reach. A redirect anywhere else is a failure,
 * not a follow. Derived from the source table so a provider cannot be added to
 * one and forgotten in the other.
 */
const DOCUMENT_HOSTS = new Set(PROVIDER_MODEL_DOC_HOSTS);
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

/** The shared pricing document for one provider, or null when it publishes none. */
const pricingMarkdownUrl = (provider: string): string | null => {
  if (provider === "openai") return OPENAI_PRICING_MARKDOWN_URL;
  if (provider === "anthropic") return ANTHROPIC_PRICING_MARKDOWN_URL;
  return (
    (PROVIDER_MODEL_DOC_SOURCES as Record<string, ProviderModelDocSource | undefined>)[provider]
      ?.pricingUrl ?? null
  );
};

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

type OpenAiPricingTable = ReturnType<typeof parseOpenAiStandardPricingTable>;

/**
 * One model's documents, read the same way the daily scan reads them.
 *
 * The scan shares one pricing page across a provider's queue. An adoption
 * form asks for one model, so it fetches that provider's page itself and then
 * calls this. The branches stay here so the two callers cannot grow apart.
 */
const readModelEvidence = async (input: {
  provider: ProviderModelDocProvider;
  apiModel: string;
  displayName: string | null;
  shared: FetchedDocument | undefined;
  openAiTable: OpenAiPricingTable | null;
  anthropicPage: AnthropicPricingPage | null;
  noticesFor: (apiModel: string) => string[];
  noteModelPageNotices: (apiModel: string, markdown: string) => void;
}): Promise<EvidenceWrite> => {
  const { provider, apiModel, shared } = input;
  const sharedSource: DocEvidenceSource[] = shared
    ? [{ url: shared.url, digest: shared.ok ? shared.digest : null }]
    : [];

  if (provider === "anthropic") {
    if (!shared?.ok || !input.anthropicPage) {
      return {
        provider,
        apiModel,
        status: shared?.ok
          ? "parse_failed"
          : shared?.status === "not_found"
            ? "fetch_failed"
            : (shared?.status ?? "fetch_failed"),
        sources: sharedSource,
        parse: null,
        problems: [shared?.ok ? "parse_skipped" : (shared?.problem ?? "no_source")],
      };
    }
    const parse = anthropicModelFromPricing(input.anthropicPage, input.displayName);
    return {
      provider,
      apiModel,
      status: parse.status,
      sources: sharedSource,
      parse,
      problems: parse.problems,
    };
  }

  if (provider === "openai") {
    const page = await fetchDocument(openAiModelMarkdownUrl(apiModel));
    const sources = [
      { url: page.url, digest: page.ok ? page.digest : null },
      ...sharedSource,
    ];
    if (!page.ok) {
      return { provider, apiModel, status: page.status, sources, parse: null, problems: [page.problem] };
    }
    input.noteModelPageNotices(apiModel, page.body);
    const parse = parseOpenAiModelPage({
      apiModel,
      modelPage: page.body,
      pricingTable: input.openAiTable,
    });
    const tableProblems = shared?.ok
      ? (input.openAiTable?.problems ?? []).map((problem) => `pricing_table:${problem}`)
      : [`pricing_table:${shared?.problem ?? "no_source"}`];
    const problems = [...parse.problems, ...tableProblems];
    return {
      provider,
      apiModel,
      status: parse.status,
      sources,
      parse: parse.status === "parsed" ? { ...parse, problems } : parse,
      problems,
    };
  }

  const source = (
    PROVIDER_MODEL_DOC_SOURCES as Record<string, ProviderModelDocSource | undefined>
  )[provider];
  const modelPageUrl = source?.modelPageUrl?.(apiModel) ?? null;
  const modelPage = modelPageUrl ? await fetchDocument(modelPageUrl) : null;
  const sources = [
    ...sharedSource,
    ...(modelPage
      ? [{ url: modelPage.url, digest: modelPage.ok ? modelPage.digest : null }]
      : []),
  ];
  if (!shared?.ok && !modelPage?.ok) {
    return {
      provider,
      apiModel,
      status: shared?.status ?? "fetch_failed",
      sources,
      parse: null,
      problems: [shared?.problem ?? "no_source"],
    };
  }
  if (modelPage?.ok) input.noteModelPageNotices(apiModel, modelPage.body);
  const parse = genericModelFromDocs({
    apiModel,
    pricingMarkdown: shared?.ok ? shared.body : null,
    modelPageMarkdown: modelPage?.ok ? modelPage.body : null,
    shape: source?.tableShape ?? "columns",
    expectedHeaders: source?.expectedPriceHeaders,
    promotionalNotices: input.noticesFor(apiModel),
  });
  const problems = [
    ...parse.problems,
    ...(shared?.ok ? [] : [`pricing_document:${shared?.problem ?? "no_source"}`]),
    ...(modelPage && !modelPage.ok ? [`model_page:${modelPage.problem}`] : []),
  ];
  return {
    provider,
    apiModel,
    status: parse.status,
    sources,
    parse: parse.status === "parsed" ? { ...parse, problems } : parse,
    problems,
  };
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

  // Kept per provider as well as reported: a sentence saying a price will end
  // has to reach the parse that stores that price, or the prefill offers a
  // promotional rate and the only warning is a line in a report.
  const noticesByProvider = new Map<string, string[]>();
  // And the acknowledged ones, by the model they were acknowledged for.
  // Acknowledging a sentence records which model it is about; it does not make
  // the price permanent.
  const noticesByModel = new Map<string, string[]>();
  const noteNotices = (provider: ProviderModelDocProvider, markdown: string) => {
    const { unacknowledged, promoted } = promotionNotices(provider, markdown);
    if (unacknowledged.length) {
      noticesByProvider.set(provider, [...unacknowledged]);
    }
    for (const sentence of unacknowledged) {
      summary.unacknowledgedNotices.push({ provider, sentence });
    }
    for (const [apiModel, sentence] of promoted) {
      const key = `${provider}\u0000${apiModel.toLowerCase()}`;
      noticesByModel.set(key, [...(noticesByModel.get(key) ?? []), sentence]);
    }
  };

  /**
   * Promotions on a page fetched for one model.
   *
   * A page whose title names one model speaks for that model. A page whose
   * title names two SKUs lends a sentence only where `modelPageNoticeAppliesTo`
   * says it applies, so FlashX's introductory rate does not withhold Flash.
   * The same sentence is recorded once, not once per SKU that shares the page.
   */
  const noteModelPageNotices = (
    provider: ProviderModelDocProvider,
    apiModel: string,
    markdown: string
  ) => {
    const { unacknowledged, promoted } = promotionNotices(provider, markdown);
    const applies = (sentence: string) =>
      modelPageNoticeAppliesTo(apiModel, markdown, sentence);
    const sentences = [...unacknowledged, ...promoted.values()].filter(applies);
    if (sentences.length) {
      const key = `${provider}\u0000${apiModel.toLowerCase()}`;
      noticesByModel.set(key, [...(noticesByModel.get(key) ?? []), ...sentences]);
    }
    for (const sentence of unacknowledged) {
      if (!applies(sentence)) continue;
      const existing = summary.unacknowledgedNotices.find(
        (row) =>
          row.provider === provider && row.sentence === sentence && row.source === "model_page"
      );
      if (existing) {
        existing.apiModels ??= [];
        if (!existing.apiModels.includes(apiModel)) existing.apiModels.push(apiModel);
        continue;
      }
      summary.unacknowledgedNotices.push({
        provider,
        sentence,
        source: "model_page",
        apiModels: [apiModel],
      });
    }
  };

  /** Every promotion that applies to one model: the page's and its own. */
  const noticesFor = (provider: ProviderModelDocProvider, apiModel: string) => [
    ...(noticesByModel.get(`${provider}\u0000${apiModel.toLowerCase()}`) ?? []),
    ...(noticesByProvider.get(provider) ?? []),
  ];

  const providers = machineReadableDocProviders().filter(
    (provider) => (selected.get(provider) ?? []).length > 0
  );
  if (providers.length === 0) return summary;

  // Phase one: the document every model of a provider shares, all providers at
  // once. Sequential shared reads were most of the budget and none of them
  // depends on another.
  //
  // The budget is checked before the first one as well as between the rest:
  // everything before this point reads the database, and a slow queue read can
  // spend the whole allowance before a single document is asked for.
  if (outOfTime()) {
    for (const provider of providers) {
      for (const apiModel of selected.get(provider) ?? []) skip(provider, apiModel);
    }
    return summary;
  }
  const sharedDocuments = new Map<string, FetchedDocument>();
  await Promise.all(
    providers.map(async (provider) => {
      const url = pricingMarkdownUrl(provider);
      if (!url) return;
      const document = await fetchDocument(url);
      sharedDocuments.set(provider, document);
      if (document.ok) noteNotices(provider, document.body);
    })
  );

  const openAiTable = (() => {
    const pricing = sharedDocuments.get("openai");
    return pricing?.ok ? parseOpenAiStandardPricingTable(pricing.body) : null;
  })();
  const anthropicPage = (() => {
    const pricing = sharedDocuments.get("anthropic");
    return pricing?.ok ? parseAnthropicPricingPage(pricing.body) : null;
  })();
  // Anthropic's page is looked up by the display name the models API returned,
  // which the scan already stored against the exact pair.
  const anthropicNames = new Map<string, string | null>();
  const anthropicModels = selected.get("anthropic") ?? [];
  if (anthropicModels.length) {
    const entries = await prisma.providerModelCatalogEntry.findMany({
      where: { provider: "anthropic", apiModel: { in: anthropicModels } },
      select: { apiModel: true, displayName: true },
    });
    for (const entry of entries) anthropicNames.set(entry.apiModel, entry.displayName);
  }

  // Phase two: one flat list of models, taken from the providers in turn, so
  // the budget is shared rather than claimed by whoever is read first.
  const tasks: { provider: ProviderModelDocProvider; apiModel: string }[] = [];
  const queues = providers.map((provider) => ({
    provider,
    models: [...(selected.get(provider) ?? [])],
  }));
  while (queues.some((queue) => queue.models.length > 0)) {
    for (const queue of queues) {
      const apiModel = queue.models.shift();
      if (apiModel) tasks.push({ provider: queue.provider, apiModel });
    }
  }

  await inBatches(tasks, PAGE_CONCURRENCY, async ({ provider, apiModel }) => {
    if (outOfTime()) {
      skip(provider, apiModel);
      return;
    }
    const write = await readModelEvidence({
      provider,
      apiModel,
      displayName: anthropicNames.get(apiModel) ?? null,
      shared: sharedDocuments.get(provider),
      openAiTable: provider === "openai" ? openAiTable : null,
      anthropicPage: provider === "anthropic" ? anthropicPage : null,
      noticesFor: (model) => noticesFor(provider, model),
      noteModelPageNotices: (model, markdown) => noteModelPageNotices(provider, model, markdown),
    });
    await record(write);
  });

  return summary;
}

/**
 * Read one model's first-party documents and store the evidence row.
 *
 * The adoption form calls this when the stored row cannot be used, so the
 * operator does not wait for the next daily scan. It is the same reader as
 * the scan: the same hosts, the same refusal of HTML, the same parse. A
 * provider that publishes prices only for people is skipped, and the form
 * names the official page instead of guessing a number.
 */
export async function refreshProviderModelDocEvidence(input: {
  provider: string;
  apiModel: string;
  displayName: string | null;
  now?: Date;
}): Promise<"read" | "skipped"> {
  const provider = machineReadableDocProviders().find((item) => item === input.provider);
  if (!provider) return "skipped";
  const url = pricingMarkdownUrl(provider);
  if (!url) return "skipped";
  const shared = await fetchDocument(url);
  const providerNotices: string[] = [];
  const modelNotices: string[] = [];
  if (shared.ok) {
    const { unacknowledged, promoted } = promotionNotices(provider, shared.body);
    providerNotices.push(...unacknowledged);
    for (const [model, sentence] of promoted) {
      if (model.toLowerCase() === input.apiModel.toLowerCase()) modelNotices.push(sentence);
    }
  }
  const write = await readModelEvidence({
    provider,
    apiModel: input.apiModel,
    displayName: input.displayName,
    shared,
    openAiTable:
      provider === "openai" && shared.ok ? parseOpenAiStandardPricingTable(shared.body) : null,
    anthropicPage:
      provider === "anthropic" && shared.ok ? parseAnthropicPricingPage(shared.body) : null,
    noticesFor: () => [...modelNotices, ...providerNotices],
    noteModelPageNotices: (apiModel, markdown) => {
      const { unacknowledged, promoted } = promotionNotices(provider, markdown);
      const applies = (sentence: string) => modelPageNoticeAppliesTo(apiModel, markdown, sentence);
      for (const sentence of [...unacknowledged, ...promoted.values()]) {
        if (applies(sentence)) modelNotices.push(sentence);
      }
    },
  });
  await writeEvidence(write, input.now ?? new Date());
  return "read";
}
