import type { Language } from "../../../../lib/language";
import { mcpConnectorCopy } from "../../../../lib/mcpConnectorCopy";
import { desktopConnectorCopy } from "../../../../locales/desktopConnectors";
import { connectorFailureKey, type ConnectorResult } from "../connector-contract";

export type ConnectorMessage = { tone: "error" | "status"; text: string };

/** What the page tells the user after an action; nothing when the action needs no message. */
export function describeConnectorResult(result: ConnectorResult | undefined, language: Language): ConnectorMessage | undefined {
  const c = mcpConnectorCopy[language];
  const d = desktopConnectorCopy[language];
  if (!result) return { tone: "error", text: c.error };
  switch (result.kind) {
    case "ok": return result.executed ? { tone: "status", text: c.executed } : undefined;
    case "connected": return { tone: "status", text: c.connected };
    case "cancelled": return { tone: "status", text: d.oauthCancelled };
    case "unsupported": return { tone: "error", text: d.oauthUnsupportedHost.replace("{host}", () => result.host) };
    case "failed": return { tone: "error", text: c[connectorFailureKey(result.code)] };
  }
}
