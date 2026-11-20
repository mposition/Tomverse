import "server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { guardedMcpFetch, resolvePublicMcpEndpoint, validateMcpEndpoint } from "@/lib/mcpConnectorClient";
import { MCP_LIMITS, McpConnectorError, isCustomMcpServerId, mcpCustomServersEnabled, mcpServer, mcpServerSchema,
  type McpServerPolicy } from "@/lib/mcpConnectorPolicy";

type Db = Prisma.TransactionClient | typeof prisma;
type CustomRow = { id: string; name: string; url: string; auth: string; oauth: Prisma.JsonValue | null };
export type CustomOAuth = NonNullable<McpServerPolicy["oauth"]>;
export const customMcpServerInputSchema = z.object({
  url: z.string().min(1).max(2048),
  name: z.string().max(80).optional(),
  auth: z.enum(["none", "bearer", "oauth"]),
}).strict();

// A user-entered server never gets pre-approved read tools: every call needs
// the user's confirmation. The rest is the same policy shape operators write.
export function customMcpServerPolicy(row: CustomRow): McpServerPolicy {
  return mcpServerSchema.parse({ id: row.id, name: row.name, url: row.url, auth: row.auth, readTools: [], ...(row.oauth ? { oauth: row.oauth } : {}) });
}

// HTTPS on port 443, no credentials/query/fragment, no private IP literal. DNS
// answers are checked again, and pinned, on every request by the client.
export function normalizeCustomMcpUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new McpConnectorError("invalid_custom_url"); }
  validateMcpEndpoint({ id: "custom-check", name: "custom", url: url.href, readTools: [], auth: "none" });
  return url.href;
}
/** Refuses a host whose current DNS answers include a non-public address. */
export async function assertPublicCustomMcpUrl(url: string, signal: AbortSignal) {
  await resolvePublicMcpEndpoint({ id: "custom-check", name: "custom", url, readTools: [], auth: "none" }, signal);
}
export const customMcpServerName = (name: string | undefined, url: string) =>
  ((name || "").replace(/\p{C}+/gu, " ").replace(/\s+/g, " ").trim() || new URL(url).hostname).slice(0, 80);

type GetJson = (url: string, signal: AbortSignal) => Promise<unknown>;
const guardedGetJson: GetJson = async (target, signal) => {
  const fetcher = guardedMcpFetch({ id: "custom-discovery", name: "discovery", url: target, readTools: [], auth: "none" }, null, signal, true);
  let response: Response;
  try { response = await fetcher(target, { method: "GET", headers: { accept: "application/json" } }); }
  catch (error) {
    if (error instanceof McpConnectorError && ["unsafe_endpoint", "unsafe_address", "cancelled_or_timeout"].includes(error.code)) throw error;
    return null;
  }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
  return response.json().catch(() => null);
};
const wellKnown = (base: URL, name: string) => {
  const path = base.pathname.replace(/\/$/, "");
  return path ? [`${base.origin}/.well-known/${name}${path}`, ...(name === "openid-configuration" ? [`${base.origin}${path}/.well-known/${name}`] : [])]
    : [`${base.origin}/.well-known/${name}`];
};
async function firstJson(urls: string[], getJson: GetJson, signal: AbortSignal) {
  for (const url of urls) { const value = await getJson(url, signal); if (value && typeof value === "object") return value; }
  return null;
}
const resourceMetadataSchema = z.object({ resource: z.string().url().optional(),
  authorization_servers: z.array(z.string().url()).min(1).optional(), scopes_supported: z.array(z.string()).optional() });
const serverMetadataSchema = z.object({ issuer: z.string().url(), authorization_endpoint: z.string().url(), token_endpoint: z.string().url(),
  registration_endpoint: z.string().url(), code_challenge_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional() });
const sameUrl = (a: string, b: string) => a.replace(/\/$/, "") === b.replace(/\/$/, "");
// RFC 9728: the advertised resource identifies this server (same origin, same path or a parent path).
const coversServer = (resource: string, server: URL) => {
  const url = new URL(resource), path = url.pathname.replace(/\/$/, "");
  return url.origin === server.origin && !url.username && !url.password && !url.search && !url.hash && (server.pathname === path || server.pathname.startsWith(`${path}/`));
};

// RFC 9728 protected-resource metadata, then RFC 8414 / OIDC server metadata.
// Only servers with dynamic client registration and PKCE are accepted. The
// result is stored once and then used exactly like an operator OAuth profile.
export async function discoverCustomOAuth(serverUrl: string, signal: AbortSignal, getJson: GetJson = guardedGetJson): Promise<CustomOAuth> {
  const server = new URL(serverUrl);
  const resource = resourceMetadataSchema.safeParse(await firstJson([...wellKnown(server, "oauth-protected-resource"),
    ...(server.pathname === "/" ? [] : [`${server.origin}/.well-known/oauth-protected-resource`])], getJson, signal) ?? {});
  if (!resource.success || (resource.data.resource && !coversServer(resource.data.resource, server))) throw new McpConnectorError("oauth_discovery_failed");
  const issuer = new URL(resource.data.authorization_servers?.[0] ?? server.origin);
  const parsed = serverMetadataSchema.safeParse(await firstJson([...wellKnown(issuer, "oauth-authorization-server"), ...wellKnown(issuer, "openid-configuration")], getJson, signal));
  if (!parsed.success) throw new McpConnectorError("oauth_discovery_failed");
  const metadata = parsed.data;
  // The authorization request always sends an S256 challenge, so the server must say it verifies one.
  if (!sameUrl(metadata.issuer, issuer.href) || !metadata.code_challenge_methods_supported?.includes("S256"))
    throw new McpConnectorError("oauth_discovery_failed");
  const methods = metadata.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
  const tokenAuthMethod = (["none", "client_secret_post", "client_secret_basic"] as const).find(method => methods.includes(method));
  const scope = (resource.data.scopes_supported ?? []).filter(value => /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/.test(value)).join(" ");
  if (!tokenAuthMethod || scope.length > 500) throw new McpConnectorError("oauth_discovery_failed");
  const oauth: CustomOAuth = { issuer: metadata.issuer, authorizationUrl: metadata.authorization_endpoint, tokenUrl: metadata.token_endpoint,
    registrationUrl: metadata.registration_endpoint, scope, ...(tokenAuthMethod === "none" ? {} : { tokenAuthMethod }) };
  for (const url of [oauth.issuer, oauth.authorizationUrl, oauth.tokenUrl, oauth.registrationUrl!]) {
    validateMcpEndpoint({ id: "custom-check", name: "custom", url, readTools: [], auth: "oauth" }, true);
  }
  return oauth;
}

/** Operator policies by id; a custom id resolves only to its owner's row. */
export async function mcpServerFor(userId: string, id: string, db: Db = prisma): Promise<McpServerPolicy> {
  if (!isCustomMcpServerId(id)) return mcpServer(id);
  if (!mcpCustomServersEnabled()) throw new McpConnectorError("connector_disabled", 503);
  const row = await db.mcpCustomServer.findFirst({ where: { id, userId } });
  if (!row) throw new McpConnectorError("connector_disabled", 503);
  return customMcpServerPolicy(row);
}
export async function listCustomMcpServers(userId: string) {
  if (!mcpCustomServersEnabled()) return [];
  const rows = await prisma.mcpCustomServer.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, take: MCP_LIMITS.customServers });
  // One unreadable row must not take the whole Plugins inventory down with it.
  return rows.flatMap(row => { try { return [customMcpServerPolicy(row)]; } catch { return []; } });
}
