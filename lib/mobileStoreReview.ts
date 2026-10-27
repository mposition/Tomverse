import "server-only";
import { consumeApiRateLimit } from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";
import { normalizeAdminList } from "@/lib/adminAuthCore";
import { matchesMobileStoreReviewCode, readMobileStoreReviewCredential } from "@/lib/mobileStoreReviewCore";

export async function requestMobileStoreReviewCode(request: Request, email: string) {
  const credential = readMobileStoreReviewCredential();
  if (!credential || email !== credential.email) return false;
  await consumeApiRateLimit(request, credential.userId, "mobile-store-review-request", { minute: 3, day: 50 });
  // The private store notes supply this code; never email or disclose it here.
  return true;
}

export async function verifyMobileStoreReviewCode(request: Request, input: { email: string; code: string; platform: string; appId?: string; buildNumber?: number }) {
  const credential = readMobileStoreReviewCredential();
  if (!credential || input.email !== credential.email) return null;
  // Spend an account-wide budget before the slow hash, including valid attempts.
  await consumeApiRateLimit(request, credential.userId, "mobile-store-review-verify", { minute: 5, day: 100 });
  const refused = { ok: false as const, reason: "invalid_or_expired" };
  if (!matchesMobileStoreReviewCode(credential, input)) return refused;
  const user = await prisma.user.findUnique({ where: { id: credential.userId }, select: { id: true, email: true, plan: true, emailVerified: true, emailLoginEnabled: true, accountStatus: true } });
  if (!user || user.email?.trim().toLowerCase() !== credential.email || user.plan !== "Free" ||
      !user.emailVerified || !user.emailLoginEnabled || user.accountStatus !== "active" ||
      normalizeAdminList(process.env.ADMIN_USER_IDS).includes(user.id.toLowerCase()) ||
      normalizeAdminList(process.env.ADMIN_EMAILS).includes(credential.email)) return refused;
  return { ok: true as const, userId: user.id };
}
