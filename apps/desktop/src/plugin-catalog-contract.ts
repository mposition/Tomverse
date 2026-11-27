import { z } from "zod";
import type { McpProvider } from "../../../lib/mcpProviderCatalog";

/**
 * The platform catalogue of the Plugins screen. The app does not carry it: the main process reads it from the account's
 * server (GET /api/mcp/providers, the list the web Plugins page shows) and the renderer receives the parsed result.
 * A platform the server adds appears without a new app; a field or value this app does not know is dropped or reduced
 * to a neutral one, and a platform that does not parse is skipped, so one bad entry never hides the rest.
 */

export const PLUGIN_CATALOG_PATH = "/api/mcp/providers";
/** Where a platform's logo lives on the account origin; anything else is not fetched. */
export const PLUGIN_LOGO_PATH = /^\/plugins\/providers\/[A-Za-z0-9._-]{1,100}\.(?:png|jpe?g|svg|webp)$/;
export const PLUGIN_LOGO_ROUTE = /^\/plugin-logo\/([a-z0-9-]{1,60})$/;
/** The app's own address for a platform's logo, served by the main process. */
export const pluginLogoUrl = (id: string) => `tomverse://desktop/plugin-logo/${encodeURIComponent(id)}`;

const providerWire = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,60}$/),
  name: z.string().min(1).max(120),
  category: z.enum(["productivity", "design", "development", "data", "monitoring", "security", "finance", "other"]).catch("other"),
  logo: z.string().regex(PLUGIN_LOGO_PATH).nullable().catch(null),
  docs: z.string().max(500).catch(""),
  sources: z.array(z.string().max(24)).max(8).catch([]),
  profiles: z.array(z.string().max(80)).max(16).catch([]),
  // A kind this app has no words for is shown as "needs another transport": it is offered nothing it cannot do.
  kind: z.enum(["remote", "managed", "local", "adapter"]).catch("adapter"),
  aliases: z.array(z.string().max(80)).max(16).catch([]),
  origins: z.array(z.string().max(300)).max(16).catch([]),
});

export const pluginCatalogBody = z.object({
  observedAt: z.string().max(40),
  providers: z.array(z.unknown()).max(2_000).transform((items): McpProvider[] => items.flatMap((item) => {
    const parsed = providerWire.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  })),
});
export type PluginCatalog = z.infer<typeof pluginCatalogBody>;

/** Seconds a response may be reused, from its Cache-Control header; none when it names no lifetime. */
export function catalogMaxAge(cacheControl: string | null): number {
  const seconds = /(?:^|[\s,])max-age=(\d{1,12})(?:[\s,]|$)/i.exec(cacheControl ?? "")?.[1];
  return seconds ? Math.min(Number(seconds), 86_400) : 0;
}
