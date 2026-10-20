/** Local implementation is available; operational enrollment is default-off. */
export function nativeChatBearerRoute(path: string, method: string, enabled = process.env.TOMVERSE_NATIVE_CHAT_ENABLED === "true"): boolean {
  if (!enabled) return false;
  if (path === "/api/chat") return ["POST", "PUT", "PATCH"].includes(method);
  if (path === "/api/conversations") return method === "GET";
  if (path === "/api/products/chat/conversations") return method === "POST";
  if (path === "/api/products/chat/capabilities") return method === "GET";
  if (path === "/api/chat/voice-transcription") return method === "POST";
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}$/.test(path)) return ["GET", "PATCH"].includes(method);
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/messages$/.test(path)) return method === "POST";
  if (/^\/api\/products\/chat\/attempts\/[A-Za-z0-9_-]{1,100}$/.test(path)) return method === "GET";
  return false;
}
