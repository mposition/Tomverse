import "server-only";

import type { Session } from "next-auth";
import { getServerSession } from "next-auth/next";
import { hasRecentAccountAuthentication } from "@/lib/adminReauthentication";
import { authOptions } from "@/lib/auth";
import { DESKTOP_APP_ORIGIN, desktopRemoteControlEnabled } from "@/lib/nativeBearerGate";

/**
 * The web half of Desktop remote control: the signed-in browser session of the account, never a bearer. A Desktop or
 * mobile token cannot read or answer through these routes, and a Desktop's own embedded settings session can only look
 * (it carries no web sign-in time).
 */

export const remoteJson = (status: number, body: object) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function desktopRemoteWebSession(request: Request): Promise<{ session: Session; response?: never } | { session?: never; response: Response }> {
  if (!desktopRemoteControlEnabled()) return { response: remoteJson(503, { ok: false, code: "NOT_AVAILABLE" }) };
  if (request.headers.has("authorization") || request.headers.get("origin") === DESKTOP_APP_ORIGIN) {
    return { response: remoteJson(401, { ok: false, code: "SESSION_REQUIRED" }) };
  }
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return { response: remoteJson(401, { ok: false, code: "UNAUTHENTICATED" }) };
  return { session };
}

/**
 * Whether this session may act (answer, stop, send a follow-up) rather than only look: a web sign-in within the
 * account step-up window (`hasRecentAccountAuthentication`). A Desktop device's own sign-in time does not count here:
 * the answer has to come from the person at another device, signed in there.
 */
export const desktopRemoteMayAct = (session: Session) =>
  hasRecentAccountAuthentication({ ...session, user: { ...session.user, desktopAuthenticatedAt: undefined } });
