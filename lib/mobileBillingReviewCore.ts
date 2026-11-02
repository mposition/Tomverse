import { readMobileStoreReviewCredential } from "@/lib/mobileAuthKeyring";
import { normalizeAdminList } from "@/lib/adminAuthCore";

export type IosReviewBillingUser = { id: string; email: string | null; accountStatus: string; plan: string; mobileBillingId: string | null };

/** No ordinary/test customer can opt into review billing by sending a flag. */
export function iosReviewSandboxUserAllowed(user: IosReviewBillingUser | null, environment: Record<string, string | undefined> = process.env, now = Date.now()) {
  if (!user || environment.MOBILE_BILLING_ENVIRONMENT !== "PRODUCTION" || environment.MOBILE_BILLING_IOS_REVIEW_SANDBOX_ENABLED !== "true") return false;
  const credential = readMobileStoreReviewCredential(environment, now, "ios");
  return Boolean(credential && credential.plan === "Free" && credential.userId === user.id &&
    credential.email === user.email?.toLowerCase() && user.accountStatus === "active" && user.mobileBillingId &&
    ["Free", "Pro", "Max"].includes(user.plan) &&
    !normalizeAdminList(environment.ADMIN_USER_IDS).includes(user.id.toLowerCase()) &&
    !normalizeAdminList(environment.ADMIN_EMAILS).includes(credential.email));
}
