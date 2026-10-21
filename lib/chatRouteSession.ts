import "server-only";
import { getServerSession } from "next-auth/next";
import type { Session } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireMobileBearer, mobileAuthRefusal } from "@/lib/mobileAuthRoute";
import { MOBILE_AUTH_ERROR_CODES } from "@/lib/mobileAuthContract";
import { nativeChatBearerRoute } from "@/lib/nativeBearerGate";
import { isNativeAppOrigin } from "@/lib/nativeAppCors";
import { prisma } from "@/lib/prisma";

/** Never fall back to an ambient cookie when an Authorization header is present. */
export async function resolveChatRouteSession(request: Request): Promise<
  { session: Session | null; response?: never } | { session?: never; response: Response }
> {
  if (!request.headers.has("authorization")) return { session: (await getServerSession(authOptions)) ?? null };
  const origin = request.headers.get("origin");
  if (!nativeChatBearerRoute(new URL(request.url).pathname, request.method, process.env.TOMVERSE_NATIVE_CHAT_ENABLED === "true") || (origin && !isNativeAppOrigin(origin))) {
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
