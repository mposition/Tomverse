import "server-only";

import {
  IMAGE_GENERATION_MODEL_ID,
  type ImageQuality,
  type ImageSize,
} from "@/lib/imageGenerationPricing";
import { getImageModel } from "@/lib/imageModelRegistry";
import type { ImageGenerationFailurePhase } from "@/lib/imageGenerationStateCore";

// The OpenAI Images API call, pinned to the parameter allowlist from
// docs/policy/image-generation.md section 5: exact model, three sizes, three
// qualities, opaque background, PNG, default moderation, n=1, no partial
// streaming. Nothing user-controlled reaches the provider except the prompt.
//
// Follows the raw-fetch provider convention (lib/perplexityDeepResearch.ts)
// rather than the ai-sdk factory: the Images API is a single non-streaming
// POST and the ai-sdk wrapper adds nothing here. The raw `openai` npm
// package stays unused on purpose -- one HTTP call does not need a client
// library's retry/config surface.

const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";

// A complex request can run up to ~2 minutes provider-side; the ceiling
// leaves room for that plus network without letting a hung call outlive the
// lease heartbeat forever.
const PROVIDER_TIMEOUT_MS = 150_000;

// Bounded: one initial attempt plus two retries on 429/5xx/network, with
// jittered backoff. Anything still failing after that surfaces to the caller
// for refund. User errors and moderation blocks are never retried.
const RETRY_DELAYS_MS = [1_000, 3_000];

export class ImageProviderError extends Error {
  constructor(
    public readonly failurePhase: Extract<
      ImageGenerationFailurePhase,
      | "provider_moderation_rejected"
      | "provider_user_error"
      | "provider_rate_limited"
      | "provider_failed"
    >,
    message: string,
    public readonly status: number | null = null,
    public readonly providerRequestId: string | null = null
  ) {
    super(message);
    this.name = "ImageProviderError";
  }
}

/**
 * Pure classification so tests can pin the mapping without a network. The
 * moderation match is deliberately broad (code or message): a safety block
 * must never be retried or billed to the user as a generic failure.
 */
export const classifyImageProviderFailure = (
  status: number,
  body: unknown
): ImageProviderError["failurePhase"] => {
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return "provider_failed";
  const error =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: { code?: unknown; message?: unknown; type?: unknown } })
          .error
      : undefined;
  const haystack = [error?.code, error?.type, error?.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (
    haystack.includes("moderation") ||
    haystack.includes("content_policy") ||
    haystack.includes("content policy") ||
    haystack.includes("safety")
  ) {
    return "provider_moderation_rejected";
  }
  // 401/403 are Tomverse configuration problems, not something the user did.
  if (status === 401 || status === 403) return "provider_failed";
  return "provider_user_error";
};

export type ImageProviderResult = {
  imageBytes: Buffer;
  /**
   * The MIME type the provider actually returned. Never assumed: policy v2
   * section 12 requires the original bytes to be stored unmodified, and a
   * provider that answers WebP must not be filed as PNG.
   */
  mimeType: string;
  /** Provider-reported text input tokens; 0 when the response omits usage. */
  inputTokens: number;
  /**
   * Billable internal reasoning tokens, when the provider charges for them.
   * 0 for models that do not (OpenAI images). Recorded so settlement can
   * compare the fixed price against the real cost.
   */
  thinkingTokens: number;
  /** Provider-reported output/image tokens; 0 when the response omits usage. */
  outputTokens: number;
  providerRequestId: string | null;
  /** What the bytes carry, for the workspace's provenance label. */
  provenance: readonly ("c2pa" | "synthid")[];
};

const getImageApiKey = () => {
  // A dedicated image project key isolates spend attribution and key blast
  // radius (rate limits are organisation-level either way -- policy §7);
  // the chat key is the fallback so development works with one key.
  const key =
    process.env.OPENAI_IMAGE_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new ImageProviderError(
      "provider_failed",
      "Image provider is not configured."
    );
  }
  return key;
};

const wait = (ms: number) =>
  new Promise((resolveWait) => setTimeout(resolveWait, ms));

/**
 * Dispatch by registry model. A model on a fail-closed hold (an unverified
 * price, an unbounded worst case) is refused here as well as at admission:
 * the adapter is the last place a request could still reach a provider we
 * cannot price, so it re-checks rather than trusting the caller.
 */
export const generateImageWithProvider = async (input: {
  prompt: string;
  size: ImageSize;
  quality: ImageQuality;
  modelId?: string;
}): Promise<ImageProviderResult> => {
  const modelId = input.modelId ?? IMAGE_GENERATION_MODEL_ID;
  const model = getImageModel(modelId);
  if (!model || model.disabledReason !== null) {
    throw new ImageProviderError(
      "provider_failed",
      `Image model ${modelId} is not available for requests.`
    );
  }
  if (model.provider !== "openai") {
    // Google's adapter lands with its price verification (policy section 12):
    // shipping an executable path to a model whose cost is unbounded is
    // exactly what the hold exists to prevent.
    throw new ImageProviderError(
      "provider_failed",
      `No adapter is implemented for provider ${model.provider}.`
    );
  }
  const apiKey = getImageApiKey();
  let lastError: ImageProviderError | null = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      const base = RETRY_DELAYS_MS[attempt - 1];
      await wait(base + Math.floor(Math.random() * 500));
    }
    let response: Response;
    try {
      response = await fetch(OPENAI_IMAGES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: model.apiModelId,
          prompt: input.prompt,
          size: input.size,
          quality: input.quality,
          background: "opaque",
          output_format: "png",
          moderation: "auto",
          n: 1,
        }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = new ImageProviderError(
        "provider_failed",
        error instanceof Error && error.name === "TimeoutError"
          ? "Image provider request timed out."
          : "Image provider request failed."
      );
      continue;
    }

    const providerRequestId = response.headers.get("x-request-id");
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const failurePhase = classifyImageProviderFailure(response.status, body);
      const error = new ImageProviderError(
        failurePhase,
        `Image provider rejected the request (HTTP ${response.status}).`,
        response.status,
        providerRequestId
      );
      if (
        failurePhase === "provider_rate_limited" ||
        failurePhase === "provider_failed"
      ) {
        lastError = error;
        continue;
      }
      throw error;
    }

    const payload = (await response.json().catch(() => null)) as {
      data?: Array<{ b64_json?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    } | null;
    const b64 = payload?.data?.[0]?.b64_json;
    if (!b64) {
      throw new ImageProviderError(
        "provider_failed",
        "Image provider returned no image payload.",
        response.status,
        providerRequestId
      );
    }
    const inputTokens = Number.isSafeInteger(payload?.usage?.input_tokens)
      ? Number(payload?.usage?.input_tokens)
      : 0;
    return {
      imageBytes: Buffer.from(b64, "base64"),
      // The request pins output_format: "png", so this is the format the
      // provider was told to produce -- still stated explicitly rather than
      // assumed downstream.
      mimeType: "image/png",
      inputTokens,
      thinkingTokens: 0,
      outputTokens: Number.isSafeInteger(payload?.usage?.output_tokens)
        ? Number(payload?.usage?.output_tokens)
        : 0,
      providerRequestId,
      provenance: ["c2pa"],
    };
  }

  throw (
    lastError ??
    new ImageProviderError("provider_failed", "Image provider request failed.")
  );
};
