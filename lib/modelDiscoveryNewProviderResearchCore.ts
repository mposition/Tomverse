/**
 * New-provider research for the model discovery queue (owner request
 * 2026-11-11): the daily catalogue scan only sees providers Tomverse is
 * already connected to, so a provider whose models rival what Chat, Image or
 * Code serve today would never reach the queue. Once a week one search-capable
 * model call per product proposes such providers and models; this module holds
 * the prompt, the output schema and the deterministic boundary check on the
 * answer. Pure: no I/O, so the check is unit-testable.
 *
 * The answer is a proposal an operator reads, never a decision. The boundary
 * check keeps three things out of the queue: a candidate without a citable
 * public http(s) source, a provider Tomverse is already connected to (the
 * catalogue scan owns those), and a model id the queue or catalogue already
 * knows.
 */

export const NEW_PROVIDER_RESEARCH_PRODUCTS = ["chat", "image", "code"] as const;
export type NewProviderResearchProduct = (typeof NEW_PROVIDER_RESEARCH_PRODUCTS)[number];

/** `discoveredBy` on the work item's evidence; how the queue tells these rows apart. */
export const NEW_PROVIDER_RESEARCH_SOURCE = "new_provider_research";

export const NEW_PROVIDER_RESEARCH_MAX_CANDIDATES = 5;
export const NEW_PROVIDER_RESEARCH_MAX_CITATIONS = 5;

const PRODUCT_LABEL_KO: Record<NewProviderResearchProduct, string> = {
  chat: "Chat",
  image: "Image",
  code: "Code",
};

const PRODUCT_TASK: Record<NewProviderResearchProduct, string> = {
  chat: "general chat assistants (reasoning, writing, multilingual answers, tool use)",
  image: "image generation and image editing from text prompts",
  code: "coding agents (code generation, repository edits, tool calling, long context)",
};

export type NewProviderResearchCandidate = {
  providerName: string;
  modelName: string;
  apiModelId: string;
  comparableTo: string;
  benchmarkBasisKo: string;
  apiAvailabilityKo: string;
  pricingKo: string;
  citations: string[];
};

const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength }) as const;

export const NEW_PROVIDER_RESEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      maxItems: NEW_PROVIDER_RESEARCH_MAX_CANDIDATES,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "providerName",
          "modelName",
          "apiModelId",
          "comparableTo",
          "benchmarkBasisKo",
          "apiAvailabilityKo",
          "pricingKo",
          "citations",
        ],
        properties: {
          providerName: text(80),
          modelName: text(120),
          apiModelId: text(120),
          comparableTo: text(120),
          benchmarkBasisKo: text(400),
          apiAvailabilityKo: text(300),
          pricingKo: text(300),
          citations: {
            type: "array",
            minItems: 1,
            maxItems: NEW_PROVIDER_RESEARCH_MAX_CITATIONS,
            items: text(500),
          },
        },
      },
    },
  },
} as const;

export const NEW_PROVIDER_RESEARCH_SYSTEM = `You research AI model providers for Tomverse, a multi-model AI platform.
Search the web for current, verifiable information. Propose only providers and models that:
- are NOT run by any provider in the "connected providers" list, and are not models already listed as served by Tomverse;
- offer a public, paid or self-serve API that a company can integrate today (not waitlist-only, not consumer app only);
- show performance comparable to the Tomverse models named for the product, on public benchmarks, leaderboards or independent evaluations.
Every candidate needs at least one citation: a full https URL of a page you actually read (benchmark, leaderboard, official docs or pricing page).
Prices are approximate USD with their unit. Write the fields ending in "Ko" in Korean.
If you find no candidate that meets every condition, return an empty list. Never invent a URL, model id or price.`;

