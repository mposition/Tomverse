import type { ImageSize } from "@/lib/imageGenerationPricing";

// Pure request/response shaping for Qwen image models called directly on
// Alibaba Cloud Model Studio International (Singapore), kept out of
// lib/imageProviderAdapter.ts so what decides the bill is testable without a
// network. Read against the official API reference on 2026-11-07:
// https://www.alibabacloud.com/help/en/model-studio/qwen-image-generation-and-editing-api-reference
//
// Default off. No Qwen model is in the code seed (lib/imageModelRegistry.ts);
// one exists only once an operator adds a runtime catalogue profile and a price
// revision, and the judge still refuses it while
// IMAGE_PROVIDER_QWEN_COST_MICROUSD_PER_{DAY,MONTH} are unset in production.
//
// Generation only. An edit needs an approved surcharge in IMAGE_EDIT_PRICING
// (qwen-image-3.0 bills each input image, $0.003 at 1K) and the adapter's edit
// allowlist, and neither is decided.
//
// Unverified, and the reason the paid smoke is part of enabling this rather
// than a formality: where Alibaba keeps the generated file. The reference's
// own example result URL, for both the 3.0 and 2.1 families, is
// `dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com` -- a mainland China
// bucket -- and the page names no storage region for the Singapore
// deployment. lib/providerDataDestinations.ts records Qwen storage as
// committed to SG with processing NOT_PINNED; whether image results transit or
// rest in mainland China is not established. `isQwenAssetUrl` therefore
// accepts only Singapore's public OSS endpoint, so a mainland result fails the
// smoke instead of being quietly stored.

/**
 * The synchronous endpoint on the Singapore domain chat already uses
 * (lib/modelRegistryShared.ts). The reference recommends the newer
 * `{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com` domain and states that "The
 * existing domain remains fully functional"; this one needs no workspace id.
 */
export const QWEN_IMAGE_GENERATION_URL =
  "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

/**
 * The one size this integration sends. `width*height`, not `widthxheight`, and
 * always stated: qwen-image-2.0 defaults to 2048 on a side, and an omitted size
 * lets the model pick one the credits were not priced for.
 */
const SIZE_BY_IMAGE_SIZE: Partial<Record<ImageSize, string>> = {
  "1024x1024": "1024*1024",
};

export type QwenImageRequestInput = {
  apiModelId: string;
  /** The only field that carries user text. */
  prompt: string;
  size: ImageSize;
};

/**
 * The request body. Returns null for a size with no mapping rather than
 * sending a resolution the credits were not computed against.
 *
 * - `n: 1`: the price is per image and the API accepts up to 6.
 * - `prompt_extend: false`: its default is true, which rewrites the prompt
 *   with a model we did not choose. It also keeps thinking off, since the
 *   reference says `enable_thinking` "Requires prompt_extend=true".
 *   Thinking is not billed separately either way (`not_billed` in
 *   lib/imageModelRegistry.ts).
 * - `watermark: false`: stated, not inherited.
 * - `enable_thinking`, `negative_prompt` and `seed` are not sent: no user
 *   input reaches them, and `negative_prompt` is documented for the 3.0
 *   series only -- a field a model does not accept fails like an outage.
 */
export const buildQwenImageRequest = (
  input: QwenImageRequestInput
): Record<string, unknown> | null => {
  const size = SIZE_BY_IMAGE_SIZE[input.size];
  if (!size) return null;
  return {
    model: input.apiModelId,
    // `input` is one of the adapter's prompt field names, so the audit view of
    // this body drops the whole field and keeps `model` and `parameters`.
    input: { messages: [{ role: "user", content: [{ text: input.prompt }] }] },
    parameters: { size, n: 1, watermark: false, prompt_extend: false },
  };
};

/**
 * Singapore's public OSS endpoint, one bucket label in front of it.
 *
 * An allowlist, not a suffix: `.aliyuncs.com` also names Alibaba's intranet
 * endpoints (`oss-ap-southeast-1-internal.aliyuncs.com`), every mainland
 * region (the reference's own example is `oss-cn-shenzhen`) and Hong Kong
 * (`oss-cn-hongkong`), none of which is the Singapore the destination row
 * records. Naming the one public region excludes all of them, and a region
 * Alibaba adds later, without a list of what to refuse.
 *
 * The bucket label is any valid OSS bucket name because the real one is
 * unverified -- the only one on record is the reference's mainland example.
 * If the paid smoke shows Singapore results living elsewhere, this pattern
 * changes with that evidence; until then such a result is refused, not stored.
 */
const ASSET_HOST = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.oss-ap-southeast-1\.aliyuncs\.com$/;

