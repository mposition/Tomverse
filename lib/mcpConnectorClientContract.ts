import { discardResponseBody } from "@/lib/discardResponseBody";
import { MCP_PROVIDERS, mcpProvider } from "@/lib/mcpProviderCatalog";

export type PluginTool = { name: string; mode: "read" | "confirm"; inputSchema?: Record<string, unknown> };
export type PluginConnection = { id: string; serverId: string; name: string; status: string; catalog: PluginTool[]; grants: PluginTool[]; version: number; scopes?: string[] };
// `scopes` lists what a user may choose at connect time; absent means the server's scope is fixed.
// Mirrors MCP_SCOPE_LIMITS in lib/mcpConnectorPolicy.ts (server-only); the server re-checks.
export const PLUGIN_SCOPE_LIMITS = Object.freeze({ chosen: 64, chosenCharacters: 2_000 });
export type PluginServer = { id: string; name: string; auth: "none" | "bearer" | "oauth"; origin: string; custom?: boolean; scopes?: string[]; defaultScopes?: string[] };
export type PluginAction = { id: string; connectionId: string; toolName: string; state: string; arguments: unknown; expiresAt: string };
export type PluginInventory = { enabled: boolean; customEnabled?: boolean; servers: PluginServer[]; connections: PluginConnection[]; invocations: PluginAction[] };
export const EMPTY_PLUGIN_INVENTORY: PluginInventory = { enabled: false, servers: [], connections: [], invocations: [] };
export async function readPluginInventory(signal?: AbortSignal): Promise<PluginInventory | null> {
  const response = await fetch("/api/mcp/connections", { cache: "no-store", signal });
  if (!response.ok) {
    await discardResponseBody(response);
    if (response.status === 401) return null;
    throw new Error("inventory_failed");
  }
  return response.json();
}
export const PLUGIN_PROVIDERS = MCP_PROVIDERS;
export function pluginLogo(name: string): string | undefined {
  return mcpProvider(name)?.logo || undefined;
}