export const newProviderResearchPrompt = (input: {
  product: NewProviderResearchProduct;
  currentModels: readonly string[];
  connectedProviders: readonly string[];
  today: string;
}) =>
  [
    `Date: ${input.today}.`,
    `Product: Tomverse ${PRODUCT_LABEL_KO[input.product]} — ${PRODUCT_TASK[input.product]}.`,
    `Models Tomverse serves for this product today: ${input.currentModels.slice(0, 40).join(", ") || "(none listed)"}.`,
    `Connected providers (exclude, including models they resell): ${input.connectedProviders.join(", ")}.`,
    `Propose up to ${NEW_PROVIDER_RESEARCH_MAX_CANDIDATES} providers/models from outside that list whose performance is comparable to the models above.`,
    "For each: providerName, modelName, apiModelId (the exact id sent to the provider's API), comparableTo (which Tomverse model it rivals),",
    "benchmarkBasisKo (which benchmark or evaluation, with the numbers), apiAvailabilityKo (API type, region limits, OpenAI-compatible or not),",
    "pricingKo (approximate USD price and unit), citations (https URLs).",
  ].join("\n");

/** Lowercase letters and digits only: "Google DeepMind" -> "googledeepmind". */
export const providerToken = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** A slug for the work item's provider column: "Black Forest Labs" -> "black-forest-labs". */
export const providerSlug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/**
 * Other names a connected provider is published under. Only names of four
 * characters or more, matched anywhere in the proposed provider's name; the
 * slugs themselves are matched as a prefix. A false match only drops a
 * proposal, which is the safe direction.
 */
const CONNECTED_PROVIDER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  openai: ["openai", "chatgpt", "dalle"],
  anthropic: ["anthropic", "claude"],
  google: ["google", "gemini", "deepmind", "imagen", "vertex"],
  xai: ["grok"],
  qwen: ["alibaba", "tongyi", "dashscope"],
  zhipu: ["zhipu", "bigmodel", "chatglm"],
  moonshot: ["moonshot", "kimi"],
  perplexity: ["perplexity", "sonar"],
  openrouter: ["openrouter"],
  deepinfra: ["deepinfra"],
  together: ["togetherai", "togethercomputer"],
  mistral: ["mistral"],
  deepseek: ["deepseek"],
  minimax: ["minimax", "hailuo"],
  groq: ["groqcloud"],
  fal: ["falai"],
};

/** Whether a proposed provider name is one Tomverse is already connected to. */
export const isConnectedProvider = (providerName: string, connectedProviders: readonly string[]) => {
  const token = providerToken(providerName);
  if (!token) return true;
  return connectedProviders.some((provider) => {
    const slug = providerToken(provider);
    if (slug && (token === slug || token.startsWith(slug))) return true;
    return (CONNECTED_PROVIDER_ALIASES[provider] ?? []).some(
      (alias) => alias.length >= 4 && token.includes(alias)
    );
  });
};

/** The model id compared across providers: lowercase, without a vendor prefix. */
export const modelIdKey = (apiModel: string) =>
  apiModel.slice(apiModel.lastIndexOf("/") + 1).trim().toLowerCase();

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home|.*\.corp)$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * A citation the queue may show: an absolute http(s) URL with a public DNS
 * name. No credentials, no IP literals, no local names. Returns the
 * normalised URL or null.
 */
export const publicCitationUrl = (value: string): string | null => {
  if (typeof value !== "string" || value.length > 500) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.startsWith("[") || IPV4.test(host) || PRIVATE_HOST.test(host)) return null;
  if (!/^[a-z0-9.-]+$/.test(host) || host.endsWith(".")) return null;
  url.hash = "";
  return url.toString();
};

const API_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$/;

export type NewProviderResearchRejection = {
  providerName: string;
  apiModelId: string;
  reason:
    | "invalid_shape"
    | "no_public_citation"
    | "connected_provider"
    | "known_model"
    | "duplicate"
    | "not_connected_provider"
    | "no_official_citation";
};

export type AcceptedNewProviderCandidate = NewProviderResearchCandidate & {
  product: NewProviderResearchProduct;
  provider: string;
  /** Set on an image model of an already-connected provider. */
  scope?: typeof CONNECTED_IMAGE_RESEARCH_SCOPE;
};

const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

/**
 * The deterministic check on the model's answer. Everything the model says is
 * a claim; this decides only which claims may be shown as a proposal.
 */
