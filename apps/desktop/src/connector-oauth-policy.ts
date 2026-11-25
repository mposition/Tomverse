import { CONNECTOR_OAUTH_CALLBACK_PATH, type ConnectorConnection, type ConnectorInventory } from "./connector-contract";
import { linkViewUrl } from "./web-view-contract";

/**
 * Pure rules for the app-owned connector sign-in window. The window shows the provider's own
 * pages; the Tomverse callback is recognised here and answered by the main process, so the
 * account session cookie never enters the window's session.
 */

/** Providers that refuse OAuth inside an embedded browser; the user is told instead of redirected. */
const EMBEDDED_OAUTH_REFUSED = /(^|\.)(google\.com|googleapis\.com)$/;

export function embeddedOAuthRefused(hostname: string): boolean {
  return EMBEDDED_OAUTH_REFUSED.test(hostname.toLowerCase().replace(/\.$/, ""));
}

/** Whether a catalogued server's own address already tells that its sign-in cannot run in the app. */
export function serverSignInRefused(origin: string): string | null {
  let host: string;
  try { host = new URL(origin).hostname; } catch { return null; }
  return embeddedOAuthRefused(host) ? host : null;
}

export type OAuthStart = { ok: true; url: URL } | { ok: false; kind: "invalid" } | { ok: false; kind: "unsupported"; host: string };

/** The provider authorization page the server asked the app to open. */
export function oauthStartTarget(value: string): OAuthStart {
  const url = linkViewUrl(value);
  if (!url) return { ok: false, kind: "invalid" };
  if (embeddedOAuthRefused(url.hostname)) return { ok: false, kind: "unsupported", host: url.hostname };
  return { ok: true, url };
}

export type OAuthNavigation =
  | { kind: "allow" }
  | { kind: "block" }
  | { kind: "denied" }
  | { kind: "callback"; state: string; code: string; issuer?: string };

const stateShape = /^[A-Za-z0-9_-]{43}$/;

/** What the sign-in window does with one main-frame navigation. */
export function classifyOAuthNavigation(value: string, accountOrigin: string): OAuthNavigation {
  let target: URL;
  try { target = new URL(value); } catch { return { kind: "block" }; }
  if (target.origin === accountOrigin) {
    if (target.pathname !== CONNECTOR_OAUTH_CALLBACK_PATH || target.username || target.password) return { kind: "block" };
    if (target.searchParams.has("error")) return { kind: "denied" };
    const state = target.searchParams.get("state") ?? "";
    const code = target.searchParams.get("code") ?? "";
    const issuer = target.searchParams.get("iss") ?? undefined;
    if (!stateShape.test(state) || !code || code.length > 4_096 || (issuer !== undefined && issuer.length > 2_048)) {
      return { kind: "denied" };
    }
    return { kind: "callback", state, code, ...(issuer ? { issuer } : {}) };
  }
  return linkViewUrl(value) ? { kind: "allow" } : { kind: "block" };
}

/** Subresources of a provider page: public hosts only, so a page cannot reach the local network. */
export { allowsSubresource as allowsOAuthSubresource } from "./web-view-contract";

/** The path the main process asks Tomverse to complete, built from the validated callback parameters. */
export function oauthCallbackPath(callback: Extract<OAuthNavigation, { kind: "callback" }>): string {
  const query = new URLSearchParams({ state: callback.state, code: callback.code });
  if (callback.issuer) query.set("iss", callback.issuer);
  return CONNECTOR_OAUTH_CALLBACK_PATH + "?" + query.toString();
}

const sameConnection = (before: ConnectorConnection | undefined, after: ConnectorConnection) =>
  before !== undefined && before.status === "connected" && after.version <= before.version;

/**
 * Whether the server now holds a connection this sign-in produced: connected, and new or advanced
 * since the sign-in began. The window's address is never evidence.
 */
export function connectionEstablished(before: ConnectorInventory | null, after: ConnectorInventory, serverId?: string): boolean {
  return after.connections.some((connection) => connection.status === "connected" &&
    (serverId === undefined || connection.serverId === serverId) &&
    !sameConnection(before?.connections.find(({ id }) => id === connection.id), connection));
}
