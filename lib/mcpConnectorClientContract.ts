export type PluginTool = { name: string; mode: "read" | "confirm"; inputSchema?: Record<string, unknown> };
export type PluginConnection = { id: string; serverId: string; name: string; status: string; catalog: PluginTool[]; grants: PluginTool[]; version: number };
export type PluginServer = { id: string; name: string; auth: "none" | "bearer" | "oauth"; origin: string };
export type PluginAction = { id: string; connectionId: string; toolName: string; state: string; arguments: unknown; expiresAt: string };
export type PluginInventory = { enabled: boolean; servers: PluginServer[]; connections: PluginConnection[]; invocations: PluginAction[] };
export const EMPTY_PLUGIN_INVENTORY: PluginInventory = { enabled: false, servers: [], connections: [], invocations: [] };
export async function readPluginInventory(signal?: AbortSignal): Promise<PluginInventory | null> {
  const response = await fetch("/api/mcp/connections", { cache: "no-store", signal });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("inventory_failed");
  return response.json();
}
export const PLUGIN_PROVIDERS = [
  { id: "github", name: "GitHub", description: "Issues, pull requests and code" },
  { id: "railway", name: "Railway", description: "Services and deployment workflows" },
  { id: "notion", name: "Notion", description: "Pages and workspace knowledge" },
  { id: "linear", name: "Linear", description: "Issues and project updates" },
  { id: "slack", name: "Slack", description: "Channels and team messages" },
] as const;
export function pluginLogo(name: string): string | undefined {
  const lower = name.toLowerCase();
  const match = PLUGIN_PROVIDERS.find(p => lower === p.id || lower.startsWith(p.id + " ") || lower.startsWith(p.id + "-"));
  return match ? `/plugins/${match.id}.svg` : undefined;
}
