import "server-only";

import {
  IMAGE_GENERATION_MODEL_ID,
  type ImageQuality,
  type ImageSize,
} from "@/lib/imageGenerationPricing";
import { getImageModel, type ImageModelProfile } from "@/lib/imageModelRegistry";
import { readImageDimensions } from "@/lib/imageDimensions";
import type { ImageGenerationFailurePhase } from "@/lib/imageGenerationStateCore";
import {
  buildXaiImageRequest,
  parseXaiImageResponse,
  XAI_IMAGES_URL,
} from "@/lib/xaiImageRequest";

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
    public readonly providerRequestId: string | null = null,
    /**
     * The parameters the failed call sent, prompt excluded. A failure is
     * exactly when someone needs to know what was asked for, and after the
     * throw the body is otherwise gone.
     */
    public readonly requestParams: Record<string, unknown> | null = null
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
  /**
   * Pixel dimensions read from the returned file's own header, or null when
   * they could not be read. Never inferred from the requested size: each
   * provider translates a resolution tier its own way (policy §12.1).
   */
  outputWidth: number | null;
  outputHeight: number | null;
  /**
   * Exactly the parameters this call sent, prompt excluded (policy §12.1).
   * Taken from the body that was serialised rather than rebuilt, so the audit
   * record cannot drift from the request it claims to describe.
   */
  requestParams: Record<string, unknown>;
};

const getXaiApiKey = () => {
  const key = process.env.XAI_API_KEY?.trim();
  if (!key) {
    throw new ImageProviderError(
      "provider_failed",
      "Image provider is not configured."
    );
  }
  return key;
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

/**
 * The audit view of a request body: everything except the prompt, which is
 * already stored on the generation row and must not be duplicated into a blob
 * that deletion would then have to find twice.
 */
const auditableRequestParams = (
  body: Record<string, unknown>
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(body).filter(([key]) => key !== "prompt")
  );

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
  if (model.provider === "xai") {
    return generateWithXai(model, input);
  }
  if (model.provider !== "openai") {
    // Google's adapter lands with its thinking cap (policy section 12):
    // shipping an executable path to a model whose worst-case cost is not
    // provably finite is exactly what the hold exists to prevent.
    throw new ImageProviderError(
      "provider_failed",
      `No adapter is implemented for provider ${model.provider}.`
    );
  }
  const openAiBody = {
    model: model.apiModelId,
    prompt: input.prompt,
    size: input.size,
    quality: input.quality,
    background: "opaque",
    output_format: "png",
    moderation: "auto",
    n: 1,
  };
  const requestParams = auditableRequestParams(openAiBody);
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
        body: JSON.stringify(openAiBody),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = new ImageProviderError(
        "provider_failed",
        error instanceof Error && error.name === "TimeoutError"
          ? "Image provider request timed out."
          : "Image provider request failed.",
        null,
        null,
        requestParams
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
        providerRequestId,
        requestParams
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
        providerRequestId,
        requestParams
      );
    }
    const inputTokens = Number.isSafeInteger(payload?.usage?.input_tokens)
      ? Number(payload?.usage?.input_tokens)
      : 0;
    const imageBytes = Buffer.from(b64, "base64");
    // The request pins output_format: "png", so this is the format the
    // provider was told to produce -- still stated explicitly rather than
    // assumed downstream.
    const mimeType = "image/png";
    const dimensions = readImageDimensions(imageBytes, mimeType);
    return {
      imageBytes,
      mimeType,
      inputTokens,
      thinkingTokens: 0,
      outputTokens: Number.isSafeInteger(payload?.usage?.output_tokens)
        ? Number(payload?.usage?.output_tokens)
        : 0,
      providerRequestId,
      provenance: ["c2pa"],
      outputWidth: dimensions?.width ?? null,
      outputHeight: dimensions?.height ?? null,
      requestParams,
    };
  }

  throw (
    lastError ??
    new ImageProviderError("provider_failed", "Image provider request failed.")
  );
};

/**
 * xAI's image API. Same retry and classification policy as the OpenAI path,
 * different request shape and a different truth about the response MIME.
 *
 * Three things this path does that the OpenAI one does not:
 *   * refuses a size it has no mapping for, rather than sending a resolution
 *     the approved credits were not priced for;
 *   * takes the MIME from the response, because xAI is not told which format
 *     to produce and its documented example answers JPEG;
 *   * reports zero tokens as a verified fact, not a gap -- xAI's pricing is
 *     flat per image with no prompt-token or reasoning-token charge
 *     (verified 2026-08-04), so there is nothing to normalise.
 */
const generateWithXai = async (
  model: ImageModelProfile,
  input: { prompt: string; size: ImageSize }
): Promise<ImageProviderResult> => {
  const body = buildXaiImageRequest({
    apiModelId: model.apiModelId,
    prompt: input.prompt,
    size: input.size,
  });
  if (!body) {
    throw new ImageProviderError(
      "provider_failed",
      `Image size ${input.size} has no xAI resolution mapping.`
    );
  }
  const requestParams = auditableRequestParams(body);
  const apiKey = getXaiApiKey();
  let lastError: ImageProviderError | null = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      const base = RETRY_DELAYS_MS[attempt - 1];
      await wait(base + Math.floor(Math.random() * 500));
    }
    let response: Response;
    try {
      response = await fetch(XAI_IMAGES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = new ImageProviderError(
        "provider_failed",
        error instanceof Error && error.name === "TimeoutError"
          ? "Image provider request timed out."
          : "Image provider request failed.",
        null,
        null,
        requestParams
      );
      continue;
    }

    const providerRequestId =
      response.headers.get("x-request-id") ?? response.headers.get("x-xai-request-id");
    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      const failurePhase = classifyImageProviderFailure(response.status, errorBody);
      const error = new ImageProviderError(
        failurePhase,
        `Image provider rejected the request (HTTP ${response.status}).`,
        response.status,
        providerRequestId,
        requestParams
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

    const parsed = parseXaiImageResponse(
      await response.json().catch(() => null)
    );
    if (!parsed) {
      throw new ImageProviderError(
        "provider_failed",
        "Image provider returned no usable image payload.",
        response.status,
        providerRequestId,
        requestParams
      );
    }
    const imageBytes = Buffer.from(parsed.imageBase64, "base64");
    const dimensions = readImageDimensions(imageBytes, parsed.mimeType);
    return {
      imageBytes,
      mimeType: parsed.mimeType,
      inputTokens: 0,
      thinkingTokens: 0,
      outputTokens: 0,
      providerRequestId,
      // Verified absent 2026-08-04: xAI documents no watermark, C2PA or
      // metadata guarantee. Claiming provenance the bytes may not carry would
      // be worse than claiming none.
      provenance: [],
      outputWidth: dimensions?.width ?? null,
      outputHeight: dimensions?.height ?? null,
      requestParams,
    };
  }

  throw (
    lastError ??
    new ImageProviderError("provider_failed", "Image provider request failed.")
  );
};
