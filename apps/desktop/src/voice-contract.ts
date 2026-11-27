import { z } from "zod";

const id = z.string().min(1).max(200);
const conversation = z.string().min(1).max(120);

/** What the Chat voice conversation may ask of `/api/chat/voice`: the server's own five actions, and nothing else. */
export const voiceBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), requestId: z.uuid(), conversationId: conversation.nullable(), sdp: z.string().min(1).max(64_000) }).strict(),
  z.object({ action: z.literal("result"), reservationId: id, delegationId: id, conversationId: conversation, sourceUserMessageId: id }).strict(),
  z.object({ action: z.literal("stop"), reservationId: id }).strict(),
  z.object({ action: z.literal("status"), reservationId: id.optional(), requestId: z.uuid().optional() }).strict()
    .refine((value) => Boolean(value.reservationId || value.requestId)),
  z.object({ action: z.literal("history"), conversationId: conversation }).strict(),
]);
export type VoiceBody = z.infer<typeof voiceBody>;

export const voiceRequestInput = z.object({ id: z.uuid(), body: voiceBody }).strict();
export type VoiceRequestInput = z.infer<typeof voiceRequestInput>;

/** `status` 0 is a request that never reached the server. A `stream` reply is followed by its events, then one `end`. */
export type VoiceReply = { status: number; body?: string; stream?: true };
export type VoiceStreamEvent = { id: string; chunk?: string; end?: "done" | "error" };

/** The server's voice settings as the app uses them: with no time cap the session is funded minute by minute. */
export type VoiceConversationCapability = { continuous: boolean; maxSeconds: number };
