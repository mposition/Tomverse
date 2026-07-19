import {
  modelSupportsNativePdfInput,
  type AiModel,
} from "@/lib/models";

export const NATIVE_ATTACHMENT_ESTIMATED_TOKENS = 16_000;
export const EXTRACTED_ATTACHMENT_ESTIMATED_TOKEN_CAP = 75_000;

export type AttachmentTokenDescriptor = {
  mediaType: string;
  size: number;
};

const isImage = (mediaType: string) => mediaType.startsWith("image/");
const isPdf = (mediaType: string) => mediaType === "application/pdf";

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
      extractedAttachmentBytes += Math.max(0, Math.trunc(attachment.size));
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
