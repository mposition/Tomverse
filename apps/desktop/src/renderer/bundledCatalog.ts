import type { McpProvider } from "../../../../lib/mcpProviderCatalog";
import { MCP_PROVIDERS } from "../../../../lib/mcpProviderCatalog";
import { bundledLogoFile } from "./bundledLogos";

/**
 * The catalogue this app was built with. It is not part of the app's first load: the Plugins screen loads this module only
 * when the server it reached does not serve the catalogue (an older server), and uses it to label that server's own list.
 * Where the server serves the catalogue, the list comes from the server and this module is never loaded (logos: bundledLogos.ts).
 */

export const bundledProviders: readonly McpProvider[] = MCP_PROVIDERS;
export const bundledLogo = (provider: McpProvider | undefined): string | undefined =>
  bundledLogoFile(provider?.logo);
