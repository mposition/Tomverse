import { resolveChatAttachmentFormat } from "@/lib/chatAttachmentFormats";
import { artifactFormat } from "@/lib/generatedArtifactFormats";

// Defined beside the Native gate so proxy.ts can read the switch without
// pulling the format tables into the Prompt Refiner's pinned runtime closure.
export { generatedArtifactRevisionEnabled } from "@/lib/nativeBearerGate";

/** A view of the existing write/read tables, never a second format registry. */
export function generatedArtifactRevisionFormat(input: {
  format: string;
  filename: string;
  mediaType?: string;
}) {
  const output = artifactFormat(input.format);
  if (!output || !input.filename.toLowerCase().endsWith(output.extension)) return null;
  const attachment = resolveChatAttachmentFormat({
    filename: input.filename,
    declaredMediaType: input.mediaType,
  });
  if (!attachment) return null;
  if (attachment.category === "text" &&
    (output.kind === "text" || ["txt", "md", "csv"].includes(output.id))) return attachment;
  if (attachment.category === "office" && ["docx", "pptx", "xlsx"].includes(output.id)) return attachment;
  return null;
}

export const isGeneratedArtifactRevisionSupported = (input: {
  format: string;
  filename: string;
  mediaType?: string;
}) => generatedArtifactRevisionFormat(input) !== null;
