import { scryptSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const credentialSchema = z.object({
  submissionId: z.string().min(8).max(120),
  userId: z.string().min(1).max(120),
  email: z.string().email().transform(value => value.trim().toLowerCase()),
  appId: z.literal("app.tomverse.shell"),
  buildNumber: z.number().int().positive(),
  plan: z.enum(["Free", "Max"]).default("Free"),
  state: z.enum(["prepared", "submitted", "in_review", "unresolved"]),
  validUntil: z.string().datetime(),
  salt: z.string().regex(/^[a-f0-9]{64}$/),
  codeHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type MobileStoreReviewCredential = z.infer<typeof credentialSchema>;

/** One operator-managed, submission-scoped credential; disabled by default. */
export function readMobileStoreReviewCredential(env = process.env, now = Date.now()): MobileStoreReviewCredential | null {
  if (env.MOBILE_STORE_REVIEW_ENABLED !== "true") return null;
  try {
    const parsed = credentialSchema.safeParse(JSON.parse(env.MOBILE_STORE_REVIEW_CREDENTIAL_JSON || "null"));
    if (!parsed.success) return null;
    const expiry = Date.parse(parsed.data.validUntil);
    if (expiry <= now || expiry > now + 31 * 86_400_000) return null;
    return parsed.data;
  } catch { return null; }
}

export function hashMobileStoreReviewCode(credential: Pick<MobileStoreReviewCredential, "email" | "submissionId" | "appId" | "buildNumber" | "salt"> & { plan?: "Free" | "Max" }, code: string) {
  return scryptSync(code, [credential.salt, credential.email, credential.submissionId, credential.appId, credential.buildNumber, credential.plan ?? "Free"].join(":"), 32).toString("hex");
}

export function matchesMobileStoreReviewCode(credential: MobileStoreReviewCredential, input: { email: string; code: string; platform: string; appId?: string; buildNumber?: number }) {
  if (input.email.trim().toLowerCase() !== credential.email || input.platform !== "android" ||
      input.appId !== credential.appId || input.buildNumber !== credential.buildNumber || !/^\d{6}$/.test(input.code)) return false;
  return timingSafeEqual(Buffer.from(hashMobileStoreReviewCode(credential, input.code), "hex"), Buffer.from(credential.codeHash, "hex"));
}
