import "server-only";

import {
  IMAGE_GENERATION_MODEL_ID,
  imageModelSupportsEdit,
  type ImageQuality,
  type ImageSize,
} from "@/lib/imageGenerationPricing";
import {
  getImageModel,
  GOOGLE_IMAGE_OUTPUT_LIMIT_MARGIN,
  googleImageOutputLimitBound,
  imageDeliveryMimeType,
  imageThinkingCapEnforced,
  type ImageModelProfile,
} from "@/lib/imageModelRegistry";
import { BoundedBufferError, readResponseToBuffer } from "@/lib/boundedBuffer";
import { readImageDimensions } from "@/lib/imageDimensions";
import {
  buildFalImageEditRequest,
  buildFalImageRequest,
  falAuthorizationHeader,
  falEndpointUrl,
  falPlatformHeaders,
  falAssetLengthRefused,
  FAL_MAX_ASSET_BYTES,
  isFalAssetUrl,
  parseFalImageResponse,
} from "@/lib/falImageRequest";
import { resolveProviderApiKey } from "@/lib/modelRegistryShared";
import {
  IMAGE_PROVIDER_RETRY_DELAYS_MS,
  IMAGE_PROVIDER_TIMEOUT_MS,
  type ImageGenerationFailurePhase,
} from "@/lib/imageGenerationStateCore";
import {
  buildGoogleImageRequest,
  GOOGLE_API_KEY_HEADER,
  GOOGLE_INTERACTIONS_URL,
  googleBilledImageTokens,
  googleNonImageBillableTokens,
  parseGoogleImageResponse,
  readGoogleImageInteraction,
} from "@/lib/googleImageRequest";
import {
  buildQwenImageRequest,
  isQwenAssetUrl,
  parseQwenImageResponse,
  QWEN_IMAGE_GENERATION_URL,
  qwenErrorEnvelope,
  qwenFailurePhase,
  qwenRequestId,
} from "@/lib/qwenImageRequest";
import {
  buildXaiImageEditRequest,
  buildXaiImageRequest,
  parseXaiImageResponse,
  XAI_IMAGE_EDITS_URL,
  XAI_IMAGES_URL,
  xaiReportedCostMicroUsd,
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
const OPENAI_IMAGE_EDITS_URL = "https://api.openai.com/v1/images/edits";

/**
 * The photo an edit changes, already downscaled and re-encoded by the caller
 * (lib/imageEditSource.ts). Only its description reaches the audit record.
 */
export type ImageEditInput = {
  bytes: Buffer;
  mimeType: "image/png";
  width: number;
  height: number;
  sha256: string;
};

// A complex request can run up to ~2 minutes provider-side; the ceiling
// leaves room for that plus network without letting a hung call outlive the
// lease heartbeat forever. One initial attempt plus two retries on
// 429/5xx/network, with jittered backoff; anything still failing after that
// surfaces to the caller for refund, and user errors and moderation blocks
// are never retried.
//
// Both numbers live in the state core, because the stale threshold and the
// executor's route budget are derived from them and have to move together.
const PROVIDER_TIMEOUT_MS = IMAGE_PROVIDER_TIMEOUT_MS;
const RETRY_DELAYS_MS = IMAGE_PROVIDER_RETRY_DELAYS_MS;

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

  /**
   * Billable output and thinking tokens of a response that was billed and
   * still refused (a Google response that stopped without its image). Null
   * everywhere else. Lets the failure settle what was spent past the reservation.
   */
  nonImageBillableTokens: number | null = null;

  /**
   * What the refused response billed as images: its image tokens, or null when
   * it reported none, and the images its model output carried (0 or several).
   */
  billedImageTokens: number | null = null;
  billedImageCount = 0;
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

/**
 * Splits an edit's reported input into its text and image parts. With no
 * breakdown, every input token is counted as an image token -- the dearer
 * rate, so a missing field never under-settles the cost. With no usage at all
 * the image part is unknown (null), and settlement then charges the photo's
 * whole reserved budget rather than nothing.
 */
export const openAiEditInputTokens = (
  totalInputTokens: number | null,
  details: { text_tokens?: number; image_tokens?: number } | undefined
): { textTokens: number; imageTokens: number | null } => {
  const image = details?.image_tokens;
  if (!Number.isSafeInteger(image) || (image as number) < 0) {
    return totalInputTokens === null
      ? { textTokens: 0, imageTokens: null }
      : { textTokens: 0, imageTokens: Math.max(0, totalInputTokens) };
  }
  const text = details?.text_tokens;
  return {
    imageTokens: image as number,
    textTokens: Number.isSafeInteger(text) && (text as number) >= 0
      ? (text as number)
      : Math.max(0, (totalInputTokens ?? 0) - (image as number)),
  };
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
   * Image input tokens an edit's photo was billed as. Absent for a
   * generation; on an edit, `inputTokens` is then the text part alone, and
   * null means the response reported no usage to read it from.
   */
  imageInputTokens?: number | null;
  /**
   * What the provider said the whole request cost, micro-USD, where it says
   * (xAI). Compared against what an edit reserved; never what settles.
   */
  reportedCostMicroUsd?: number | null;
  /**
   * Billable internal reasoning tokens, when the provider charges for them.
   * 0 for models that do not (OpenAI images). Recorded so settlement can
   * compare the fixed price against the real cost.
   */
  thinkingTokens: number;
  /**
   * Billable output and thinking tokens that are not the image, for a model
   * priced on a measured token bound (Google direct). Absent elsewhere.
   */
  nonImageBillableTokens?: number | null;
  /** Image tokens the response billed, for the same models; null when not reported. */
  billedImageTokens?: number | null;
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

const getGoogleApiKey = () => {
  // The same key the chat Google provider uses. There is no image-scoped
  // variable here the way OPENAI_IMAGE_API_KEY exists for OpenAI; splitting
  // spend attribution is a separate operational decision, not something to
  // invent an environment name for.
  //
  // Resolved from the shared alias list rather than an inline pair: this
  // module accepting GEMINI_API_KEY while the chat client and the status
  // surface did not is how image generation came to work in a deployment
  // that reported Google as unconfigured.
  const key = resolveProviderApiKey("google");
  if (!key) {
    throw new ImageProviderError(
      "provider_failed",
      "Image provider is not configured."
    );
  }
  return key;
};

/**
 * fal's key, deliberately not in PROVIDER_API_KEY_ENV_NAMES.
 *
 * That table is the chat providers': everything in it appears in the model
 * catalogue, in provider status and in chat readiness. fal serves no chat
 * model, and adding it there to save a function would have it reported as an
 * unconfigured chat provider on every deployment that does not use images.
 *
 * `FAL_KEY` is the name fal's own documentation uses.
 */
const getFalApiKey = () => {
  const key = process.env.FAL_KEY?.trim();
  if (!key) {
    throw new ImageProviderError(
      "provider_failed",
      "Image provider is not configured."
    );
  }
  return key;
};

/** The key the Qwen chat provider uses (DASHSCOPE_API_KEY); no image-scoped name is invented. */
const getQwenApiKey = () => {
  const key = resolveProviderApiKey("qwen");
  if (!key) {
    throw new ImageProviderError(
      "provider_failed",
      "Image provider is not configured."
    );
  }
  return key;
};

const getXaiApiKey = () => {
  const key = resolveProviderApiKey("xai");
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
    resolveProviderApiKey("openai");
  if (!key) {
    throw new ImageProviderError(
      "provider_failed",
      "Image provider is not configured."
    );
  }
  return key;
};

/**
 * Every field name any provider here carries the user's prompt in.
 *
 * OpenAI and xAI call it `prompt`; Google's Interactions API calls it `input`.
 * Filtering only `prompt` was correct until it silently stopped being -- the
 * Google body would have passed its prompt straight through into the stored
 * audit blob. The set is the guard, so adding a provider means adding its name
 * here rather than remembering that this filter exists.
 */
const PROMPT_FIELD_NAMES = new Set(["prompt", "input"]);

/**
 * The audit view of a request body: everything except the prompt, which is
 * already stored on the generation row and must not be duplicated into a blob
 * that deletion would then have to find twice (policy §10, §12.1).
 */
const auditableRequestParams = (
  body: Record<string, unknown>
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(body).filter(([key]) => !PROMPT_FIELD_NAMES.has(key))
  );

/**
 * The audit view of an edit's photo: described, never stored. The bytes are
 * the user's attachment and already live where deletion finds them.
 */
const editAuditParams = (editImage: ImageEditInput | undefined): Record<string, unknown> =>
  editImage
    ? {
        endpoint: "edits",
        image: {
          mimeType: editImage.mimeType,
          width: editImage.width,
          height: editImage.height,
          byteSize: editImage.bytes.byteLength,
          sha256: editImage.sha256,
        },
      }
    : {};

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
  /** Set for an edit: the photo the prompt changes. */
  editImage?: ImageEditInput;
}): Promise<ImageProviderResult> => {
  const modelId = input.modelId ?? IMAGE_GENERATION_MODEL_ID;
  const model = getImageModel(modelId);
  // An operator hold stops new admissions (the service refuses them); a job
  // already admitted and charged against the provider budget finishes rather
  // than failing after its budget was spent. Price or cost refusals still stop,
  // and so does a model with no price at all: nothing was admitted against it,
  // so there is no job to finish (a seed held before its sale credits exist).
  if (
    !model ||
    model.prices.length === 0 ||
    (model.disabledReason !== null && model.disabledReason !== "operational_hold")
  ) {
    throw new ImageProviderError(
      "provider_failed",
      `Image model ${modelId} is not available for requests.`
    );
  }
  // The thinking cap the reservation priced has to be one this request can
  // hold. Checked here as well as by the judge because a hold replaces the
  // judge's reason with `operational_hold`, which the check above lets through.
  if (!imageThinkingCapEnforced(model)) {
    throw new ImageProviderError(
      "provider_failed",
      `Image model ${modelId} has no thinking cap its request can enforce.`
    );
  }
  // OpenAI, xAI and fal have edit requests. Any other model asked to edit
  // would draw a new picture from the prompt alone -- charged as an edit and
  // ignoring the photo -- so it is refused, as is one whose edit price is held.
  if (
    input.editImage &&
    !(["openai", "xai", "fal"].includes(model.provider) && imageModelSupportsEdit(model.id))
  ) {
    throw new ImageProviderError(
      "provider_failed",
      `Image model ${modelId} cannot edit an image.`
    );
  }
  if (model.provider === "xai") {
    return generateWithXai(model, input);
  }
  if (model.provider === "google") {
    return generateWithGoogle(model, input);
  }
  if (model.provider === "fal") {
    return generateWithFal(model, input);
  }
  if (model.provider === "qwen") {
    return generateWithQwen(model, input);
  }
  if (model.provider !== "openai") {
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
  const editImage = input.editImage;
  const requestParams = { ...auditableRequestParams(openAiBody), ...editAuditParams(editImage) };
  const openAiRequest = (): { url: string; init: RequestInit } => {
    if (!editImage) {
      return {
        url: OPENAI_IMAGES_URL,
        init: {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(openAiBody),
        },
      };
    }
    // The edit endpoint takes multipart form data; fetch writes the boundary.
    const form = new FormData();
    for (const [key, value] of Object.entries(openAiBody)) form.set(key, String(value));
    form.set(
      "image",
      new Blob([new Uint8Array(editImage.bytes)], { type: editImage.mimeType }),
      "image.png"
    );
    return { url: OPENAI_IMAGE_EDITS_URL, init: { body: form } };
  };
  const apiKey = getImageApiKey();
  let lastError: ImageProviderError | null = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      const base = RETRY_DELAYS_MS[attempt - 1];
      await wait(base + Math.floor(Math.random() * 500));
    }
    let response: Response;
    try {
      // Built per attempt: a multipart body is a stream fetch consumes.
      const { url, init } = openAiRequest();
      response = await fetch(url, {
        ...init,
        method: "POST",
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${apiKey}`,
        },
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
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { text_tokens?: number; image_tokens?: number };
      };
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
    const reportedInputTokens = Number.isSafeInteger(payload?.usage?.input_tokens)
      ? Number(payload?.usage?.input_tokens)
      : null;
    const editInput = editImage
      ? openAiEditInputTokens(reportedInputTokens, payload?.usage?.input_tokens_details)
      : null;
    const inputTokens = editInput ? editInput.textTokens : (reportedInputTokens ?? 0);
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
      ...(editInput ? { imageInputTokens: editInput.imageTokens } : {}),
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
 * Google, over the Interactions API.
 *
 * Reachable only for a model in GOOGLE_IMAGE_OUTPUT_LIMIT_BOUNDS whose request
 * is the measured one (that row's output limit, no thinking level), once an
 * operator has priced and enabled it: generateImageWithProvider refuses any
 * model carrying a disabledReason before it dispatches, and any whose thinking
 * cap its request cannot hold (`imageThinkingCapEnforced`). A cap written into
 * a price revision for an unmeasured Google model opens nothing -- only a row
 * in that table can, and a row is a code change backed by a measurement.
 *
 * Only a rate limit is retried. A response that stops without an image
 * (`incomplete`, which the limit causes when reasoning uses the room), a
 * transport failure and a 5xx are not: each may have been billed, and the
 * reservation holds one request's worst case.
 *
 * Differences from the other two adapters, each of which is a way to get it
 * wrong:
 *   * authentication is `x-goog-api-key`, not an OpenAI-style bearer token;
 *   * the request and response vocabulary is the Interactions API's, never
 *     GenerateContent's -- lib/googleImageRequest.ts holds that boundary;
 *   * usage is reported as separate output and thinking counters, and both are
 *     carried through unsummed, because their relationship is the open
 *     question rather than a detail to smooth over.
 */
const generateWithGoogle = async (
  model: ImageModelProfile,
  input: { prompt: string; size: ImageSize }
): Promise<ImageProviderResult> => {
  const body = buildGoogleImageRequest({
    apiModelId: model.apiModelId,
    prompt: input.prompt,
    size: input.size,
    maxOutputTokens: model.maxOutputTokens ?? null,
    thinkingLevel: model.thinkingLevel ?? null,
    deliveryMimeType: imageDeliveryMimeType(model),
  });
  if (!body) {
    throw new ImageProviderError(
      "provider_failed",
      `Image size ${input.size} has no Google request mapping for ${model.id}.`
    );
  }
  const requestParams = auditableRequestParams(body);
  const apiKey = getGoogleApiKey();
  let lastError: ImageProviderError | null = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      const base = RETRY_DELAYS_MS[attempt - 1];
      await wait(base + Math.floor(Math.random() * 500));
    }
    let response: Response;
    try {
      response = await fetch(GOOGLE_INTERACTIONS_URL, {
        method: "POST",
        headers: {
          [GOOGLE_API_KEY_HEADER]: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      // Not retried: a generation that finished and whose response was lost
      // looks exactly like this, and a second attempt would be billed again
      // against a reservation that holds one.
      throw new ImageProviderError(
        "provider_failed",
        error instanceof Error && error.name === "TimeoutError"
          ? "Image provider request timed out."
          : "Image provider request failed.",
        null,
        null,
        requestParams
      );
    }

    const providerRequestId =
      response.headers.get("x-goog-request-id") ??
      response.headers.get("x-request-id");
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
      // Only a rate limit is retried: it is refused before any work is done.
      // A 5xx may follow a generation that was billed, like a lost response.
      if (failurePhase === "provider_rate_limited") {
        lastError = error;
        continue;
      }
      throw error;
    }

    const payload = await response.json().catch(() => null);
    // The thinking cap rests on a measured bound, not a documented one, so a
    // response that bills past it is reported the first time it happens --
    // before the image is looked for, because a response that stopped without
    // one was billed as well.
    const bound = googleImageOutputLimitBound(model.provider, model.apiModelId);
    const nonImageBillableTokens = googleNonImageBillableTokens(payload);
    if (
      bound &&
      nonImageBillableTokens !== null &&
      nonImageBillableTokens > GOOGLE_IMAGE_OUTPUT_LIMIT_MARGIN * bound.maxOutputTokens
    ) {
      console.error(
        JSON.stringify({
          event: "image_google_output_over_measured_bound",
          modelId: model.id,
          maxOutputTokens: bound.maxOutputTokens,
          nonImageBillableTokens,
          providerRequestId,
          timestamp: new Date().toISOString(),
        })
      );
    }
    const parsed = parseGoogleImageResponse(payload);
    if (!parsed) {
      const refused = new ImageProviderError(
        "provider_failed",
        "Image provider returned no usable image payload.",
        response.status,
        providerRequestId,
        requestParams
      );
      refused.nonImageBillableTokens = nonImageBillableTokens;
      refused.billedImageTokens = googleBilledImageTokens(payload);
      refused.billedImageCount = readGoogleImageInteraction(payload)?.modelOutputImageCount ?? 0;
      throw refused;
    }
    const imageBytes = Buffer.from(parsed.imageBase64, "base64");
    const dimensions = readImageDimensions(imageBytes, parsed.mimeType);
    return {
      imageBytes,
      mimeType: parsed.mimeType,
      inputTokens: parsed.usage.inputTokens,
      thinkingTokens: parsed.usage.thinkingTokens,
      nonImageBillableTokens,
      billedImageTokens: googleBilledImageTokens(payload),
      outputTokens: parsed.usage.outputTokens,
      providerRequestId,
      // Google embeds SynthID. C2PA is claimed only where the model card says
      // so, which is why this reads the profile rather than assuming.
      provenance: [...model.provenance],
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
 * An image model through fal (an endpoint in FAL_ENDPOINT_PROFILES, which
 * picks its body): the owner's model, fal's invoice.
 *
 * Three ways this path is deliberately unlike the other three.
 *
 * **It never retries.** The others retry a rate limit or a transport failure
 * because a second attempt costs nothing when the first was not billed. Here
 * the danger is the attempt that *was* billed: a generation that succeeded and
 * whose response was lost looks exactly like a transport failure, and retrying
 * it buys a second image at a second charge while the user pays one fixed
 * price. `X-Fal-No-Retry` says the same thing to fal's own machinery.
 *
 * **The response is a link, not bytes.** So the link is checked before it is
 * followed -- https, a fal CDN host, an allowlisted MIME -- and again on the
 * redirect-resolved response. A URL out of a provider's response body is a
 * request we would be making on its behalf, and the only thing standing
 * between that and an SSRF is this check.
 *
 * **The delivered image is measured against what was priced.** The fixed 120
 * credits are for a 1024x1024 image; a response of another size means the
 * request did not do what its price says it did, and storing it would settle a
 * different product than the one that was sold.
 */
const generateWithFal = async (
  model: ImageModelProfile,
  input: { prompt: string; size: ImageSize; editImage?: ImageEditInput }
): Promise<ImageProviderResult> => {
  const request = {
    // The endpoint picks the schema (FAL_ENDPOINT_PROFILES); an unlisted one builds nothing.
    apiModelId: model.apiModelId,
    prompt: input.prompt,
    size: input.size,
    // PNG for the same reason gpt-image-2 stores PNG: it is lossless, and the
    // response's own content type is still what gets recorded.
    outputFormat: "png" as const,
  };
  const generationBody = buildFalImageRequest(request);
  const body = input.editImage
    ? buildFalImageEditRequest({ ...request, image: input.editImage })
    : generationBody;
  const endpoint = falEndpointUrl(model.apiModelId, Boolean(input.editImage));
  if (!body || !generationBody || !endpoint) {
    throw new ImageProviderError(
      "provider_failed",
      `Image size ${input.size} has no approved fal request for ${model.id}.`
    );
  }
  // From the body without the photo: its data URI is the user's bytes.
  const requestParams = { ...auditableRequestParams(generationBody), ...editAuditParams(input.editImage) };
  const apiKey = getFalApiKey();

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: falAuthorizationHeader(apiKey),
        "Content-Type": "application/json",
        ...falPlatformHeaders(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ImageProviderError(
      "provider_failed",
      error instanceof Error && error.name === "TimeoutError"
        ? "Image provider request timed out."
        : "Image provider request failed.",
      null,
      null,
      requestParams
    );
  }

  const providerRequestId = response.headers.get("x-fal-request-id");
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new ImageProviderError(
      classifyImageProviderFailure(response.status, errorBody),
      `Image provider rejected the request (HTTP ${response.status}).`,
      response.status,
      providerRequestId,
      requestParams
    );
  }

  const parsed = parseFalImageResponse(
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

  let asset: Response;
  try {
    asset = await fetch(parsed.url, {
      // Followed manually so the final host is checked too: an allowlisted URL
      // that redirects elsewhere would otherwise walk straight past the check
      // it just passed.
      redirect: "manual",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    throw new ImageProviderError(
      "provider_failed",
      "Image provider asset could not be downloaded.",
      null,
      providerRequestId,
      requestParams
    );
  }
  // Cancelled, not drained. Both refusals below can be holding a whole image,
  // and this is the one server-side call site where that is true: measured on
  // Node 22.22 / undici 6.24, a response body left unread pins its connection
  // once the body exceeds undici's receive buffer -- the threshold sits between
  // 16 KiB and 64 KiB, so an error body passes through unnoticed and an image
  // does not. `discardResponseBody` is the wrong tool here precisely because it
  // reads: on the size-limit path that would pull the megabytes into memory
  // that the limit exists to refuse.
  const releaseAsset = () => asset.body?.cancel().catch(() => undefined);
  if (!asset.ok || !isFalAssetUrl(asset.url)) {
    await releaseAsset();
    throw new ImageProviderError(
      "provider_failed",
      "Image provider asset was not served from the expected location.",
      asset.status,
      providerRequestId,
      requestParams
    );
  }
  // Before the body is read, not after: a limit enforced once the bytes are
  // already in memory has not limited anything.
  if (falAssetLengthRefused(asset.headers.get("content-length"))) {
    await releaseAsset();
    throw new ImageProviderError(
      "provider_failed",
      "Image provider asset declared a size larger than the accepted limit.",
      null,
      providerRequestId,
      requestParams
    );
  }

  const imageBytes = Buffer.from(await asset.arrayBuffer());
  if (imageBytes.byteLength === 0 || imageBytes.byteLength > FAL_MAX_ASSET_BYTES) {
    throw new ImageProviderError(
      "provider_failed",
      "Image provider asset was empty or larger than the accepted limit.",
      null,
      providerRequestId,
      requestParams
    );
  }

  const dimensions = readImageDimensions(imageBytes, parsed.mimeType);
  const [expectedWidth, expectedHeight] = input.size.split("x").map(Number);
  if (
    !dimensions ||
    dimensions.width !== expectedWidth ||
    dimensions.height !== expectedHeight
  ) {
    throw new ImageProviderError(
      "provider_failed",
      "Image provider returned a different size than the one that was priced.",
      null,
      providerRequestId,
      requestParams
    );
  }

  return {
    imageBytes,
    mimeType: parsed.mimeType,
    // fal reports no token counts on the listed endpoints. Zero here is the honest
    // reading -- there is no usage to record, not a usage of nothing -- and the
    // fixed price is what settlement compares against.
    inputTokens: 0,
    thinkingTokens: 0,
    outputTokens: 0,
    providerRequestId,
    // Google's model, so Google's watermark. Read from the profile rather than
    // asserted about the gateway.
    provenance: [...model.provenance],
    outputWidth: dimensions.width,
    outputHeight: dimensions.height,
    requestParams,
  };
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
  input: { prompt: string; size: ImageSize; editImage?: ImageEditInput }
): Promise<ImageProviderResult> => {
  const request = {
    apiModelId: model.apiModelId,
    prompt: input.prompt,
    size: input.size,
  };
  const generationBody = buildXaiImageRequest(request);
  const body = input.editImage
    ? buildXaiImageEditRequest({ ...request, image: input.editImage })
    : generationBody;
  if (!body || !generationBody) {
    throw new ImageProviderError(
      "provider_failed",
      `Image size ${input.size} has no xAI resolution mapping.`
    );
  }
  // From the body without the photo: its data URL is the user's bytes.
  const requestParams = { ...auditableRequestParams(generationBody), ...editAuditParams(input.editImage) };
  const url = input.editImage ? XAI_IMAGE_EDITS_URL : XAI_IMAGES_URL;
  const apiKey = getXaiApiKey();
  let lastError: ImageProviderError | null = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      const base = RETRY_DELAYS_MS[attempt - 1];
      await wait(base + Math.floor(Math.random() * 500));
    }
    let response: Response;
    try {
      response = await fetch(url, {
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

    const payload = await response.json().catch(() => null);
    const parsed = parseXaiImageResponse(payload);
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
      reportedCostMicroUsd: xaiReportedCostMicroUsd(payload),
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

/**
 * Qwen on Alibaba Cloud Model Studio International: one synchronous call, then
 * the result fetched from the URL it returns (valid 24 hours).
 *
 * Reached only through a runtime catalogue row the judge admitted -- no Qwen
 * model is seeded -- and generation only: the edit check above refuses this
 * provider.
 *
 * Shaped like the fal path, for the same reasons:
 *   * **one attempt.** Billing is per image, and a generation that succeeded
 *     and lost its response looks like a transport failure; a second attempt
 *     would buy a second image the user does not pay for.
 *   * **the result is a link.** It is checked against Singapore's public OSS
 *     endpoint before it is followed and again on the response, with
 *     redirects not followed, so a provider body cannot make this server
 *     fetch an intranet endpoint or anywhere else; the body is read under
 *     fal's 16 MiB limit (the same 1K image), declared or not.
 *   * **the file is measured against what was priced.** Its MIME must be one
 *     the profile may store and its header must say 1024x1024.
 */
const generateWithQwen = async (
  model: ImageModelProfile,
  input: { prompt: string; size: ImageSize }
): Promise<ImageProviderResult> => {
  const body = buildQwenImageRequest({
    apiModelId: model.apiModelId,
    prompt: input.prompt,
    size: input.size,
  });
  if (!body) {
    throw new ImageProviderError(
      "provider_failed",
      `Image size ${input.size} has no Qwen request mapping for ${model.id}.`
    );
  }
  const requestParams = auditableRequestParams(body);
  const apiKey = getQwenApiKey();

  let response: Response;
  try {
    response = await fetch(QWEN_IMAGE_GENERATION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ImageProviderError(
      "provider_failed",
      error instanceof Error && error.name === "TimeoutError"
        ? "Image provider request timed out."
        : "Image provider request failed.",
      null,
      null,
      requestParams
    );
  }

  const payload = await response.json().catch(() => null);
  const providerRequestId = qwenRequestId(payload);
  if (!response.ok) {
    throw new ImageProviderError(
      qwenFailurePhase(payload) ??
        classifyImageProviderFailure(response.status, qwenErrorEnvelope(payload)),
      `Image provider rejected the request (HTTP ${response.status}).`,
      response.status,
      providerRequestId,
      requestParams
    );
  }

  const parsed = parseQwenImageResponse(payload);
  if (!parsed) {
    throw new ImageProviderError(
      "provider_failed",
      "Image provider returned no usable image payload.",
      response.status,
      providerRequestId,
      requestParams
    );
  }

  let asset: Response;
  try {
    asset = await fetch(parsed.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    throw new ImageProviderError(
      "provider_failed",
      "Image provider asset could not be downloaded.",
      null,
      providerRequestId,
      requestParams
    );
  }
  // Cancelled, not drained, as on the fal path: an unread image body pins its
  // connection, and reading it would spend the memory the limit refuses.
  const releaseAsset = () => asset.body?.cancel().catch(() => undefined);
  if (!asset.ok || !isQwenAssetUrl(asset.url)) {
    await releaseAsset();
    throw new ImageProviderError(
      "provider_failed",
      "Image provider asset was not served from the expected location.",
      asset.status,
      providerRequestId,
      requestParams
    );
  }
  // The response names no type, so the file's own Content-Type does, and it
  // has to be one this profile may store.
  const mimeType = (asset.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (!model.outputMimeTypes.includes(mimeType)) {
    await releaseAsset();
    throw new ImageProviderError(
      "provider_failed",
      "Image provider asset is not a type this model may store.",
      null,
      providerRequestId,
      requestParams
    );
  }
  // A declared length over the limit is refused unread, and the stream itself
  // is capped while it is read: a chunked or compressed body declares nothing
  // useful up front, and reading it whole first would spend the memory the
  // limit exists to refuse.
  let imageBytes: Buffer;
  try {
    imageBytes = await readResponseToBuffer(asset, FAL_MAX_ASSET_BYTES);
  } catch (error) {
    throw new ImageProviderError(
      "provider_failed",
      error instanceof BoundedBufferError
        ? "Image provider asset was larger than the accepted limit."
        : "Image provider asset could not be read.",
      null,
      providerRequestId,
      requestParams
    );
  }
  if (imageBytes.byteLength === 0) {
    throw new ImageProviderError(
      "provider_failed",
      "Image provider asset was empty.",
      null,
      providerRequestId,
      requestParams
    );
  }
  const dimensions = readImageDimensions(imageBytes, mimeType);
  const [expectedWidth, expectedHeight] = input.size.split("x").map(Number);
  if (!dimensions || dimensions.width !== expectedWidth || dimensions.height !== expectedHeight) {
    throw new ImageProviderError(
      "provider_failed",
      "Image provider returned a different size than the one that was priced.",
      null,
      providerRequestId,
      requestParams
    );
  }

  return {
    imageBytes,
    mimeType,
    // Billed per image; no token usage to record.
    inputTokens: 0,
    thinkingTokens: 0,
    outputTokens: 0,
    providerRequestId,
    provenance: [...model.provenance],
    outputWidth: dimensions.width,
    outputHeight: dimensions.height,
    requestParams,
  };
};
