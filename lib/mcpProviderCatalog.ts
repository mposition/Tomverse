import catalog from "@/config/mcp/provider-catalog.json";
import { findMcpProvider } from "./mcpProviderBrowse";

export type McpProviderCategory = "productivity" | "design" | "development" | "data" | "monitoring" | "security" | "finance" | "other";
export type McpProvider = {
  id: string; name: string; category: McpProviderCategory; logo: string | null; docs: string;
  sources: string[]; profiles: string[]; kind: "remote" | "managed" | "local" | "adapter";
  aliases: string[]; origins: string[];
};
export const MCP_PROVIDERS = catalog.providers as McpProvider[];
export const MCP_CATALOG_OBSERVED_AT = catalog.observedAt;
export const mcpProvider = (idOrName: string): McpProvider | undefined => findMcpProvider(MCP_PROVIDERS, idOrName);
