import "server-only";

import type Stripe from "stripe";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  normalizeBillingCurrency,
  type BillingCurrency,
} from "@/lib/billingMarkets";

type TransactionClient = Prisma.TransactionClient | PrismaClient;

const stripeId = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : value?.id || null;

export type CheckoutBillingSnapshot = {
  currency: BillingCurrency;
  country: string;
  expectedAmountMinor: number;
  amountUsdMicroUsd: bigint;
  usdConversionRate: string | null;
  usdConversionSource: string;
  pricingVersion: number;
};

export const checkoutBillingMetadata = (
  snapshot: CheckoutBillingSnapshot
): Record<string, string> => ({
  billingCurrency: snapshot.currency,
  billingCountry: snapshot.country,
  billingExpectedAmountMinor: String(snapshot.expectedAmountMinor),
  billingUsdAmountMicroUsd: String(snapshot.amountUsdMicroUsd),
  billingUsdConversionRate: snapshot.usdConversionRate || "",
  billingUsdConversionSource: snapshot.usdConversionSource,
  billingPricingVersion: String(snapshot.pricingVersion),
});

const safeInteger = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

export function billingSnapshotFromCheckoutSession(
  session: Stripe.Checkout.Session
): CheckoutBillingSnapshot {
  const currency = normalizeBillingCurrency(session.currency);
  const amountMinor = session.amount_total;
  const expectedAmountMinor = safeInteger(
    session.metadata?.billingExpectedAmountMinor
  );
  const amountUsdMicroUsd = session.metadata?.billingUsdAmountMicroUsd;
  const parsedUsd = amountUsdMicroUsd ? BigInt(amountUsdMicroUsd) : null;
  if (!currency || amountMinor === null || expectedAmountMinor === null || parsedUsd === null) {
    throw new Error("Checkout billing snapshot is incomplete.");
  }
  if (session.metadata?.billingCurrency?.toUpperCase() !== currency) {
    throw new Error("Checkout currency did not match the signed server snapshot.");
  }
  if (amountMinor !== expectedAmountMinor) {
    throw new Error("Checkout amount did not match the signed server snapshot.");
  }
  return {
    currency,
    country: session.metadata?.billingCountry || "ZZ",
    expectedAmountMinor,
    amountUsdMicroUsd: parsedUsd,
    usdConversionRate: session.metadata?.billingUsdConversionRate || null,
    usdConversionSource:
      session.metadata?.billingUsdConversionSource || "catalog_fallback",
    pricingVersion: safeInteger(session.metadata?.billingPricingVersion) || 1,
  };
}

export async function recordBillingTransactionFromCheckout({
  db,
  session,
  userId,
  productType,
  productId,
  billingInterval,
  snapshot,
}: {
  db: TransactionClient;
  session: Stripe.Checkout.Session;
  userId: string;
  productType: "subscription" | "credit_pack";
  productId: string;
  billingInterval?: "monthly" | "annual" | null;
  snapshot?: CheckoutBillingSnapshot;
}) {
  const billing = snapshot || billingSnapshotFromCheckoutSession(session);
  const paidAt = new Date(
    (session.created || Math.floor(Date.now() / 1_000)) * 1_000
  );
  return db.billingTransaction.upsert({
    where: { stripeCheckoutSessionId: session.id },
    create: {
      userId,
      productType,
      productId,
      billingInterval: billingInterval || null,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: stripeId(session.payment_intent),
      stripeSubscriptionId: stripeId(session.subscription),
      amountPaidMinor: billing.expectedAmountMinor,
      currency: billing.currency,
      amountPaidUsdMicroUsd: billing.amountUsdMicroUsd,
      usdConversionRate: billing.usdConversionRate,
      usdConversionSource: billing.usdConversionSource,
      pricingVersion: billing.pricingVersion,
      status: "paid",
      paidAt,
    },
    update: {},
  });
}
