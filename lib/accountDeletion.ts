import "server-only";

import { prisma } from "@/lib/prisma";
import { getUserChatUsageKey } from "@/lib/chatSecurity";
import { getStripe, isStripeConfigured } from "@/lib/stripe";
import { revokeAllUserSessions } from "@/lib/sessionSecurity";

const ACCOUNT_DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;

async function cancelStripeSubscription(
  subscriptionId: string | null | undefined,
  strict = false
) {
  if (!subscriptionId || !isStripeConfigured()) return;
  try {
    await getStripe().subscriptions.cancel(subscriptionId);
  } catch (error) {
    if (strict) throw error;
    console.error("Stripe subscription cancellation failed during account deletion:", error);
  }
}

export async function scheduleTomverseAccountDeletion(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, stripeSubscriptionId: true },
  });
  if (!user) return { scheduled: false as const };

  await cancelStripeSubscription(user.stripeSubscriptionId, true);
  const requestedAt = new Date();
  const scheduledFor = new Date(requestedAt.getTime() + ACCOUNT_DELETION_GRACE_MS);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      accountStatus: "pending_deletion",
      accountDeletionRequestedAt: requestedAt,
      accountDeletionScheduledFor: scheduledFor,
      subscriptionStatus: user.stripeSubscriptionId ? "canceled" : undefined,
      subscriptionCancelAtPeriodEnd: Boolean(user.stripeSubscriptionId),
      aiUsageRestricted: true,
      aiUsageRestrictedAt: requestedAt,
      aiUsageRestrictionReason: "Account deletion is scheduled.",
    },
  });
  await revokeAllUserSessions(user.id);
  return {
    scheduled: true as const,
    email: user.email,
    requestedAt,
    scheduledFor,
  };
}

export async function deleteTomverseAccount(
  userId: string,
  options?: { cancelSubscription?: boolean }
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      stripeSubscriptionId: true,
    },
  });

  if (!user) return { deleted: false as const };

  if (options?.cancelSubscription !== false) {
    await cancelStripeSubscription(user.stripeSubscriptionId);
  }

  await prisma.$transaction(async (tx) => {
    await tx.session.deleteMany({
      where: { userId: user.id },
    });

    await tx.account.deleteMany({
      where: { userId: user.id },
    });

    await tx.userSettings.deleteMany({
      where: { userId: user.id },
    });

    await tx.feedback.updateMany({
      where: { userId: user.id },
      data: {
        userId: null,
        email: null,
        message: "[deleted account]",
        traceId: null,
        userAgent: null,
      },
    });

    await tx.refundRequest.updateMany({
      where: { userId: user.id },
      data: {
        userId: null,
        email: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        reason: null,
      },
    });

    await tx.billingPromotionRedemption.deleteMany({
      where: { userId: user.id },
    });

    await tx.chatUsageBucket.deleteMany({
      where: {
        key: { startsWith: getUserChatUsageKey(user.id) },
      },
    });

    await tx.chatRequestLease.deleteMany({
      where: {
        subjectKey: getUserChatUsageKey(user.id),
      },
    });

    await tx.conversation.deleteMany({
      where: { userId: user.id },
    });

    await tx.conversationProject.deleteMany({
      where: { userId: user.id },
    });

    await tx.user.delete({
      where: { id: user.id },
    });
  });

  return { deleted: true as const, email: user.email };
}
