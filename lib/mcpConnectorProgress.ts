const MARKER = String.fromCharCode(0) + "TOMVERSE_MCP_PROGRESS";
// The last three belong to the chat read tools (read_url, search_past_chats), which
// share this one in-stream status channel rather than adding a second.
const STATES = ["searching", "reading", "approval_required", "no_results", "reauth_required", "server_error", "done", "page_reading", "page_unavailable", "history_searching"] as const;
export type McpProgressState = typeof STATES[number];
export const buildMcpProgressChunk = (state: McpProgressState) => MARKER + JSON.stringify({ state });
export function mcpProgressFromStream(raw: string): McpProgressState | undefined {
  const index = raw.lastIndexOf(MARKER);
  if (index < 0) return;
  const start = index + MARKER.length, end = raw.indexOf("}", start);
  if (end < 0) return;
  try { const parsed = JSON.parse(raw.slice(start, end + 1)); if (STATES.includes(parsed.state)) return parsed.state; } catch { /* Incomplete stream controls are not rendered. */ }
}
