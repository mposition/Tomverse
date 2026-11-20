import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { ChatAccessError } from "./chatSecurity";
import { ROUTER_LOCATION_TTL_MS } from "./chatRouterLocationContinuation";

export const routerLocationRefused = () => new ChatAccessError(409, "CHAT_ROUTER_LOCATION_UNAVAILABLE",
  "The saved routing decision is no longer available.");
export type RouterLocationClaim = { conversationId: string; sourceUserMessageId: string; assistantMessageId: string };

export async function claimRouterLocation(key: RouterLocationClaim, requestDigest: string) {
  const expiresAt = new Date(Date.now() + ROUTER_LOCATION_TTL_MS);
  try {
    await prisma.chatRouterLocationPreparation.create({ data: { ...key, requestDigest, expiresAt } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw routerLocationRefused();
    throw error;
  }
  return expiresAt.getTime();
}

export async function consumeRouterLocation(key: RouterLocationClaim, requestDigest: string) {
  const now = new Date();
  const result = await prisma.chatRouterLocationPreparation.updateMany({
    where: { ...key, requestDigest, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  if (result.count !== 1) throw routerLocationRefused();
}

export const routerLocationResponse = (requiresLocation: true | null, traceId: string, details?: { continuation: string } | { locationRateLimited: true }) =>
  Response.json({ requiresLocation, ...details }, {
    headers: { "X-Chat-Response-Mode": "router-location", "Cache-Control": "private, no-store", "X-Request-ID": traceId },
  });
