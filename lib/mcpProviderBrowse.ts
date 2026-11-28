import type { McpProvider, McpProviderCategory } from "./mcpProviderCatalog";

/**
 * How the Plugins screen lists, orders and filters platforms. The web page and the Desktop app both call these,
 * so a platform sorts, matches a search and answers a filter the same way in either. The catalogue is a
 * parameter: the web passes the one built into the page, Desktop passes the one it read from the server.
 */

export const FEATURED_PROVIDER_IDS: readonly string[] = ["github", "railway", "slack", "notion", "linear", "figma", "canva", "atlassian", "sentry", "cloudflare"];

/** A provider by id, connection profile, name or alias. A name may carry a suffix after the alias ("github mcp", "github-server"). */
export function findMcpProvider(providers: readonly McpProvider[], idOrName: string): McpProvider | undefined {
  const name = idOrName.toLowerCase();
  return providers.find(provider => provider.id === name || provider.profiles.includes(name)) || providers.find(provider => [provider.id, provider.name, ...provider.aliases].some(alias =>
    name === alias.toLowerCase() || name.startsWith(alias.toLowerCase() + " ") || name.startsWith(alias.toLowerCase() + "-")));
}

const rank = (provider: McpProvider) => FEATURED_PROVIDER_IDS.includes(provider.id) ? FEATURED_PROVIDER_IDS.indexOf(provider.id) : provider.kind === "remote" ? 100 : 200;

/** Featured platforms first, then the ones with a remote address, then the rest, each group in catalogue order. */
export function sortCatalogProviders(providers: readonly McpProvider[]): McpProvider[] {
  return [...providers].sort((a, b) => rank(a) - rank(b));
}

export type PluginCard<S extends { id: string; name: string; custom?: boolean }> = { id: string; name: string; server?: S; provider?: McpProvider };

/**
 * Cards in the order the web shows them: the servers this deployment offers (with the catalogue entry each one is),
 * "custom server" next when custom servers are on, the remaining catalogue platforms, and "custom server" last when it is off.
 * `catalog: false` lists only the servers (and the custom card), for a client that has no catalogue to show.
 */
export function pluginCards<S extends { id: string; name: string; custom?: boolean }>(input: {
  servers: readonly S[]; providers: readonly McpProvider[]; customEnabled: boolean; customName: string; catalog?: boolean;
}): PluginCard<S>[] {
  const { servers, providers, customEnabled, customName } = input;
  // A user-entered server is never presented as a catalogued provider, whatever its name.
  const providerOf = (server: S) => server.custom ? undefined : findMcpProvider(providers, server.id) || findMcpProvider(providers, server.name);
  const served = new Set(servers.flatMap(server => { const provider = providerOf(server); return provider ? [provider.id] : []; }));
  const custom: PluginCard<S> = { id: "custom", name: customName };
  return [
    ...servers.map(server => ({ id: server.id, name: server.name, server, provider: providerOf(server) })),
    // Connectable now, so it sits with the connectable servers rather than after 140 catalog entries.
    ...(customEnabled ? [custom] : []),
    ...(input.catalog === false ? [] : sortCatalogProviders(providers.filter(provider => !served.has(provider.id))).map(provider => ({ id: provider.id, name: provider.name, provider }))),
    ...(customEnabled ? [] : [custom]),
  ];
}

/** The search matches the name or an alias; `category` and `source` need a catalogue entry; `connected` keeps the cards whose id it holds. */
export function filterPluginCards<C extends { id: string; name: string; provider?: McpProvider }>(cards: readonly C[], filter: {
  search: string; category: McpProviderCategory | "all"; source: string; connected?: ReadonlySet<string>;
}): C[] {
  const needle = filter.search.toLowerCase();
  return cards.filter(card => [card.name, ...(card.provider?.aliases || [])].some(name => name.toLowerCase().includes(needle)) &&
    (filter.category === "all" || card.provider?.category === filter.category) &&
    (filter.source === "all" || card.provider?.sources.includes(filter.source)) &&
    (!filter.connected || filter.connected.has(card.id)));
}
