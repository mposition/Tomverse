/** Live enrollment is a separate switch from building the native client. */
export const MOBILE_CHAT_PATH = "/api/mobile/chat";

export const mobileChatEnabled = (environment: Record<string, string | undefined> = process.env) =>
  environment.MOBILE_CHAT_ENABLED === "true";

export const mobileChatBearerRoutes = () => mobileChatEnabled() ? [MOBILE_CHAT_PATH] : [];

/** Initial native chat is text-only and keeps its transcript on the device. */
export const isNativeChatPayload = (body: unknown): boolean => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["messages", "modelId", "webSearchMode", "currentLocation"].includes(key))) return false;
  if (!Array.isArray(record.messages) || record.messages.length > 32) return false;
  return record.messages.every((message: unknown) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    const item = message as Record<string, unknown>;
    return (item.role === "user" || item.role === "assistant") &&
      typeof item.content === "string" &&
      Object.keys(item).every((key) => key === "role" || key === "content");
  });
};
