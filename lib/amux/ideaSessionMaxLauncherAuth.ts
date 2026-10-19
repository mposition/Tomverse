import { createHash, timingSafeEqual } from "node:crypto";

export const AMUX_V19_MAX_LAUNCHER_SECRET_ENV =
  "TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET";
export const AMUX_V19_MAX_LAUNCHER_ID = "amux-intake-max";

const SECRET = /^[A-Za-z0-9_-]{32,256}$/;

/** This credential belongs only to the fixed Ubuntu Max launcher. It must not
 * be shared with the v4 Agent or the AMUX synchronization worker. */
export function isAmuxV19MaxLauncherAuthorized(request: Request,
  configured: string | undefined, v4Secret?: string,
  syncSecret?: string): boolean {
  if (!configured || !SECRET.test(configured) ||
      configured === v4Secret || configured === syncSecret ||
      request.headers.get("x-amux-agent-id") !== AMUX_V19_MAX_LAUNCHER_ID) {
    return false;
  }
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const provided = authorization.slice(7);
  if (!SECRET.test(provided)) return false;
  return timingSafeEqual(createHash("sha256").update(configured).digest(),
    createHash("sha256").update(provided).digest());
}
