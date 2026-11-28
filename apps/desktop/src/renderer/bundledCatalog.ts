import type { McpProvider } from "../../../../lib/mcpProviderCatalog";
import { MCP_PROVIDERS } from "../../../../lib/mcpProviderCatalog";

/**
 * The catalogue this app was built with. It is not part of the app's first load: the Plugins screen loads this module only
 * when the server it reached does not serve the catalogue (an older server), and uses it to label that server's own list.
 * Where the server serves the catalogue, the list and its logos come from the server and this module is never loaded.
 */
const logos = import.meta.glob<string>("../../../../public/plugins/providers/*.{png,svg}", {
  eager: true, query: "?url", import: "default",
});

export const bundledProviders: readonly McpProvider[] = MCP_PROVIDERS;
export const bundledLogo = (provider: McpProvider | undefined): string | undefined =>
  provider?.logo ? logos["../../../../public" + provider.logo] : undefined;
