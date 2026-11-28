import { createHash } from "node:crypto";
import { MCP_CATALOG_OBSERVED_AT, MCP_PROVIDERS } from "./mcpProviderCatalog";

/**
 * The platform catalogue the web Plugins page lists, as one cacheable read for a client that does not carry it
 * (Desktop). It is the same list in the same order with the same fields; `observedAt` is its version, and the
 * ETag also covers the content, so a platform added without a new date still reaches the client.
 */
export const MCP_PROVIDER_CATALOG_PATH = "/api/mcp/providers";
export const MCP_PROVIDER_CATALOG_MAX_AGE_SECONDS = 600;

const body = JSON.stringify({ observedAt: MCP_CATALOG_OBSERVED_AT, providers: MCP_PROVIDERS });
const etag = `"${MCP_CATALOG_OBSERVED_AT}-${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;

const headers = () => ({
  ETag: etag,
  // Private: the read needs a sign-in, so no shared cache may keep it for another caller.
  "Cache-Control": `private, max-age=${MCP_PROVIDER_CATALOG_MAX_AGE_SECONDS}, must-revalidate`,
  Vary: "Authorization, Origin",
});

/** Whether an If-None-Match header names the current version (weak or strong form, or `*`). */
export function catalogEtagMatches(ifNoneMatch: string | null): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").some(candidate => {
    const value = candidate.trim().replace(/^W\//, "");
    return value === "*" || value === etag;
  });
}

export function mcpProviderCatalogResponse(ifNoneMatch: string | null): Response {
  if (catalogEtagMatches(ifNoneMatch)) return new Response(null, { status: 304, headers: headers() });
  return new Response(body, { status: 200, headers: { ...headers(), "Content-Type": "application/json; charset=utf-8" } });
}
