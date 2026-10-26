// Authorization codes/state must not leave through request error/trace payloads.
export function isMcpOAuthCallbackTelemetry(event: { request?: { url?: string }; transaction?: string }) {
  if (event.request?.url) {
    try { if (new URL(event.request.url, "https://tomverse.app").pathname === "/api/mcp/oauth/callback") return true; } catch { /* Fall back to the route name. */ }
  }
  return /(?:^|\s)\/api\/mcp\/oauth\/callback(?:[?\s]|$)/.test(event.transaction || "");
}