/** Where a generated file may be fetched from: https on `ASSET_HOST`, nothing else. */
export const isQwenAssetUrl = (value: string): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  return ASSET_HOST.test(url.hostname);
};

/**
 * OSS Global Accelerate: the same bucket reached through Alibaba's acceleration
 * network. wan2.7-image answers with this host (observed 2026-11-13,
 * `dashscope-463f.oss-accelerate.aliyuncs.com`). It names no region, so it is
 * never fetched as given: `qwenAssetFetchUrl` sends the same signed path to the
 * bucket's Singapore endpoint, which OSS serves only for a Singapore bucket --
 * any other answers "must be addressed using the specified endpoint" and the
 * download is refused. That bucket was confirmed in ap-southeast-1 the same day.
 */
const ACCELERATE_HOST = /^([a-z0-9][a-z0-9-]{1,61}[a-z0-9])\.oss-accelerate\.aliyuncs\.com$/;

/**
 * Where to fetch a result URL from: unchanged when it is already on
 * Singapore's endpoint, rewritten to it when it is an accelerate URL, else
 * null. The query (the signature and expiry) is kept as is; an OSS V1
 * signature covers the bucket and object, not the host.
 */
export const qwenAssetFetchUrl = (value: string): string | null => {
  if (isQwenAssetUrl(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return null;
  const bucket = ACCELERATE_HOST.exec(url.hostname)?.[1];
  if (!bucket) return null;
  url.hostname = `${bucket}.oss-ap-southeast-1.aliyuncs.com`;
  const rewritten = url.toString();
  return isQwenAssetUrl(rewritten) ? rewritten : null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * The one delivered image's URL, or null.
 *
 * More than one choice or image fails closed rather than taking the first: the
 * price is for one image. Where `usage` reports a count it has to agree --
 * `image_count` (2.1 series) or `output_image_count` (3.0 series) of exactly 1,
 * and no `input_image_count` above 0, because 3.0 bills each input image and a
 * text-only request priced without one must not settle as though it were.
 */
export const parseQwenImageResponse = (payload: unknown): { url: string } | null => {
  const output = asRecord(asRecord(payload)?.output);
  const choices = output?.choices;
  if (!Array.isArray(choices) || choices.length !== 1) return null;
  const content = asRecord(asRecord(choices[0])?.message)?.content;
  if (!Array.isArray(content)) return null;
  const images = content
    .map((part) => asRecord(part))
    .filter((part): part is Record<string, unknown> => part !== null && "image" in part)
    .map((part) => part.image);
  if (images.length !== 1) return null;
  const [image] = images;
  const url = typeof image === "string" ? qwenAssetFetchUrl(image) : null;
  if (!url) return null;

  const usage = asRecord(asRecord(payload)?.usage);
  if (usage) {
    for (const key of ["image_count", "output_image_count"]) {
      if (key in usage && usage[key] !== 1) return null;
    }
    if ("input_image_count" in usage && usage.input_image_count !== 0) return null;
  }
  return { url };
};

/** The body's `request_id`, on success and error alike. */
export const qwenRequestId = (payload: unknown): string | null => {
  const id = asRecord(payload)?.request_id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
};

/**
 * The phase an error body names on its own, ahead of the shared HTTP-status
 * classification. Codes from the Model Studio error-code page (read
 * 2026-11-07): content moderation is "DataInspectionFailed" /
 * "data_inspection_failed" ("Input or output data may contain inappropriate
 * content."), "IPInfringementSuspect" and "CustomRoleBlocked" -- none of which
 * the shared matcher's words catch -- and "Arrearage" is our account, not the
 * user's request. That page states no HTTP status for these.
 */
const QWEN_MODERATION_CODES = new Set([
  "DataInspectionFailed",
  "data_inspection_failed",
  "IPInfringementSuspect",
  "CustomRoleBlocked",
]);

export const qwenFailurePhase = (
  payload: unknown
): "provider_moderation_rejected" | "provider_failed" | null => {
  const code = asRecord(payload)?.code;
  if (typeof code !== "string") return null;
  if (QWEN_MODERATION_CODES.has(code)) return "provider_moderation_rejected";
  if (code === "Arrearage") return "provider_failed";
  return null;
};

/** DashScope's top-level `{code, message}` in the `{error}` shape the shared classifier reads. */
export const qwenErrorEnvelope = (payload: unknown): { error: { code?: string; message?: string } } => {
  const record = asRecord(payload);
  return {
    error: {
      ...(typeof record?.code === "string" ? { code: record.code } : {}),
      ...(typeof record?.message === "string" ? { message: record.message } : {}),
    },
  };
};
