import { z } from "zod";
import { CHAT_MAX_ATTACHMENT_BYTES, CHAT_MAX_ATTACHMENTS_PER_MESSAGE } from "../../../lib/chatAttachmentLimits";
import { MESSAGE_ATTACHMENT_KINDS } from "../../../lib/messageAttachmentCore";

const attachmentId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const attachmentBytesInput = z.object({
  requestId: z.uuid(),
  name: z.string().trim().min(1).max(120).refine((name) => !/[\\/]/.test(name)),
  mediaType: z.string().max(180),
  bytes: z.instanceof(Uint8Array).refine((data) => data.byteLength > 0 && data.byteLength <= CHAT_MAX_ATTACHMENT_BYTES),
}).strict();
export const attachmentUpload = z.object({
  uploadId: attachmentId, name: z.string(), mediaType: z.string(), size: z.number().int().positive(), kind: z.enum(MESSAGE_ATTACHMENT_KINDS),
});
export const attachmentRead = attachmentUpload.omit({ uploadId: true }).extend({
  id: attachmentId,
  attachmentId,
  unavailableAt: z.string().nullish(),
});
export const attachmentUploadIds = z.array(attachmentId).max(CHAT_MAX_ATTACHMENTS_PER_MESSAGE)
  .refine((items) => new Set(items).size === items.length).optional();
export type AttachmentBytesInput = z.infer<typeof attachmentBytesInput>;
export type AttachmentUpload = z.infer<typeof attachmentUpload>;
