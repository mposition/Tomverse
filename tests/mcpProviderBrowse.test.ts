import assert from "node:assert/strict";
import test from "node:test";
import { MCP_PROVIDERS, mcpProvider, type McpProvider, type McpProviderCategory } from "@/lib/mcpProviderCatalog";
import { FEATURED_PROVIDER_IDS, filterPluginCards, findMcpProvider, pluginCards, sortCatalogProviders } from "@/lib/mcpProviderBrowse";

type Server = { id: string; name: string; custom?: boolean };
const servers: Server[] = [
  { id: "github", name: "GitHub" }, { id: "google-drive", name: "Google Drive" }, { id: "custom-1", name: "Github", custom: true },
  { id: "linear", name: "Linear" }, { id: "not-in-catalogue", name: "Internal tools" },
];

// What the web page computed inline before it called the shared functions (components/plugins/PluginWorkspace.tsx).
function webCards(inventory: { servers: Server[]; customEnabled: boolean }, customName: string) {
  const featured = ["github", "railway", "slack", "notion", "linear", "figma", "canva", "atlassian", "sentry", "cloudflare"];
  return [
    ...inventory.servers.map(server => ({ id: server.id, name: server.name, server, provider: server.custom ? undefined : mcpProvider(server.id) || mcpProvider(server.name) })),
    ...(inventory.customEnabled ? [{ id: "custom", name: customName }] : []),
    ...MCP_PROVIDERS.filter(provider => !inventory.servers.some(s => !s.custom && (mcpProvider(s.id) || mcpProvider(s.name))?.id === provider.id))
      .sort((a, b) => {
        const rank = (provider: McpProvider) => featured.includes(provider.id) ? featured.indexOf(provider.id) : provider.kind === "remote" ? 100 : 200;
        return rank(a) - rank(b);
      })
      .map(provider => ({ id: provider.id, name: provider.name, provider })),
    ...(inventory.customEnabled ? [] : [{ id: "custom", name: customName }]),
  ];
}
function webVisible(cards: ReturnType<typeof webCards>, search: string, category: McpProviderCategory | "all", source: string, connected?: string[]) {
  return cards.filter(card => [card.name, ...((card as { provider?: McpProvider }).provider?.aliases || [])].some(name => name.toLowerCase().includes(search.toLowerCase())) &&
    (category === "all" || (card as { provider?: McpProvider }).provider?.category === category) &&
    (source === "all" || (card as { provider?: McpProvider }).provider?.sources.includes(source)) &&
    (!connected || connected.includes(card.id)));
}

test("the shared card list is the list the web page built inline, for every server set", () => {
  for (const inventory of [
    { servers, customEnabled: true }, { servers, customEnabled: false }, { servers: [], customEnabled: true }, { servers: [], customEnabled: false },
    { servers: servers.slice(0, 1), customEnabled: true },
  ]) {
    const expected = webCards(inventory, "Custom MCP server");
    const actual = pluginCards({ servers: inventory.servers, providers: MCP_PROVIDERS, customEnabled: inventory.customEnabled, customName: "Custom MCP server" });
    assert.deepEqual(actual.map(card => card.id), expected.map(card => card.id));
    assert.deepEqual(actual.map(card => card.provider?.id), expected.map(card => (card as { provider?: McpProvider }).provider?.id));
    assert.equal(actual.length, expected.length);
  }
});

test("a user-entered server is never taken for a catalogue platform, and the platform of a real server is not listed twice", () => {
  const cards = pluginCards({ servers, providers: MCP_PROVIDERS, customEnabled: true, customName: "Custom" });
  assert.equal(cards.find(card => card.id === "custom-1")?.provider, undefined);
  assert.equal(cards.filter(card => card.provider?.id === "github").length, 1);
  assert.equal(cards.find(card => card.provider?.id === "github")?.server?.id, "github");
  assert.equal(cards.find(card => card.id === "not-in-catalogue")?.provider, undefined);
});

