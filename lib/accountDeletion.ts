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

// Used only when scheduling a deletion (not the permanent-delete path below,
// which still cancels immediately). Always awaited before any DB write, so
// a Stripe failure here throws and aborts the whole request -- the account
// never ends up pending_deletion with a subscription that's still set to
// auto-renew.
async function scheduleStripeSubscriptionCancellation(
  subscriptionId: string | null | undefined
) {
  if (!subscriptionId || !isStripeConfigured()) return;
  await getStripe().subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  });
}

export async function scheduleTomverseAccountDeletion(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, stripeSubscriptionId: true },
  });
  if (!user) return { scheduled: false as const };

  await scheduleStripeSubscriptionCancellation(user.stripeSubscriptionId);
  const requestedAt = new Date();
  const scheduledFor = new Date(requestedAt.getTime() + ACCOUNT_DELETION_GRACE_MS);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      accountStatus: "pending_deletion",
      accountDeletionRequestedAt: requestedAt,
      accountDeletionScheduledFor: scheduledFor,
      // subscriptionStatus is intentionally left alone -- the subscription
      // is still genuinely active (just non-renewing), and the
      // customer.subscription.updated webhook is the source of truth for
      // it. plan/stripeSubscriptionId/stripePriceId/period end are also
      // untouched, so a restore within the grace period needs no separate
      // entitlement bookkeeping: it's still exactly what it was.
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

export type RestoreAccountResult =
  | "restored"
  | "already_active"
  | "deletion_in_progress"
  | "not_found";

// Deliberately makes no Stripe calls: scheduleTomverseAccountDeletion above
// never actually cancels the subscription (cancel_at_period_end only), so
// there is nothing to resume, and per product policy cancelling a deletion
// must not be treated as restoring auto-renewal consent -- cancel_at_period_end
// stays exactly as Stripe already has it either way.
export async function restoreTomverseAccount(
  userId: string
): Promise<RestoreAccountResult> {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { accountStatus: true },
  });
  if (!existing) return "not_found";
  if (existing.accountStatus === "active") return "already_active";
  if (existing.accountStatus !== "pending_deletion") {
    return "deletion_in_progress";
  }

  const claimed = await prisma.user.updateMany({
    where: { id: userId, accountStatus: "pending_deletion" },
    data: {
      accountStatus: "active",
      accountDeletionRequestedAt: null,
      accountDeletionScheduledFor: null,
      aiUsageRestricted: false,
      aiUsageRestrictedAt: null,
      aiUsageRestrictedUntil: null,
      aiUsageRestrictionReason: null,
      aiUsageRestrictedById: null,
      aiUsageRestrictedByEmail: null,
    },
  });
  if (claimed.count !== 1) return "deletion_in_progress";
  return "restored";
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
