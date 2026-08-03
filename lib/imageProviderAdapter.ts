import "server-only";

import {
  IMAGE_GENERATION_MODEL_ID,
  type ImageQuality,
  type ImageSize,
} from "@/lib/imageGenerationPricing";
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
  /** Provider-reported text input tokens; 0 when the response omits usage. */
  inputTokens: number;
  providerRequestId: string | null;
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

export const generateImageWithProvider = async (input: {
  prompt: string;
  size: ImageSize;
  quality: ImageQuality;
}): Promise<ImageProviderResult> => {
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
          model: IMAGE_GENERATION_MODEL_ID,
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
      usage?: { input_tokens?: number };
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
      inputTokens,
      providerRequestId,
    };
  }

  throw (
    lastError ??
    new ImageProviderError("provider_failed", "Image provider request failed.")
  );
};
