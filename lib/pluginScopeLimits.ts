// `scopes` lists what a user may choose at connect time; absent means the server's scope is fixed.
// Mirrors MCP_SCOPE_LIMITS in lib/mcpConnectorPolicy.ts (server-only); the server re-checks.
// Its own module so a client that only needs the limits (Desktop) does not load the provider catalogue.
export const PLUGIN_SCOPE_LIMITS = Object.freeze({ chosen: 64, chosenCharacters: 2_000 });
