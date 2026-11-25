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
