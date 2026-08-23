import {
  modelSupportsNativePdfInput,
  type AiModel,
} from "@/lib/models";

export const NATIVE_ATTACHMENT_ESTIMATED_TOKENS = 16_000;
export const EXTRACTED_ATTACHMENT_ESTIMATED_TOKEN_CAP = 75_000;

/**
 * How much bigger an archive's readable contents are than the archive.
 *
 * Every other attachment's extracted text is roughly bounded by its own byte
 * count; a ZIP's is bounded by what it expands to, which is the whole point of
 * it. Estimating an archive at its compressed size would tell the router that
 * a 200KB upload is a 50k-token turn when it is a 300k-character one, and the
 * router would pick a model on that. Four is deliberately modest -- text
 * compresses far better than that -- because the cap above is what actually
 * bounds the answer and the reservation is taken against the bytes really
 * sent, not against this.
 */
export const ARCHIVE_EXPANSION_ESTIMATE = 4;

export type AttachmentTokenDescriptor = {
  mediaType: string;
  size: number;
};

const isImage = (mediaType: string) => mediaType.startsWith("image/");
const isPdf = (mediaType: string) => mediaType === "application/pdf";
const isArchive = (mediaType: string) => mediaType === "application/zip";

export const estimateNativeAttachmentTokens = (count: number) =>
  Math.max(0, Math.trunc(count)) * NATIVE_ATTACHMENT_ESTIMATED_TOKENS;

export const estimatePreflightAttachmentTokens = (
  model: AiModel,
  attachments: AttachmentTokenDescriptor[]
) => {
  let nativeAttachmentCount = 0;
  let extractedAttachmentBytes = 0;

  for (const attachment of attachments) {
    if (
      isImage(attachment.mediaType) ||
      (isPdf(attachment.mediaType) && modelSupportsNativePdfInput(model))
    ) {
      nativeAttachmentCount += 1;
    } else {
      const bytes = Math.max(0, Math.trunc(attachment.size));
      extractedAttachmentBytes += isArchive(attachment.mediaType)
        ? bytes * ARCHIVE_EXPANSION_ESTIMATE
        : bytes;
    }
  }

  return (
    estimateNativeAttachmentTokens(nativeAttachmentCount) +
    Math.min(
      EXTRACTED_ATTACHMENT_ESTIMATED_TOKEN_CAP,
      Math.ceil(extractedAttachmentBytes / 4)
    )
  );
};
