import "server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { chatResponseAttemptRequestPayloadDigest } from "./chatResponseAttemptCore";

const pick = z.object({
  modelId: z.string().min(1).max(300),
  rewrite: z.string().max(1_500).nullable(),
  requiresFileGeneration: z.boolean().optional(),
  searchQueries: z.array(z.string().max(400)).max(2).optional(),
  requiresLocation: z.boolean().optional(),
}).strict();

const decision = z.object({
  requestDigest: z.string().length(64),
  routerDigest: z.string().length(64).nullable(),
  traceId: z.string().min(1).max(160),
  searchPlan: z.boolean(),
  pick: pick.nullable(),
  image: z.discriminatedUnion("image", [
    z.object({ image: z.literal(false) }).strict(),
    z.object({ image: z.literal(true), modelId: z.string().max(300).nullable(), preset: z.enum(["draft", "standard", "final"]).nullable(),
      prompt: z.string().max(1_500).nullable(), edit: z.boolean() }).strict(),
  ]),
  expiresAt: z.number().int(),
}).strict();

export type RouterLocationPick = z.infer<typeof pick>;
export type RouterLocationContinuation = z.infer<typeof decision>;
export const ROUTER_LOCATION_TTL_MS = 5 * 60_000;
export const MAX_ROUTER_LOCATION_TOKEN_CHARS = 40_000;
export const routerLocationDigest = (value: unknown) => chatResponseAttemptRequestPayloadDigest(["router-location.v1", value]);
const key = (secret: string) => createHmac("sha256", secret).update("chat-router-location-continuation.v1").digest();

/** The client can return the server's pick, but cannot inspect a rewrite, search query or authorization binding. */
export function sealRouterLocation(value: RouterLocationContinuation, secret: string) {
  if (!secret) throw Error("Missing Chat secret");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(decision.parse(value)), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export function openRouterLocation(token: unknown, requestDigest: string, secret: string, now = Date.now()) {
  if (!secret || typeof token !== "string" || token.length > MAX_ROUTER_LOCATION_TOKEN_CHARS ||
    !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const bytes = Buffer.from(token, "base64url");
    if (bytes.length <= 28 || bytes.toString("base64url") !== token) return null;
    const cipher = createDecipheriv("aes-256-gcm", key(secret), bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    const plain = Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
    const value = decision.parse(JSON.parse(plain.toString("utf8")));
    return value.requestDigest === requestDigest && value.expiresAt > now ? value : null;
  } catch { return null; }
}