export const acceptNewProviderCandidates = (input: {
  product: NewProviderResearchProduct;
  answer: unknown;
  connectedProviders: readonly string[];
  knownApiModels: readonly string[];
}): { accepted: AcceptedNewProviderCandidate[]; rejected: NewProviderResearchRejection[] } => {
  const accepted: AcceptedNewProviderCandidate[] = [];
  const rejected: NewProviderResearchRejection[] = [];
  const known = new Set(input.knownApiModels.map(modelIdKey));
  const raw = (input.answer as { candidates?: unknown } | null)?.candidates;
  const candidates = Array.isArray(raw) ? raw.slice(0, NEW_PROVIDER_RESEARCH_MAX_CANDIDATES) : [];
  for (const item of candidates) {
    const value = (item ?? {}) as Record<string, unknown>;
    const candidate: NewProviderResearchCandidate = {
      providerName: clean(value.providerName, 80),
      modelName: clean(value.modelName, 120),
      apiModelId: clean(value.apiModelId, 120),
      comparableTo: clean(value.comparableTo, 120),
      benchmarkBasisKo: clean(value.benchmarkBasisKo, 400),
      apiAvailabilityKo: clean(value.apiAvailabilityKo, 300),
      pricingKo: clean(value.pricingKo, 300),
      citations: [],
    };
    const label = { providerName: candidate.providerName, apiModelId: candidate.apiModelId };
    const provider = providerSlug(candidate.providerName);
    if (
      !provider ||
      !candidate.modelName ||
      !API_MODEL_ID.test(candidate.apiModelId) ||
      !candidate.benchmarkBasisKo
    ) {
      rejected.push({ ...label, reason: "invalid_shape" });
      continue;
    }
    candidate.citations = Array.from(
      new Set(
        (Array.isArray(value.citations) ? value.citations : [])
          .slice(0, NEW_PROVIDER_RESEARCH_MAX_CITATIONS)
          .map((url) => publicCitationUrl(url as string))
          .filter((url): url is string => url !== null)
      )
    );
    if (candidate.citations.length === 0) {
      rejected.push({ ...label, reason: "no_public_citation" });
      continue;
    }
    if (isConnectedProvider(candidate.providerName, input.connectedProviders)) {
      rejected.push({ ...label, reason: "connected_provider" });
      continue;
    }
    const key = modelIdKey(candidate.apiModelId);
    if (known.has(key)) {
      rejected.push({ ...label, reason: "known_model" });
      continue;
    }
    if (accepted.some((other) => modelIdKey(other.apiModelId) === key)) {
      rejected.push({ ...label, reason: "duplicate" });
      continue;
    }
    accepted.push({ ...candidate, product: input.product, provider });
  }
  return { accepted, rejected };
};

/**
 * Image models of providers Tomverse is already connected to (owner request
 * 2026-11-14). The catalogue scan reads each provider's model-list API, and
 * several serve image models on a separate endpoint that no list API returns:
 * MiniMax-H3-Image (POST /v1/images/generations) and Z.ai's glm-image
 * (POST /api/paas/v4/images/generations) never appeared in the queue. One more
 * weekly call asks for them, and the check below accepts a candidate only from
 * a connected provider, cited on that provider's own official documentation.
 */
export const CONNECTED_IMAGE_RESEARCH_SCOPE = "connected_image" as const;

export const CONNECTED_IMAGE_RESEARCH_SYSTEM = `You research AI model providers for Tomverse, a multi-model AI platform.
Search the provider's own official API documentation and pricing pages. List image generation or image editing models that:
- are offered by one of the named providers through that provider's own public API today (not a reseller, not consumer app only, not waitlist-only);
- are not in the list of model ids Tomverse already knows.
Every candidate needs at least one citation: a full https URL of the provider's own official documentation or pricing page that you actually read.
providerName must be exactly one of the provider ids given. apiModelId is the exact id sent to the image API.
Prices are approximate USD with their unit (for example per image). Write the fields ending in "Ko" in Korean.
If you find nothing that meets every condition, return an empty list. Never invent a URL, model id or price.`;

