import { scryptSync, timingSafeEqual } from "node:crypto";
import type { MobileStoreReviewCredential } from "@/lib/mobileAuthKeyring";
export { MOBILE_STORE_REVIEW_STATUS, isMobileStoreReviewAddress, mobileStoreReviewSessionAllowed, readMobileStoreReviewCredential, readMobileStoreReviewCredentials, type MobileStoreReviewCredential } from "@/lib/mobileAuthKeyring";

export function hashMobileStoreReviewCode(credential: Pick<MobileStoreReviewCredential, "email" | "submissionId" | "appId" | "buildNumber" | "salt"> & { plan?: "Free" | "Max" }, code: string) {
  return scryptSync(code, [credential.salt, credential.email, credential.submissionId, credential.appId, credential.buildNumber, credential.plan ?? "Free"].join(":"), 32).toString("hex");
}

export function matchesMobileStoreReviewCode(credential: MobileStoreReviewCredential, input: { email: string; code: string; platform: string; appId?: string; buildNumber?: number }) {
  const platform = credential.email.startsWith("appstore-review") ? "ios" : "android";
  if (input.email.trim().toLowerCase() !== credential.email || input.platform !== platform ||
      input.appId !== credential.appId || input.buildNumber !== credential.buildNumber || !/^\d{6}$/.test(input.code)) return false;
  return timingSafeEqual(Buffer.from(hashMobileStoreReviewCode(credential, input.code), "hex"), Buffer.from(credential.codeHash, "hex"));
}
