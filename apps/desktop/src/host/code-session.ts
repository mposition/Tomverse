import { createHash } from "node:crypto";
import { DESKTOP_APP_ORIGIN } from "../../../../lib/nativeBearerGate";
import type { GatewayCredential } from "../../../tomverse-cli/src/gateway.js";
import type { Connection } from "./messages";

/**
 * Desktop Code on the account's signed-in Desktop session instead of a Code key (owner decision 2026-11-27,
 * docs/policy/external-api.md section 11.2), when the server reports `desktopCodeSession`.
 *
 * The connection the app hands a Code runtime carries no secret: its `key` is a stable identity derived from the
 * account id, so task history, receipts and the checks that compare them stay what they are with a key, and a
 * renewed access token does not change which history is shown. The token itself goes to each runtime only in the
 * "desktop-session" message (host/messages.ts), lives in that process's memory, is never put in an environment,
 * a command, a journal or a log, and is replaced on every renewal and cleared on sign-out, account change or expiry.
 */

const IDENTITY_PREFIX = "desktop-session-";

/** The session connection's identity for one account. Not a credential: it only names whose session it is. */
export function codeSessionIdentity(accountId: string) {
  return IDENTITY_PREFIX + createHash("sha256").update("tomverse-desktop-code-session\0" + accountId).digest("hex").slice(0, 40);
}

export function codeSessionConnection(accountId: string, origin: string): Connection {
  return { endpoint: origin + "/api/code/v1", key: codeSessionIdentity(accountId), session: true };
}

/** One runtime's copy of the token: the last one the app sent, for the identity it was sent for. */
export function createCodeSessionTokens() {
  let current: { identity: string; token: string | null } | null = null;
  return {
    set(identity: string, token: string | null) { current = { identity, token }; },
    /** The token in force for this identity now, or null (signed out, renewed for another account, never sent). */
    bearer(identity: string) { return current?.identity === identity ? current.token : null; },
    /** The gateway credential of a session connection: it reads the token on every request. */
    credential(connection: Connection): GatewayCredential {
      const identity = connection.key;
      return { identity, bearer: () => (current?.identity === identity ? current.token : null), headers: { origin: DESKTOP_APP_ORIGIN } };
    },
  };
}
