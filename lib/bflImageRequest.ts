import type { ImageSize } from "@/lib/imageGenerationPricing";

// Pure request/response shaping for FLUX 3 image models called directly on
// the Black Forest Labs API, kept out of lib/imageProviderAdapter.ts so what
// decides the bill is testable without a network. Read on 2026-11-16 against
// the API's own OpenAPI document (https://api.bfl.ai/openapi.json), the
// integration guidelines and the price page:
//   https://docs.bfl.ai/api_integration/integration_guidelines
//   https://bfl.ai/pricing
//
// The seeded FLUX 3 models need a provider budget to run in production.
// Single-photo edits use the same per-image price and are opt-in through
// IMAGE_BFL_EDIT_ENABLED.
//
// The API is asynchronous. A POST submits a task and answers with an id and a
// `polling_url`; the result is read from that URL until it says `Ready`, and
// the image itself is a signed link valid for ten minutes that BFL says is
// "not meant to be served directly to end users". So, like fal and Qwen, what
// comes back is a link, and a link is worth exactly as much as the checks
// applied to it.

/** The global endpoint. It routes across clusters; polling must use the URL it returns. */
export const BFL_API_BASE = "https://api.bfl.ai";

/** `x-key: $BFL_API_KEY`, not a bearer token. */
export const BFL_API_KEY_HEADER = "x-key";

/**
 * The FLUX 3 image endpoints whose request schema and price were read. Both
 * are billed per image by resolution tier with prompts and references "included
 * at no extra charge", and "Rejected requests, failed generations and outputs
 * withheld by moderation are not charged" (price page FAQ, 2026-11-16).
 *
 * FLUX.2 and FLUX.1 are not here: FLUX.2 is billed per megapixel with a
 * different schema, and an endpoint whose body this module has not pinned must
 * build no request rather than be sent a guess.
 */
export const BFL_FLUX3_IMAGE_MODELS = ["flux-3-image", "flux-3-image-klein"] as const;
export const BFL_FLUX3_IMAGE_EDIT_COST = {
  "flux-3-image": 48_000,
  "flux-3-image-klein": 9_000,
} as const;

export type BflFlux3ImageModel = (typeof BFL_FLUX3_IMAGE_MODELS)[number];

export const isBflFlux3ImageModel = (apiModelId: unknown): apiModelId is BflFlux3ImageModel =>
  typeof apiModelId === "string" && (BFL_FLUX3_IMAGE_MODELS as readonly string[]).includes(apiModelId);

/** The submit URL for a pinned endpoint. Never built from an unlisted id. */
export const bflSubmitUrl = (apiModelId: BflFlux3ImageModel) => `${BFL_API_BASE}/v1/${apiModelId}`;

/**
 * Whether a URL is on Black Forest Labs' own domain.
 *
 * Both URLs this integration follows come out of a provider response: the
 * `polling_url`, which is sent the API key, and the result's signed image link.
 * Regional hosts (`api.eu.bfl.ai`, `api.us.bfl.ai`) and delivery hosts
 * (`delivery.*.bfl.ai`, whose region labels "may change") all sit under
 * bfl.ai, so the registrable suffix is the check rather than a host we have
 * seen. Anything else would turn a response body into a request we make on
 * its behalf -- with our key attached, in the polling case.
 */
export const isBflUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    !url.username &&
    !url.password &&
    url.hostname.endsWith(".bfl.ai")
  );
};

/**
 * The tier the price page sells. `1k` at 1:1 is the 1K square ($0.048 for
 * FLUX 3 Image on 2026-11-16). Sent as a tier rather than as width and
 * height, because the tier is what is priced and exact dimensions "vary with
 * the aspect ratio"; the adapter checks the returned file is 1024x1024.
 */
const TIER_BY_SIZE: Partial<Record<ImageSize, { resolution: "1k"; aspect_ratio: "1:1" }>> = {
  "1024x1024": { resolution: "1k", aspect_ratio: "1:1" },
};

/**
 * Harm moderation tolerance, 0 strictest to 7. 2 is BFL's default, stated
 * rather than inherited: moderation posture is a decision.
 */
export const BFL_SAFETY_TOLERANCE = 2;

