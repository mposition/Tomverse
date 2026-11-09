import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { responseLatencyDimensionsSchema } from "@/lib/responseLatencyCore";

const payloadSchema = responseLatencyDimensionsSchema.extend({
  id: z.string().uuid(), expiresAt: z.number().int(), purpose: z.literal("response-latency-v1"),
}).strict();
const sign = (payload: string, secret: string) => createHmac("sha256", secret).update(`response-latency:${payload}`).digest();

/** A one-sample capability, not an authentication token or authority to run AI. */
export function createResponseLatencyToken(
  id: string,
  product: "chat" | "review" | "unknown",
  mode: "auto" | "manual" | "unknown",
  now = Date.now(),
) {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return null;
  const payload = Buffer.from(JSON.stringify({ id, product, mode, modelId: null, provider: null,
    expiresAt: now + 3_600_000, purpose: "response-latency-v1" })).toString("base64url");
  return `${payload}.${sign(payload, secret).toString("base64url")}`;
}

export function verifyResponseLatencyToken(token: string, now = Date.now()) {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret || token.length > 2_048) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const actual = Buffer.from(parts[1], "base64url");
    const expected = sign(parts[0], secret);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const payload = payloadSchema.parse(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")));
    return payload.expiresAt > now && payload.expiresAt <= now + 3_600_000 ? payload : null;
  } catch { return null; }
}
