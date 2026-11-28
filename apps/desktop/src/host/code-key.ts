import { z } from "zod";
import { DESKTOP_LIVE_ORIGIN } from "../../../../lib/desktopAuthContract";
import { parseExternalApiBearer } from "../../../../lib/externalApiKeyCore";
import { DesktopSessionRefused } from "./browser-login";

const confirmedKey = z.object({ ok: z.literal(true), keyPrefix: z.string().min(1).max(32) });

export function readCopiedCodeKey(text: string): string | null {
  if (text.length > 256) return null;
  const result = parseExternalApiBearer("Bearer " + text.trim());
  return result.kind === "key" ? result.key : null;
}

export class CodeKeyRefused extends Error {}

export async function verifyCodeKey(key: string, accessToken: string, signal: AbortSignal, origin = DESKTOP_LIVE_ORIGIN) {
  const response = await fetch(new URL("/api/auth/desktop/code-key", origin), {
    method: "POST", headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ key }), credentials: "omit", redirect: "error", cache: "no-store", signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401) throw new DesktopSessionRefused();
    if (response.status === 403) throw new CodeKeyRefused();
    throw new Error("Code key verification is unavailable.");
  }
  return confirmedKey.parse(await response.json()).keyPrefix;
}

const codeToken = z.object({ ok: z.literal(true), accessToken: z.string().min(1).max(8_192), expiresIn: z.number().int().min(1).max(600) });

/**
 * The short token Desktop Code's runtimes carry instead of the Desktop session token (POST /api/auth/desktop/code-token):
 * the same session, accepted only on the coding API calls the agent engine makes. Asked for with the session token,
 * in the main process; only its result is handed to a runtime.
 */
export async function requestCodeToken(accessToken: string, signal: AbortSignal, origin = DESKTOP_LIVE_ORIGIN) {
  const response = await fetch(new URL("/api/auth/desktop/code-token", origin), {
    method: "POST", headers: { Authorization: "Bearer " + accessToken },
    credentials: "omit", redirect: "error", cache: "no-store", signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401) throw new DesktopSessionRefused();
    throw new Error("The Code token is unavailable.");
  }
  const { accessToken: token, expiresIn } = codeToken.parse(await response.json());
  return { token, expiresAt: Date.now() + expiresIn * 1_000 };
}
