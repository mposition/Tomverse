import "server-only";
import { createHmac } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { mobileBillingEnvironment, parseMobileBillingProducts, type MobileStore, type revenueCatWebhookSchema } from "@/lib/mobileBillingCore";
import type { z } from "zod";

export function assertMobileOwnershipConfigured() {
  if (!process.env.MOBILE_BILLING_OWNERSHIP_KEY || process.env.MOBILE_BILLING_OWNERSHIP_KEY.length < 32) {
    throw new Error("Store ownership protection is not configured.");
  }
}
const digest = (value: string) => {
  assertMobileOwnershipConfigured();
  return createHmac("sha256", process.env.MOBILE_BILLING_OWNERSHIP_KEY!).update(value).digest("hex");
};
export const mobileStoreTransactionHash = (id: string) => digest(`transaction:${id}`);
export const mobileStoreOwnerHash = (billingId: string) => digest(`owner:${billingId}`);
export const storeOwnershipRefusal = () => {
  const error = new Error("Store purchase belongs to another account.");
  error.name = "StorePurchaseOwnershipError";
  return error;
};

/** Store-verified webhook only. No raw receipt, app-user ID or account FK is kept. */
export async function claimMobileStoreOwnership(tx: Prisma.TransactionClient, event: z.infer<typeof revenueCatWebhookSchema>["event"]) {
  const store: MobileStore = event.store === "APP_STORE" ? "app_store" : "play_store";
  const product = parseMobileBillingProducts(process.env.MOBILE_BILLING_PRODUCTS_JSON).find((p) => p.store === store && p.productId === event.product_id);
  if (!product) return;
  if (event.environment !== mobileBillingEnvironment()) throw new Error("Store environment mismatch.");
  if (product.kind === "subscription" && !event.original_transaction_id) throw new Error("Subscription ownership evidence is incomplete.");
  const hashes = [...new Set([event.transaction_id, ...(product.kind === "subscription" ? [event.original_transaction_id!] : [])].map(mobileStoreTransactionHash))].sort();
  const ownerHash = mobileStoreOwnerHash(event.app_user_id);
  // Sorted locks also serialize claims made concurrently by different accounts.
  for (const transactionHash of hashes) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`store-owner:${store}:${event.environment}:${transactionHash}`}))`;
    const where = { store_environment_transactionHash: { store, environment: event.environment, transactionHash } };
    const current = await tx.mobileStoreOwnership.findUnique({ where });
    if (current && (current.ownerHash !== ownerHash || current.kind !== product.kind)) throw storeOwnershipRefusal();
    if (!current) await tx.mobileStoreOwnership.create({ data: { store, environment: event.environment, transactionHash, ownerHash, kind: product.kind } });
  }
}
