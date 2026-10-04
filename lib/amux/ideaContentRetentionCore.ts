import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** The route can be staged, but each environment remains dark until its own
 * operator-controlled switch and distinct trigger secret are provisioned. */
export const AMUX_V4_CONTENT_RETENTION_CODE_LATCH = true;
export const AMUX_V4_CONTENT_RETENTION_ENV =
  "TOMVERSE_AMUX_V4_CONTENT_RETENTION";
export const AMUX_V4_CONTENT_RETENTION_SECRET_ENV =
  "TOMVERSE_AMUX_V4_CONTENT_RETENTION_SECRET";
export const AMUX_V4_CONTENT_RETENTION_AGENT_ID = "amux-v4-intake-retention";

export const amuxV4ContentRetentionEnabled = (value: string | undefined) =>
  AMUX_V4_CONTENT_RETENTION_CODE_LATCH && value === "enabled";

export const amuxV4ContentRetentionRequestSchema = z.object({
  schemaVersion: z.literal(1),
}).strict();

const SECRET = /^[A-Za-z0-9_-]{32,256}$/;

export function isAmuxV4ContentRetentionAuthorized(request: Request,
  configured: string | undefined, otherSecrets: readonly (string | undefined)[]):
  boolean {
  if (typeof configured !== "string" || !SECRET.test(configured) ||
      otherSecrets.includes(configured) ||
      request.headers.get("x-amux-agent-id") !==
        AMUX_V4_CONTENT_RETENTION_AGENT_ID) return false;
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const provided = authorization.slice(7);
  if (!SECRET.test(provided)) return false;
  return timingSafeEqual(createHash("sha256").update(configured).digest(),
    createHash("sha256").update(provided).digest());
}