export const connectedImageResearchPrompt = (input: {
  providers: readonly string[];
  currentImageModels: readonly string[];
  knownApiModels: readonly string[];
  today: string;
}) =>
  [
    `Date: ${input.today}.`,
    `Providers to check (use these ids as providerName): ${input.providers.join(", ")}.`,
    `Image models Tomverse serves today: ${input.currentImageModels.slice(0, 40).join(", ") || "(none listed)"}.`,
    `Model ids Tomverse already knows (exclude): ${Array.from(new Set(input.knownApiModels.map(modelIdKey))).slice(0, 400).join(", ")}.`,
    `List up to ${NEW_PROVIDER_RESEARCH_MAX_CANDIDATES} image generation or editing models these providers offer by API that are not in that list.`,
    "For each: providerName (one of the ids above), modelName, apiModelId, comparableTo (the Tomverse image model it is closest to),",
    "benchmarkBasisKo (what the provider says it is for, and any public evaluation), apiAvailabilityKo (endpoint path and request shape),",
    "pricingKo (approximate USD and unit), citations (https URLs on the provider's official docs or pricing pages).",
  ].join("\n");

/** Short published names too short for the alias rule above: "Z.ai" is Zhipu. */
const EXACT_PROVIDER_NAMES: Readonly<Record<string, string>> = {
  zai: "zhipu",
  zhipuai: "zhipu",
  xaicorp: "xai",
};

/** The connected provider id a proposed provider name refers to, or null. */
export const connectedProviderId = (providerName: string, connectedProviders: readonly string[]) => {
  const token = providerToken(providerName);
  if (!token) return null;
  const exact = EXACT_PROVIDER_NAMES[token];
  if (exact && connectedProviders.includes(exact)) return exact;
  return (
    connectedProviders.find((provider) => providerToken(provider) === token) ??
    connectedProviders.find((provider) => isConnectedProvider(providerName, [provider])) ??
    null
  );
};

/**
 * The check on the connected-image answer: the provider must be connected,
 * at least one citation must be on that provider's official documentation
 * (`isOfficial`, lib/modelCatalogCore.ts isOfficialSourceUrl), and the model id
 * must be new. Only the official citations are kept.
 */
export const acceptConnectedImageCandidates = (input: {
  answer: unknown;
  connectedProviders: readonly string[];
  knownApiModels: readonly string[];
  isOfficial: (provider: string, url: string) => boolean;
}): { accepted: AcceptedNewProviderCandidate[]; rejected: NewProviderResearchRejection[] } => {
  const accepted: AcceptedNewProviderCandidate[] = [];
  const rejected: NewProviderResearchRejection[] = [];
  const known = new Set(input.knownApiModels.map(modelIdKey));
  const raw = (input.answer as { candidates?: unknown } | null)?.candidates;
  const candidates = Array.isArray(raw) ? raw.slice(0, NEW_PROVIDER_RESEARCH_MAX_CANDIDATES) : [];
  for (const item of candidates) {
    const value = (item ?? {}) as Record<string, unknown>;
    const candidate: NewProviderResearchCandidate = {
      providerName: clean(value.providerName, 80),
      modelName: clean(value.modelName, 120),
      apiModelId: clean(value.apiModelId, 120),
      comparableTo: clean(value.comparableTo, 120),
      benchmarkBasisKo: clean(value.benchmarkBasisKo, 400),
      apiAvailabilityKo: clean(value.apiAvailabilityKo, 300),
      pricingKo: clean(value.pricingKo, 300),
      citations: [],
    };
    const label = { providerName: candidate.providerName, apiModelId: candidate.apiModelId };
    if (!candidate.modelName || !API_MODEL_ID.test(candidate.apiModelId) || !candidate.benchmarkBasisKo) {
      rejected.push({ ...label, reason: "invalid_shape" });
      continue;
    }
    const provider = connectedProviderId(candidate.providerName, input.connectedProviders);
    if (!provider) {
      rejected.push({ ...label, reason: "not_connected_provider" });
      continue;
    }
    candidate.citations = Array.from(
      new Set(
        (Array.isArray(value.citations) ? value.citations : [])
          .slice(0, NEW_PROVIDER_RESEARCH_MAX_CITATIONS)
          .map((url) => publicCitationUrl(url as string))
          .filter((url): url is string => url !== null && input.isOfficial(provider, url))
      )
    );
    if (candidate.citations.length === 0) {
      rejected.push({ ...label, reason: "no_official_citation" });
      continue;
    }
    const key = modelIdKey(candidate.apiModelId);
    if (known.has(key)) {
      rejected.push({ ...label, reason: "known_model" });
      continue;
    }
    if (accepted.some((other) => modelIdKey(other.apiModelId) === key)) {
      rejected.push({ ...label, reason: "duplicate" });
      continue;
    }
    accepted.push({
      ...candidate,
      product: "image",
      provider,
      scope: CONNECTED_IMAGE_RESEARCH_SCOPE,
    });
  }
  return { accepted, rejected };
};

