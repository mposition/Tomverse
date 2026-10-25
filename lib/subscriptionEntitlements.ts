import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { effectivePlanForAccess } from "@/lib/foundingTesterPassCore";

export const lockSubscriptionAccount = (tx: Prisma.TransactionClient, userId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`subscription:${userId}`}))`;

/** Serialize only short DB writes; provider HTTP requests happen before this. */
export async function applyWebSubscriptionSnapshot(input: {
  userId: string; subscriptionId: string | null; priceId: string | null;
  plan: string; status: string; periodEnd: Date | null; interval: string | null;
  cancelAtPeriodEnd: boolean; observedAt: Date; deletedSubscriptionId?: string;
}) {
  return prisma.$transaction(async (tx) => {
    await lockSubscriptionAccount(tx, input.userId);
    const user = await tx.user.findUniqueOrThrow({ where: { id: input.userId } });
    if (user.subscriptionSyncedAt && user.subscriptionSyncedAt > input.observedAt) return false;
    if (input.deletedSubscriptionId && user.stripeSubscriptionId && user.stripeSubscriptionId !== input.deletedSubscriptionId) return false;
    const data = {
      webSubscriptionPlan: input.plan, subscriptionStatus: input.status,
      subscriptionCurrentPeriodEnd: input.periodEnd, subscriptionBillingInterval: input.interval,
      subscriptionCancelAtPeriodEnd: input.cancelAtPeriodEnd, subscriptionSyncedAt: input.observedAt,
      stripeSubscriptionId: input.subscriptionId, stripePriceId: input.priceId,
    };
    await tx.user.update({ where: { id: user.id }, data: { ...data, plan: effectivePlanForAccess({ ...user, ...data }) } });
    return true;
  });
}
