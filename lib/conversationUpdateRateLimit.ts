import { consumeApiRateLimit } from "./apiSecurity";

/** Ordinary updates and an explicitly requested mode on creation share one account/IP allowance. */
export const consumeConversationUpdateLimit = (request: Request, userId: string) =>
  consumeApiRateLimit(request, userId, "conversation-update", { minute: 30, day: 1_000 });
