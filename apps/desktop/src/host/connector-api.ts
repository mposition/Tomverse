import { z } from "zod";
import {
  connectorFailureCode, connectorInventory, connectorOAuthStart, connectorRequest, type ConnectorInput, type ConnectorInventory,
  type ConnectorRequest, type ConnectorResult,
} from "../connector-contract";
import { connectionEstablished, oauthCallbackPath, oauthStartTarget, type OAuthNavigation } from "../connector-oauth-policy";

export type ConnectorSend = (request: ConnectorRequest, accept?: string, timeout?: number) => Promise<Response>;
/** How the app-owned provider window ended. It carries no verdict about the connection itself. */
export type ConnectorOAuthEnd = Extract<OAuthNavigation, { kind: "callback" | "denied" }> | { kind: "closed" };

/**
 * Connector management over the account session: the web Plugins page's API, called from the main
 * process. Every mutation reports a typed result instead of throwing, and a connection is only
 * reported as made after the server's own connection list says so.
 */
export function createConnectorApi(deps: {
  send: ConnectorSend;
  /** Opens the provider's authorization page in the app-owned window and resolves when it ends. */
  authorize(url: URL): Promise<ConnectorOAuthEnd>;
  signal: AbortSignal;
}) {
  async function inventory(): Promise<ConnectorInventory> {
    const response = await deps.send(connectorRequest({ action: "inventory" }));
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Tomverse could not read the connector list.");
    }
    const value = connectorInventory.parse(await response.json());
    deps.signal.throwIfAborted();
    return value;
  }

  async function failure(response: Response): Promise<ConnectorResult> {
    const body = z.object({ code: z.string().max(80) }).safeParse(await response.json().catch(() => null));
    return { kind: "failed", code: connectorFailureCode(body.success ? body.data.code : undefined) };
  }

  async function oauth(input: Extract<ConnectorInput, { action: "oauth" | "oauthCustom" }>): Promise<ConnectorResult> {
    const before = await inventory().catch(() => null);
    const response = await deps.send(connectorRequest(input));
    deps.signal.throwIfAborted();
    if (!response.ok) return failure(response);
    const start = connectorOAuthStart.safeParse(await response.json().catch(() => null));
    if (!start.success) return { kind: "failed", code: "request_failed" };
    const serverId = input.action === "oauth" ? input.serverId : undefined;
    if (start.data.status === "connected") return { kind: "connected" };
    const target = oauthStartTarget(start.data.authorizationUrl);
    if (!target.ok) return target.kind === "unsupported" ? { kind: "unsupported", host: target.host } : { kind: "failed", code: "request_failed" };
    const end = await deps.authorize(target.url);
    deps.signal.throwIfAborted();
    if (end.kind !== "callback") return { kind: "cancelled" };
    try {
      // Tomverse answers the callback with a redirect to its own page. The transport refuses to follow it,
      // so the outcome is read from the connection list, never from the response or an address.
      const callback = await deps.send({ path: oauthCallbackPath(end), method: "GET" }, "text/html", 30_000);
      await callback.body?.cancel().catch(() => {});
    } catch {
      deps.signal.throwIfAborted();
    }
    const after = await inventory().catch(() => null);
    return after && connectionEstablished(before, after, serverId) ? { kind: "connected" } : { kind: "failed", code: "request_failed" };
  }

  async function run(input: ConnectorInput): Promise<ConnectorResult> {
    if (input.action === "oauth" || input.action === "oauthCustom") return oauth(input);
    const response = await deps.send(connectorRequest(input));
    deps.signal.throwIfAborted();
    if (!response.ok) return failure(response);
    if (input.action !== "decide" || !input.approve) {
      await response.body?.cancel().catch(() => {});
      return { kind: "ok" };
    }
    // An approved action reports whether the external service actually ran it.
    const outcome = z.object({ status: z.string().max(48) }).safeParse(await response.json().catch(() => null));
    return { kind: "ok", executed: outcome.success && outcome.data.status === "ok" };
  }

  return { inventory, run };
}
