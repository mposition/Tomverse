import catalog from "@/config/mcp/provider-catalog.json";

export type McpProviderCategory = "productivity" | "design" | "development" | "data" | "monitoring" | "security" | "finance" | "other";
export type McpProvider = {
  id: string; name: string; category: McpProviderCategory; logo: string | null; docs: string;
  sources: string[]; profiles: string[]; kind: "remote" | "managed" | "local" | "adapter";
  aliases: string[]; origins: string[];
};
export const MCP_PROVIDERS = catalog.providers as McpProvider[];
export const MCP_CATALOG_OBSERVED_AT = catalog.observedAt;
export function mcpProvider(idOrName: string): McpProvider | undefined {
  const name = idOrName.toLowerCase();
  return MCP_PROVIDERS.find(provider => provider.id === name || provider.profiles.includes(name)) || MCP_PROVIDERS.find(provider => [provider.id, provider.name, ...provider.aliases].some(alias =>
    name === alias.toLowerCase() || name.startsWith(alias.toLowerCase() + " ") || name.startsWith(alias.toLowerCase() + "-")));
}
