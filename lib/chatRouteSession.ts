import "server-only";
import { getServerSession } from "next-auth/next";
import type { Session } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireMobileBearer, mobileAuthRefusal } from "@/lib/mobileAuthRoute";
import { MOBILE_AUTH_ERROR_CODES } from "@/lib/mobileAuthContract";
import { nativeChatBearerRoute, nativeParityBearerRoute } from "@/lib/nativeBearerGate";
import { isNativeAppOrigin } from "@/lib/nativeAppCors";
import { prisma } from "@/lib/prisma";

/** Never fall back to an ambient cookie when an Authorization header is present. */
export async function resolveChatRouteSession(request: Request): Promise<
  { session: Session | null; response?: never } | { session?: never; response: Response }
> {
  if (!request.headers.has("authorization")) return { session: (await getServerSession(authOptions)) ?? null };
  const origin = request.headers.get("origin");
  const path = new URL(request.url).pathname;
  const parityEnabled = process.env.TOMVERSE_NATIVE_PARITY_ENABLED === "true";
  if (nativeParityBearerRoute(path, request.method, true) && !parityEnabled) {
    return { response: Response.json({ code: "NATIVE_PARITY_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } }) };
  }
  const enrolled = nativeChatBearerRoute(path, request.method, process.env.TOMVERSE_NATIVE_CHAT_ENABLED === "true") ||
    (process.env.TOMVERSE_NATIVE_CHAT_ENABLED === "true" && nativeParityBearerRoute(path, request.method, parityEnabled));
  if (!enrolled || (origin && !isNativeAppOrigin(origin))) {
    return { response: mobileAuthRefusal(MOBILE_AUTH_ERROR_CODES.tokenInvalid) };
  }
  const result = await requireMobileBearer(request);
  if (!result.ok) return { response: result.response };
  const user = await prisma.user.findUnique({
    where: { id: result.identity.userId }, select: { id: true, name: true, email: true, image: true, accountStatus: true },
  });
  if (!user || user.accountStatus !== "active") return { response: mobileAuthRefusal(MOBILE_AUTH_ERROR_CODES.refreshRejected) };
  return { session: { user: { id: user.id, name: user.name, email: user.email, image: user.image }, expires: new Date(Date.now() + 600_000).toISOString() } };
}

/** Sensitive account actions retain the same step-up window as the web. */
export async function resolveAccountRouteSession(request: Request) {
  if (!request.headers.has("authorization")) return resolveChatRouteSession(request);
  // Local implementation does not activate a new export/deletion authority.
  if (process.env.TOMVERSE_NATIVE_ACCOUNT_ENABLED !== "true") {
    return { response: Response.json({ code: "NATIVE_ACCOUNT_UNAVAILABLE" }, { status: 503 }) };
  }
  const authentication = await resolveChatRouteSession(request);
  if (authentication.response || !authentication.session) return authentication;
  const bearer = await requireMobileBearer(request);
  if (!bearer.ok) return { response: bearer.response };
  const family = await prisma.mobileTokenFamily.findFirst({
    where: { id: bearer.identity.familyId, userId: bearer.identity.userId, deviceId: bearer.identity.deviceId, revokedAt: null, absoluteExpiresAt: { gt: new Date() } },
    select: { createdAt: true },
  });
  if (!family) return { response: mobileAuthRefusal(MOBILE_AUTH_ERROR_CODES.refreshRejected) };
  // Rotation changes lastRotatedAt, never createdAt: refresh is not reauthentication.
  return { session: { ...authentication.session, user: { ...authentication.session.user, authenticatedAt: family.createdAt.toISOString() } } };
}