test("featured platforms come first, then remote ones, then the rest, each group in catalogue order", () => {
  const sorted = sortCatalogProviders(MCP_PROVIDERS);
  assert.equal(sorted.length, MCP_PROVIDERS.length);
  const featured = FEATURED_PROVIDER_IDS.filter(id => MCP_PROVIDERS.some(provider => provider.id === id));
  assert.deepEqual(sorted.slice(0, featured.length).map(provider => provider.id), featured);
  const rest = sorted.slice(featured.length);
  const firstOther = rest.findIndex(provider => provider.kind !== "remote");
  assert.ok(rest.slice(0, firstOther).every(provider => provider.kind === "remote"));
  assert.ok(rest.slice(firstOther).every(provider => provider.kind !== "remote"));
  const catalogueOrder = (list: McpProvider[]) => list.map(provider => MCP_PROVIDERS.indexOf(provider));
  const remotes = rest.slice(0, firstOther);
  assert.deepEqual(catalogueOrder(remotes), [...catalogueOrder(remotes)].sort((a, b) => a - b));
  // Sorting does not reorder the catalogue it was given.
  assert.notEqual(sorted, MCP_PROVIDERS);
});

test("search, category, directory and connected filters give the web's answer", () => {
  const inventory = { servers, customEnabled: true };
  const expected = webCards(inventory, "Custom MCP server");
  const actual = pluginCards({ servers, providers: MCP_PROVIDERS, customEnabled: true, customName: "Custom MCP server" });
  const categories: Array<McpProviderCategory | "all"> = ["all", "development", "productivity", "design", "data", "other"];
  for (const search of ["", "git", "GITHUB", "custom", "mcp", "zzz-none", "air", "adobe"]) {
    for (const category of categories) {
      for (const source of ["all", "openai", "claude"]) {
        assert.deepEqual(filterPluginCards(actual, { search, category, source }).map(card => card.id), webVisible(expected, search, category, source).map(card => card.id),
          `${search}/${category}/${source}`);
      }
    }
  }
  assert.deepEqual(filterPluginCards(actual, { search: "", category: "all", source: "all", connected: new Set(["github", "linear"]) }).map(card => card.id), ["github", "linear"]);
  assert.deepEqual(filterPluginCards(actual, { search: "", category: "all", source: "all", connected: new Set() }), []);
});

test("an alias finds its platform, and a name with a suffix is still that platform", () => {
  const alias = MCP_PROVIDERS.find(provider => provider.aliases.some(name => name !== provider.id && name !== provider.name.toLowerCase()));
  assert.ok(alias);
  const aliasName = alias.aliases.find(name => name !== alias.id)!;
  const cards = pluginCards({ servers: [], providers: MCP_PROVIDERS, customEnabled: false, customName: "Custom" });
  assert.ok(filterPluginCards(cards, { search: aliasName, category: "all", source: "all" }).some(card => card.id === alias.id));
  assert.equal(findMcpProvider(MCP_PROVIDERS, "github mcp")?.id, "github");
  assert.equal(findMcpProvider(MCP_PROVIDERS, "github-server")?.id, "github");
  assert.equal(findMcpProvider(MCP_PROVIDERS, "no such platform"), undefined);
  assert.equal(mcpProvider("GitHub")?.id, findMcpProvider(MCP_PROVIDERS, "GitHub")?.id);
});

test("a catalogue the server sent lists new platforms without the one built into the app", () => {
  const added: McpProvider = { id: "brand-new", name: "Brand New", category: "other", logo: null, docs: "https://example.org", sources: ["claude"],
    profiles: [], kind: "remote", aliases: ["bn"], origins: [] };
  const cards = pluginCards({ servers: [], providers: [added], customEnabled: true, customName: "Custom" });
  assert.deepEqual(cards.map(card => card.id), ["custom", "brand-new"]);
  assert.deepEqual(filterPluginCards(cards, { search: "bn", category: "all", source: "all" }).map(card => card.id), ["brand-new"]);
  // `catalog: false` is the server's own list: the catalogue only labels it.
  assert.deepEqual(pluginCards({ servers: [{ id: "brand-new", name: "Brand New" }], providers: [added], customEnabled: false, customName: "Custom", catalog: false }).map(card => card.id), ["brand-new", "custom"]);
  assert.deepEqual(pluginCards({ servers: [], providers: [added], customEnabled: false, customName: "Custom", catalog: false }).map(card => card.id), ["custom"]);
});
