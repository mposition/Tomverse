import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { mobileBillingEnvironment, parseMobileBillingProducts } from "@/lib/mobileBillingCore";
import { readMobileStoreReviewCredential } from "@/lib/mobileAuthKeyring";
import { iosReviewSandboxUserAllowed } from "@/lib/mobileBillingReviewCore";

const select = { id: true, email: true, accountStatus: true, plan: true, mobileBillingId: true } as const;

export async function mobileSubscriptionEnvironment(userId: string) {
  const normal = mobileBillingEnvironment();
  if (normal !== "PRODUCTION" || process.env.MOBILE_BILLING_IOS_REVIEW_SANDBOX_ENABLED !== "true") return normal;
  const credential = readMobileStoreReviewCredential(process.env, Date.now(), "ios");
  if (!credential || credential.userId !== userId) return normal;
  const user = await prisma.user.findUnique({ where: { id: userId }, select });
  return iosReviewSandboxUserAllowed(user) ? "SANDBOX" : normal;
}

export async function iosReviewSandboxWebhookAllowed(event: { store?: string; environment?: string; app_user_id?: unknown; product_id?: unknown }, db: Pick<Prisma.TransactionClient, "user"> = prisma) {
  if (event.store !== "APP_STORE" || event.environment !== "SANDBOX" ||
      mobileBillingEnvironment() !== "PRODUCTION" || process.env.MOBILE_BILLING_IOS_REVIEW_SANDBOX_ENABLED !== "true" ||
      typeof event.app_user_id !== "string" || event.app_user_id.length > 200 || typeof event.product_id !== "string") return false;
  const products = parseMobileBillingProducts(process.env.MOBILE_BILLING_PRODUCTS_JSON);
  if (!products.some(product => product.store === "app_store" && product.kind === "subscription" && product.productId === event.product_id)) return false;
  const credential = readMobileStoreReviewCredential(process.env, Date.now(), "ios");
  if (!credential) return false;
  const user = await db.user.findUnique({ where: { mobileBillingId: event.app_user_id }, select });
  return iosReviewSandboxUserAllowed(user);
}
