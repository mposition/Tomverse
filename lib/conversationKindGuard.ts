// Shared guard for the conversation kind invariant: chat-shaped endpoints
// (chat send, comparison, share, title generation, export) must refuse an
// image conversation, and the image endpoints must refuse a chat one.
// UI non-exposure is not a security boundary -- every server endpoint checks.
// Policy: docs/policy/image-generation.md section 1.
//
// The point of these being functions is that the comparison is written once.
// Every chat-shaped endpoint went through isChatConversationKind while both
// image-side authorization checks open-coded `kind !== "image"` -- which is
// the same answer today and is not the same decision, because the day the
// column grows a third kind the open-coded ones silently pick a side.
// scripts/security-regression-check.mjs pins the server checks to the helpers;
// presentation code (a sidebar icon, a response's kind field) is not an
// authorization decision and is deliberately outside that rule.

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
