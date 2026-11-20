import { consumeApiRateLimit } from "./apiSecurity";

/** Standalone and fused decisions share the same subject and secondary IP buckets. */
export const consumeChatLocationIntentLimit = (request: Request, subjectKey: string) =>
  consumeApiRateLimit(request, subjectKey, "chat-location-intent", { minute: 30, day: 2_000 });
