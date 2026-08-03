// Shared guard for the conversation kind invariant: chat-shaped endpoints
// (chat send, comparison, share, title generation, export) must refuse an
// image conversation, and the image endpoints must refuse a chat one.
// UI non-exposure is not a security boundary -- every server endpoint checks.
// Policy: docs/policy/image-generation.md section 1.

export const CONVERSATION_KIND_NOT_SUPPORTED = "CONVERSATION_KIND_NOT_SUPPORTED";

export const isChatConversationKind = (
  kind: string | null | undefined
): boolean => !kind || kind === "chat";

export const isImageConversationKind = (
  kind: string | null | undefined
): boolean => kind === "image";

export const conversationKindNotSupportedResponse = () =>
  Response.json(
    {
      error: "This conversation does not support that operation.",
      code: CONVERSATION_KIND_NOT_SUPPORTED,
    },
    { status: 409, headers: { "Cache-Control": "no-store" } }
  );
