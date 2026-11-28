import { z } from "zod";
import { PLUGIN_SCOPE_LIMITS } from "../../../lib/pluginScopeLimits";

/**
 * Connector (Plugin, MCP) management for Desktop. The renderer names an action; the main process
 * maps it to the same `/api/mcp/*` routes the web Plugins page uses, over the account session
 * cookie. The renderer never supplies a path, and every response is parsed before it is returned.
 */

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const serverId = z.string().regex(/^[a-z0-9-]{1,40}$/);
const scope = z.string().min(1).max(200);
const toolName = z.string().min(1).max(128);
const auth = z.enum(["none", "bearer", "oauth"]);

const tool = z.object({ name: toolName, mode: z.enum(["read", "confirm"]) });

export const connectorServer = z.object({
  id: serverId, name: z.string().min(1).max(200), auth, origin: z.string().max(300),
  custom: z.boolean().optional(),
  scopes: z.array(scope).max(512).optional(), defaultScopes: z.array(scope).max(PLUGIN_SCOPE_LIMITS.chosen).optional(),
});
export const connectorConnection = z.object({
  id: identifier, serverId, name: z.string().min(1).max(200), status: z.string().max(48),
  catalog: z.array(tool).max(200), grants: z.array(tool).max(32),
  version: z.number().int().positive(), scopes: z.array(scope).max(PLUGIN_SCOPE_LIMITS.chosen).optional(),
});
export const connectorInvocation = z.object({
  id: identifier, connectionId: identifier, toolName, state: z.string().max(48),
  arguments: z.unknown(), expiresAt: z.string().max(64),
});
export const connectorInventory = z.object({
  enabled: z.boolean(), customEnabled: z.boolean().optional(),
  servers: z.array(connectorServer).max(512),
  connections: z.array(connectorConnection).max(512),
  invocations: z.array(connectorInvocation).max(64),
});
export type ConnectorServer = z.infer<typeof connectorServer>;
export type ConnectorConnection = z.infer<typeof connectorConnection>;
export type ConnectorInvocation = z.infer<typeof connectorInvocation>;
export type ConnectorInventory = z.infer<typeof connectorInventory>;
export const EMPTY_CONNECTOR_INVENTORY: ConnectorInventory = { enabled: false, servers: [], connections: [], invocations: [] };

const customServer = z.object({
  url: z.string().trim().min(1).max(2_048), name: z.string().trim().max(80).optional(), auth,
}).strict();
const credential = z.string().max(4_096).optional();

export const connectorInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect"), serverId, credential }).strict(),
  z.object({ action: z.literal("connectCustom"), custom: customServer, credential }).strict(),
  z.object({ action: z.literal("oauth"), serverId,
    scopes: z.array(scope).min(1).max(PLUGIN_SCOPE_LIMITS.chosen).optional() }).strict(),
  z.object({ action: z.literal("oauthCustom"), custom: customServer.extend({ auth: z.literal("oauth") }) }).strict(),
  z.object({ action: z.literal("saveTools"), connectionId: identifier, tools: z.array(toolName).max(32),
    version: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("disconnect"), connectionId: identifier }).strict(),
  z.object({ action: z.literal("decide"), invocationId: identifier, approve: z.boolean() }).strict(),
  z.object({ action: z.literal("confirmOutcome"), invocationId: identifier,
    verifiedOutcome: z.enum(["completed", "not_executed"]) }).strict(),
]);
export type ConnectorInput = z.infer<typeof connectorInput>;

/** Error codes the Desktop UI explains; anything else is reported as a generic failure. */
export const CONNECTOR_FAILURE_CODES = [
  "outcome_unknown", "previous_outcome_unknown", "invalid_custom_url", "unsafe_endpoint", "unsafe_address",
  "custom_server_limit", "oauth_discovery_failed", "sign_in_required", "oauth_flow_expired", "oauth_issuer_mismatch",
  "connector_disabled", "oauth_flow_limit", "request_failed",
] as const;
export type ConnectorFailureCode = (typeof CONNECTOR_FAILURE_CODES)[number];
export const connectorResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok"), executed: z.boolean().optional() }),
  z.object({ kind: z.literal("connected") }),
  z.object({ kind: z.literal("cancelled") }),
  z.object({ kind: z.literal("unsupported"), host: z.string().max(253) }),
  z.object({ kind: z.literal("failed"), code: z.enum(CONNECTOR_FAILURE_CODES) }),
]);
export type ConnectorResult = z.infer<typeof connectorResult>;

export function connectorFailureCode(value: unknown): ConnectorFailureCode {
  return CONNECTOR_FAILURE_CODES.find((code) => code === value) ?? "request_failed";
}

/** The web page's wording for each failure, as a key of the shared connector copy. */
export function connectorFailureKey(code: ConnectorFailureCode) {
  switch (code) {
    case "outcome_unknown": case "previous_outcome_unknown": return "unknown";
    case "invalid_custom_url": case "unsafe_endpoint": case "unsafe_address": return "customUrlRefused";
    case "custom_server_limit": return "customLimit";
    case "oauth_discovery_failed": return "customOAuthUnsupported";
    case "sign_in_required": return "signIn";
    case "oauth_flow_expired": return "expired";
    case "oauth_issuer_mismatch": case "connector_disabled": return "serverSetup";
    default: return "error";
  }
}

export type ConnectorRequest = { path: string; method: "GET" | "POST" | "PATCH" | "DELETE"; body?: object };

export function connectorRequest(input: ConnectorInput | { action: "inventory" }): ConnectorRequest {
  switch (input.action) {
    case "inventory":
      return { path: "/api/mcp/connections", method: "GET" };
    case "connect":
      return { path: "/api/mcp/connections", method: "POST",
        body: { serverId: input.serverId, ...(input.credential ? { credential: input.credential } : {}) } };
    case "connectCustom":
      return { path: "/api/mcp/connections", method: "POST",
        body: { custom: customBody(input.custom), ...(input.credential ? { credential: input.credential } : {}) } };
    case "oauth":
      return { path: "/api/mcp/oauth/start", method: "POST",
        body: { serverId: input.serverId, ...(input.scopes ? { scopes: input.scopes } : {}) } };
    case "oauthCustom":
      return { path: "/api/mcp/oauth/start", method: "POST", body: { custom: customBody(input.custom) } };
    case "saveTools":
      return { path: "/api/mcp/connections/" + encodeURIComponent(input.connectionId), method: "PATCH",
        body: { tools: input.tools, version: input.version } };
    case "disconnect":
      return { path: "/api/mcp/connections/" + encodeURIComponent(input.connectionId), method: "DELETE" };
    case "decide":
      return { path: "/api/mcp/invocations/" + encodeURIComponent(input.invocationId), method: "POST",
        body: { approve: input.approve } };
    case "confirmOutcome":
      return { path: "/api/mcp/invocations/" + encodeURIComponent(input.invocationId), method: "POST",
        body: { verifiedOutcome: input.verifiedOutcome } };
  }
}

function customBody(custom: { url: string; name?: string; auth: "none" | "bearer" | "oauth" }) {
  return { url: custom.url, auth: custom.auth, ...(custom.name ? { name: custom.name } : {}) };
}

/** What OAuth start returns: an immediate connection, or the provider page to authorize on. */
export const connectorOAuthStart = z.discriminatedUnion("status", [
  z.object({ status: z.literal("connected") }),
  z.object({ status: z.literal("authorization_required"), authorizationUrl: z.string().min(1).max(4_096) }),
]);

export const CONNECTOR_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";
