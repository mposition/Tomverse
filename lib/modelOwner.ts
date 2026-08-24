/**
 * Who made a model, as distinct from which catalogue we happened to see it in.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md ML-13.
 *
 * The daily report used to label every discovered model with the provider whose
 * catalogue the scan read, which produced lines like "Qwen ZHIPU/GLM-5.3" and
 * "Qwen kimi-k3". Read plainly, those sentences say Qwen built GLM and built
 * Kimi. Triage then starts from a false premise, and combined with the
 * candidate collapse the same model turns up under a different name on a
 * different day.
 *
 * ## Why the family token wins over the path prefix
 *
 * An aggregator's route is a namespace, not a claim of authorship.
 * `perplexity/deepseek-v4-pro-0813` is DeepSeek's model on Perplexity's route,
 * and reading the prefix as ownership would relabel half the industry's models
 * as Perplexity's. So the name is matched first and the prefix is only ever a
 * tie-breaker for a name that says nothing on its own.
 *
 * ## Why unknown is a real answer
 *
 * A model whose name matches nothing is reported as `unknown`, not as the
 * provider that listed it. The label exists so a person can trust the first
 * line of a triage; a guess dressed as a fact is worse than an admission,
 * because nothing downstream would ever correct it.
 */

export type ModelOwner =
  | "openai"
  | "anthropic"
  | "google"
  | "meta"
  | "xai"
  | "deepseek"
  | "mistral"
  | "moonshot"
  | "minimax"
  | "alibaba"
  | "zhipu"
  | "perplexity"
  | "cohere"
  | "microsoft"
  | "nvidia"
  | "unknown";

/**
 * Model-name tokens and the organisation that publishes them.
 *
 * Matched against the name with its vendor path removed, so a prefix cannot
 * decide the answer. Ordered longest-first at match time rather than here, so
 * an entry can be appended without thinking about where it goes.
 */
const FAMILY_TOKENS: ReadonlyArray<readonly [string, ModelOwner]> = [
  ["gpt-", "openai"],
  ["o1-", "openai"],
  ["o3-", "openai"],
  ["o4-", "openai"],
  ["chatgpt", "openai"],
  ["dall-e", "openai"],
  ["whisper", "openai"],
  ["claude", "anthropic"],
  ["gemini", "google"],
  ["gemma", "google"],
  ["imagen", "google"],
  ["veo", "google"],
  ["llama", "meta"],
  ["grok", "xai"],
  ["deepseek", "deepseek"],
  ["mistral", "mistral"],
  ["mixtral", "mistral"],
  ["magistral", "mistral"],
  ["ministral", "mistral"],
  ["codestral", "mistral"],
  ["devstral", "mistral"],
  ["pixtral", "mistral"],
  ["kimi", "moonshot"],
  ["moonshot", "moonshot"],
  ["minimax", "minimax"],
  ["abab", "minimax"],
  ["qwen", "alibaba"],
  ["qwq", "alibaba"],
  ["glm", "zhipu"],
  ["chatglm", "zhipu"],
  ["sonar", "perplexity"],
  ["command-", "cohere"],
  ["command_", "cohere"],
  ["phi-", "microsoft"],
  ["nemotron", "nvidia"],
];

/**
 * Path prefixes that name an organisation rather than a route.
 *
 * Consulted only when the name matched nothing, and only for prefixes that are
 * organisations in their own right. A prefix belonging to a host that serves
 * other people's models is deliberately absent: `groq/`, `perplexity/` and
 * `openrouter/` say where a request goes, not who wrote the weights.
 */
const VENDOR_PREFIXES: Readonly<Record<string, ModelOwner>> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  "google-deepmind": "google",
  meta: "meta",
  "meta-llama": "meta",
  xai: "xai",
  deepseek: "deepseek",
  "deepseek-ai": "deepseek",
  mistral: "mistral",
  mistralai: "mistral",
  moonshot: "moonshot",
  moonshotai: "moonshot",
  minimax: "minimax",
  minimaxai: "minimax",
  qwen: "alibaba",
  alibaba: "alibaba",
  zhipu: "zhipu",
  zhipuai: "zhipu",
  thudm: "zhipu",
  cohere: "cohere",
  microsoft: "microsoft",
  nvidia: "nvidia",
};

/** Display names, so a report never prints a bare identifier at a person. */
const OWNER_LABELS: Readonly<Record<ModelOwner, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  meta: "Meta",
  xai: "xAI",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  moonshot: "Moonshot",
  minimax: "MiniMax",
  alibaba: "Alibaba Qwen",
  zhipu: "Zhipu",
  perplexity: "Perplexity",
  cohere: "Cohere",
  microsoft: "Microsoft",
  nvidia: "NVIDIA",
  unknown: "unknown owner",
};

export const modelOwnerLabel = (owner: ModelOwner) => OWNER_LABELS[owner];

/**
 * Splits `vendor/name` without losing either half.
 *
 * The last separator decides where the *name* starts, because a few catalogues
 * nest (`accounts/fireworks/models/llama-v3`) and the model name is always the
 * final segment. Everything before it stays whole, since the vendor may sit
 * anywhere inside it.
 */
const splitApiModel = (apiModel: string) => {
  const trimmed = apiModel.trim();
  const cut = trimmed.lastIndexOf("/");
  return {
    prefix: cut === -1 ? "" : trimmed.slice(0, cut).toLowerCase(),
    name: (cut === -1 ? trimmed : trimmed.slice(cut + 1)).toLowerCase(),
  };
};

/**
 * The organisation that made the model an API identifier names.
 *
 * Never falls back to the scanning provider: an unrecognised name is
 * `unknown`, and that is the whole point of the function.
 */
export const modelOwner = (apiModel: string): ModelOwner => {
  const { prefix, name } = splitApiModel(apiModel);
  if (!name) return "unknown";

  // Longest token first, so `chatglm` is not decided by `glm` and `chatgpt` is
  // not decided by `gpt-`. Two families sharing a substring is the ordinary
  // case, not an exception.
  const matched = [...FAMILY_TOKENS]
    .sort(([a], [b]) => b.length - a.length)
    .find(([token]) => name.includes(token));
  if (matched) return matched[1];

  // Only now the prefix, and only where a segment names an organisation. Every
  // segment is considered because the vendor is not reliably the last one:
  // `accounts/deepseek-ai/models/r2-preview` buries it in the middle. Scanned
  // right to left so the segment nearest the model wins if a path somehow names
  // two.
  for (const segment of prefix.split("/").reverse()) {
    const owner = VENDOR_PREFIXES[segment];
    if (owner) return owner;
  }
  return "unknown";
};

/**
 * The owner of a model, as a phrase a report can print.
 *
 * Separate from `modelOwner` so a caller that wants the identifier -- to group
 * by, or to compare -- is not parsing English back out of a sentence.
 */
export const modelOwnerPhrase = (apiModel: string) =>
  modelOwnerLabel(modelOwner(apiModel));