/** What the work item's evidence stores for one accepted proposal. */
export const newProviderResearchEvidence = (candidate: AcceptedNewProviderCandidate, modelId: string) => ({
  discoveredBy: NEW_PROVIDER_RESEARCH_SOURCE,
  researchModelId: modelId,
  ...(candidate.scope ? { scope: candidate.scope } : {}),
  product: candidate.product,
  providerName: candidate.providerName,
  modelName: candidate.modelName,
  comparableTo: candidate.comparableTo,
  benchmarkBasisKo: candidate.benchmarkBasisKo,
  apiAvailabilityKo: candidate.apiAvailabilityKo,
  pricingKo: candidate.pricingKo,
  citations: candidate.citations,
  observedVia: [],
});

export type NewProviderResearchAnalysis = {
  product: NewProviderResearchProduct;
  /** True for an image model of a provider Tomverse is already connected to. */
  connected: boolean;
  providerName: string;
  citations: string[];
  verdictKo: string;
  pointsKo: string[];
  nextStepKo: string;
  analysisKo: string;
};

/**
 * The queue's analysis for a research row, read from what was stored when it
 * was filed so the text an exclusion snapshots never changes under it. Null
 * for any other row.
 */
export const newProviderResearchAnalysis = (evidence: unknown): NewProviderResearchAnalysis | null => {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null;
  const value = evidence as Record<string, unknown>;
  if (value.discoveredBy !== NEW_PROVIDER_RESEARCH_SOURCE) return null;
  const product = NEW_PROVIDER_RESEARCH_PRODUCTS.find((item) => item === value.product);
  if (!product) return null;
  const read = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : "");
  const citations = (Array.isArray(value.citations) ? value.citations : [])
    .map((url) => publicCitationUrl(url as string))
    .filter((url): url is string => url !== null);
  const connected = value.scope === CONNECTED_IMAGE_RESEARCH_SCOPE;
  const verdictKo = connected
    ? `연결된 공급자 ${read("providerName")}의 이미지 모델 ${read("modelName")}: 모델 목록 API에는 나오지 않아 공식 문서 리서치로 찾은 후보입니다(${read("comparableTo") || "현재 이미지 모델"}과 비교).`
    : `미연결 공급자 ${read("providerName")}의 ${read("modelName")}: Tomverse ${PRODUCT_LABEL_KO[product]}의 ${read("comparableTo") || "현재 모델"}에 견줄 만한 후보(웹 리서치 제안).`;
  const pointsKo = [
    `비교 기준: ${read("benchmarkBasisKo")}`,
    `가용 API: ${read("apiAvailabilityKo")}`,
    `대략 가격: ${read("pricingKo")}`,
    `근거 ${citations.length}건: ${citations.join(" ")}`,
  ];
  const nextStepKo = connected
    ? "이미지 카탈로그로 들이려면 이 공급자의 이미지 어댑터가 있어야 합니다. 있으면 이미지·코딩 카탈로그에서 초안을 만들고, 없으면 어댑터 작업을 따로 정하거나 제외합니다."
    : "공급자 연결(API 키·어댑터·약관·가격 검증)이 먼저 필요해 여기서 바로 채택할 수 없습니다. 연결할 가치가 있으면 연결 작업을 따로 정하고, 아니면 제외합니다.";
  return {
    product,
    connected,
    providerName: read("providerName"),
    citations,
    verdictKo,
    pointsKo,
    nextStepKo,
    analysisKo: [verdictKo, ...pointsKo, nextStepKo].join(" "),
  };
};

/**
 * The ISO week a run belongs to, in Brisbane time (UTC+10, no daylight
 * saving): the weekly claim key, so the first daily scan of each week runs the
 * research and the other six do not.
 */
export const brisbaneIsoWeek = (at: Date) => {
  const local = new Date(at.getTime() + 10 * 60 * 60 * 1000);
  const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
};