export type BflImageRequestInput = {
  apiModelId: string;
  /** The only field that carries user text. */
  prompt: string;
  size: ImageSize;
  referenceBase64?: string;
};

/**
 * The request body, or null for an endpoint or size with no pinned mapping.
 *
 * - `aspect_ratio: "1:1"`: its default is `auto`, which lets the prompt pick
 *   the shape of an image priced as a square.
 * - `grounding: false` (FLUX 3 Image): its default is true, which may send the
 *   prompt to web and image search. The user's text goes to BFL and nowhere
 *   it chooses to forward it.
 * - `version: "latest"` (FLUX 3 Image): the only value the schema offers today.
 *   Stated so the audit record says which release line was asked for; a dated
 *   tag can be pinned here once BFL publishes one.
 * - `output_format: "png"` (Klein): FLUX 3 Image has no such field, so its
 *   type is read from the delivered file, never assumed.
 * - A photo edit sends one inline reference. The user identifier stays local.
 */
export const buildBflImageRequest = (
  input: BflImageRequestInput
): Record<string, unknown> | null => {
  if (!isBflFlux3ImageModel(input.apiModelId)) return null;
  const tier = TIER_BY_SIZE[input.size];
  if (!tier) return null;
  const common = {
    prompt: input.prompt,
    aspect_ratio: tier.aspect_ratio,
    resolution: tier.resolution,
    safety_tolerance: BFL_SAFETY_TOLERANCE,
    ...(input.referenceBase64 ? { images: [input.referenceBase64] } : {}),
  };
  if (input.apiModelId === "flux-3-image") {
    return { ...common, grounding: false, version: "latest" };
  }
  return { ...common, output_format: "png" };
};

export type BflSubmitted = {
  id: string;
  pollingUrl: string;
  /** What BFL says the task costs, in its credits ($0.01 each), for the record. */
  usage: Record<string, number> | null;
};

const finiteOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** The submitted task, or null when the answer is not one this code can follow. */
export const parseBflSubmitResponse = (payload: unknown): BflSubmitted | null => {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim()) return null;
  if (!isBflUrl(record.polling_url)) return null;
  const usage: Record<string, number> = {};
  for (const key of ["cost", "input_mp", "output_mp"] as const) {
    const value = finiteOrNull(record[key]);
    if (value !== null) usage[key] = value;
  }
  return { id: record.id, pollingUrl: record.polling_url, usage: Object.keys(usage).length ? usage : null };
};

/** Still working: poll again. */
const PENDING_STATUSES = new Set(["Pending", "Reasoning", "Generating"]);
/** Withheld by moderation, which the price page says is not charged. */
const MODERATED_STATUSES = new Set(["Request Moderated", "Content Moderated"]);

export type BflPollState =
  | { state: "pending" }
  | { state: "ready"; sampleUrl: string; usage: Record<string, number> | null }
  | { state: "moderated"; status: string }
  | { state: "failed"; status: string };

/**
 * One poll answer, classified. Anything not listed -- `Error`, `Task not
 * found`, `No Card Generated`, a status added after 2026-11-16, or a `Ready`
 * without a link on bfl.ai -- is a failure, never a reason to keep waiting.
 */
export const parseBflPollResponse = (payload: unknown): BflPollState => {
  if (!payload || typeof payload !== "object") return { state: "failed", status: "unreadable" };
  const record = payload as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status : "";
  if (PENDING_STATUSES.has(status)) return { state: "pending" };
  if (MODERATED_STATUSES.has(status)) return { state: "moderated", status };
  if (status !== "Ready") return { state: "failed", status: status || "missing" };
  const result = record.result;
  const sample =
    result && typeof result === "object" ? (result as Record<string, unknown>).sample : undefined;
  if (!isBflUrl(sample)) return { state: "failed", status: "Ready without a bfl.ai sample" };
  const cost = finiteOrNull(record.cost);
  return { state: "ready", sampleUrl: sample, usage: cost === null ? null : { settled_cost: cost } };
};

/**
 * How long to wait between polls. BFL's own examples poll every half second;
 * one second keeps a 1K image's latency while halving the calls.
 */
export const BFL_POLL_INTERVAL_MS = 1_000;
