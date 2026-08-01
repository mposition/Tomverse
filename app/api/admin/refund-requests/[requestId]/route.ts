export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import type { Session } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import {
  AdminApprovalRequiredError,
  adminApprovalErrorResponse,
  runWithAdminApproval,
} from "@/lib/adminApproval";
import { refundApprovalThresholdCents } from "@/lib/adminApprovalCore";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";
import {
  NOTIFICATION_KIND,
  deliverNotificationNow,
  enqueueNotificationDelivery,
} from "@/lib/notificationDeliveries";
import {
  REFUND_REQUEST_METADATA_KEY,
  REFUND_STATUS,
  refundIdempotencyKey,
} from "@/lib/refundSagaCore";
import { getStripe, isStripeConfigured } from "@/lib/stripe";

/**
 * The decision a request carries once it has been reviewed, and the
 * notification the customer is owed for it.
 *
 * The decision, its audit entry and its outbox row all commit in one
 * transaction (see the PATCH handler). A send cannot be made atomic with a
 * database write -- but the durable statement that a send *is owed* can be,
 * and that is what makes the retry queue able to finish the job. An earlier
 * version enqueued in a second transaction after the decision had committed:
 * a failure in that window approved a refund, told nobody, and left no row for
 * the retry worker to find.
 */
const REFUND_DECISIONS = {
  approve: {
    status: "approved",
    notificationKind: NOTIFICATION_KIND.refundRequestApproved,
  },
  reject: {
    status: "rejected",
    notificationKind: NOTIFICATION_KIND.refundRequestRejected,
  },
} as const;

/**
 * Raised when the conditional `pending` claim inside the decision transaction
 * matches no row, i.e. another request reviewed this one first. Rolls the
 * whole decision back rather than writing a second one over it.
 */
class RefundDecisionRaceError extends Error {
  constructor() {
    super("Refund request was reviewed concurrently.");
    this.name = "RefundDecisionRaceError";
  }
}

/**
 * The inline first send, after the decision has committed.
 *
 * Deliberately not part of the transaction and deliberately unable to fail the
 * request: the outbox row is committed, so the worst a failure here costs is a
 * few minutes' delay. Failing the route instead would report an error for a
 * decision that actually succeeded, and the retry to "fix" it would be refused
 * as already reviewed.
 */
const deliverRefundDecision = (
  deliveryId: string,
  kind: (typeof REFUND_DECISIONS)[keyof typeof REFUND_DECISIONS]["notificationKind"],
  requestId: string
) =>
  deliverNotificationNow({ deliveryId, kind, referenceId: requestId });

const updateRefundRequestSchema = z
  .object({
    action: z.enum(["approve", "reject"]),
    adminNote: z.string().trim().max(1_000).optional(),
    confirmCreditReview: z.boolean().optional(),
  })
  .strict();

type RouteContext = {
  params: Promise<{ requestId: string }>;
};

async function cancelStripeSubscription(subscriptionId: string | null) {
  if (!subscriptionId || !isStripeConfigured()) return;
  try {
    await getStripe().subscriptions.cancel(subscriptionId);
  } catch (error) {
    console.error("Stripe subscription cancellation failed:", error);
  }
}

async function createStripeRefundForSubscription(
  subscriptionId: string | null,
  approval?: {
    session: Session;
    request: Request;
    requestId: string;
    payload: Record<string, unknown>;
    reason: string;
  }
) {
  if (!subscriptionId || !isStripeConfigured()) {
    return {
      stripeRefundId: null,
      stripeRefundStatus: null,
      stripeChargeId: null,
      refundAmountCents: null,
      refundCurrency: null,
    };
  }

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["latest_invoice.payment_intent"],
  });
  const latestInvoice = subscription.latest_invoice;
  const invoice =
    typeof latestInvoice === "string"
      ? await stripe.invoices.retrieve(latestInvoice, {
          expand: ["payment_intent"],
        })
      : latestInvoice;

  const paymentIntent = (invoice as { payment_intent?: string | { id?: string } } | null)
    ?.payment_intent;
  const paymentIntentId =
    typeof paymentIntent === "string" ? paymentIntent : paymentIntent?.id;
  if (!paymentIntentId) {
    return {
      stripeRefundId: null,
      stripeRefundStatus: "no_payment_intent",
      stripeChargeId: null,
      refundAmountCents: null,
      refundCurrency: null,
    };
  }

  const charges = await stripe.charges.list({
    payment_intent: paymentIntentId,
    limit: 1,
  });
  const charge = charges.data[0];
  if (!charge || charge.amount_refunded >= charge.amount) {
    return {
      stripeRefundId: null,
      stripeRefundStatus: charge ? "already_refunded" : "no_charge",
      stripeChargeId: charge?.id || null,
      refundAmountCents: 0,
      refundCurrency: charge?.currency?.toUpperCase() || null,
    };
  }

  const amount = charge.amount - charge.amount_refunded;
  const createRefund = async () => {
    if (approval) {
      await writeAdminAuditLog({
        session: approval.session,
        request: approval.request,
        action: "refund.execution_started",
        targetType: "RefundRequest",
        targetId: approval.requestId,
        summary: `Started Stripe refund for ${approval.requestId}.`,
        metadata: { amount, currency: charge.currency.toUpperCase(), chargeId: charge.id },
      });
    }
    return stripe.refunds.create(
      {
        charge: charge.id,
        amount,
        reason: "requested_by_customer",
        metadata: {
          tomverseRefundRequest: "true",
          // Which request this belongs to. Without it a refund that succeeded
          // while the local write failed could not be matched back to
          // anything, so reconciliation had nothing to look for.
          ...(approval
            ? { [REFUND_REQUEST_METADATA_KEY]: approval.requestId }
            : {}),
          subscriptionId,
        },
      },
      approval
        ? {
            // Scoped to the request, so a retry after a crash is answered from
            // Stripe's record of the first call instead of issuing a second
            // refund.
            idempotencyKey: refundIdempotencyKey(approval.requestId),
          }
        : undefined
    );
  };
  const refund =
    approval &&
    amount >= refundApprovalThresholdCents(process.env.ADMIN_REFUND_APPROVAL_THRESHOLD_CENTS)
      ? await runWithAdminApproval(
          {
            session: approval.session,
            request: approval.request,
            action: "refund.approve",
            targetType: "RefundRequest",
            targetId: approval.requestId,
            payload: {
              ...approval.payload,
              refundAmountCents: amount,
              refundCurrency: charge.currency.toUpperCase(),
              stripeChargeId: charge.id,
            },
            reason: approval.reason,
          },
          createRefund
        )
      : await createRefund();

  return {
    stripeRefundId: refund.id,
    stripeRefundStatus: refund.status || "pending",
    stripeChargeId: charge.id,
    refundAmountCents: amount,
    refundCurrency: charge.currency.toUpperCase(),
  };
}

export async function PATCH(req: Request, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "billing:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-refund-update", {
      minute: 10,
      day: 100,
    });

    const { requestId } = await context.params;
    const body = await readLimitedJson(req, 4 * 1024, updateRefundRequestSchema);
    const refundRequest = await prisma.refundRequest.findUnique({
      where: { id: requestId },
    });

    if (!refundRequest) {
      return NextResponse.json(
        { error: "Refund request not found." },
        { status: 404 }
      );
    }
    const decision = REFUND_DECISIONS[body.action];

    if (refundRequest.status === REFUND_STATUS.processing) {
      // Another attempt is between Stripe and the local commit. Refusing here
      // is the point of the claim: retrying now is what would refund twice.
      // Either it finishes on its own, or reconciliation resolves it.
      return NextResponse.json(
        {
          error:
            "This refund is being processed. It will finish or be reconciled automatically; try again shortly.",
        },
        { status: 409 }
      );
    }

    if (refundRequest.status !== REFUND_STATUS.pending) {
      // A different decision is a real conflict and stays refused.
      if (refundRequest.status !== decision.status) {
        return NextResponse.json(
          { error: "Refund request has already been reviewed." },
          { status: 409 }
        );
      }
      // The same decision, replayed -- a lost response, or a retry of an
      // earlier attempt. Answering 409 here is what made the notification gap
      // unrecoverable: the operator could see the decision had landed but had
      // no way to re-drive the mail it owed. So this is idempotent, and it
      // reconciles the outbox row, which also heals rows decided before the
      // enqueue joined the decision transaction.
      const replayed = await prisma.refundRequest.findUniqueOrThrow({
        where: { id: refundRequest.id },
        include: { timelineEvents: { orderBy: { createdAt: "asc" } } },
      });
      const delivery = await prisma.$transaction((tx) =>
        enqueueNotificationDelivery(tx, {
          kind: decision.notificationKind,
          referenceId: refundRequest.id,
        })
      );
      await deliverRefundDecision(
        delivery.id,
        decision.notificationKind,
        refundRequest.id
      );
      return NextResponse.json({
        success: true,
        refundRequest: replayed,
        replayed: true,
      });
    }

    // The recipient's language is no longer looked up here: the notification
    // queue re-renders the decision email from the stored request at send
    // time, and reads the language from the same place a retry would.
    const creditReview = refundRequest.userId
      ? await prisma.user.findUnique({
          where: { id: refundRequest.userId },
          select: {
            creditDebtCredits: true,
            creditDebtCostMicroUsd: true,
            billingRiskStatus: true,
            _count: { select: { creditPurchases: true } },
          },
        })
      : null;

    if (body.action === "approve") {
      if (
        (creditReview?._count.creditPurchases || 0) > 0 ||
        (creditReview?.creditDebtCredits || 0) > 0
      ) {
        if (!body.confirmCreditReview) {
          return NextResponse.json(
            {
              error:
                "Review the purchased credit balance and consumed AI cost before approving this refund.",
            },
            { status: 400 }
          );
        }
      }
      // Claim the request BEFORE any money moves.
      //
      // Stripe cannot join the local transaction, so the only way to make the
      // gap between them survivable is to record that the attempt started.
      // Claiming here does two things at once: it stops a second administrator
      // reaching Stripe at all, and it means a crash after `refunds.create`
      // leaves the row in `processing` -- where reconciliation will find it --
      // rather than in `pending`, where the next attempt would refund again.
      const processingClaim = await prisma.refundRequest.updateMany({
        where: { id: refundRequest.id, status: REFUND_STATUS.pending },
        data: {
          status: REFUND_STATUS.processing,
          processingStartedAt: new Date(),
        },
      });
      if (processingClaim.count !== 1) throw new RefundDecisionRaceError();

      let stripeRefund;
      try {
        stripeRefund = await createStripeRefundForSubscription(
          refundRequest.stripeSubscriptionId,
          {
            session,
            request: req,
            requestId: refundRequest.id,
            payload: body,
            reason:
              body.adminNote ||
              `Approve refund request ${refundRequest.id}.`,
          }
        );
      } catch (error) {
        // The refund did not happen, so the claim has to come back off. An
        // approval waiting on two-person sign-off is not a failure: leaving it
        // `processing` would strand it, so it is released the same way.
        await prisma.refundRequest.updateMany({
          where: { id: refundRequest.id, status: REFUND_STATUS.processing },
          data: {
            status: REFUND_STATUS.pending,
            processingStartedAt: null,
          },
        });
        if (error instanceof AdminApprovalRequiredError) throw error;
        console.error("Stripe refund creation failed:", error);
        await writeAdminAuditLog({
          session,
          request: req,
          action: "refund.approve_failed",
          targetType: "RefundRequest",
          targetId: refundRequest.id,
          summary: `Stripe refund failed for ${refundRequest.email || "unknown customer"}.`,
          metadata: {
            plan: refundRequest.plan,
            stripeCustomerId: refundRequest.stripeCustomerId,
            stripeSubscriptionId: refundRequest.stripeSubscriptionId,
            releasedToPending: true,
          },
        });
        return NextResponse.json(
          { error: "Stripe refund failed. The request was not approved." },
          { status: 502 }
        );
      }

      await cancelStripeSubscription(refundRequest.stripeSubscriptionId);
      const decided = await prisma.$transaction(async (tx) => {
        // Conditional on the claim this request made, so a reconciliation pass
        // that resolved the row in the meantime is not overwritten.
        const claimed = await tx.refundRequest.updateMany({
          where: { id: refundRequest.id, status: REFUND_STATUS.processing },
          data: {
            status: "approved",
            processingStartedAt: null,
            adminNote: body.adminNote || null,
            reviewedByUserId: session.user.id,
            reviewedAt: new Date(),
            stripeRefundId: stripeRefund.stripeRefundId,
            stripeRefundStatus: stripeRefund.stripeRefundStatus,
            stripeChargeId: stripeRefund.stripeChargeId,
            refundAmountCents: stripeRefund.refundAmountCents,
            refundCurrency: stripeRefund.refundCurrency,
          },
        });
        if (claimed.count !== 1) throw new RefundDecisionRaceError();
        const request = await tx.refundRequest.findUniqueOrThrow({
          where: { id: refundRequest.id },
          include: {
            timelineEvents: {
              orderBy: { createdAt: "asc" },
            },
          },
        });
        if (stripeRefund.stripeRefundId && refundRequest.stripeSubscriptionId) {
          await tx.billingTransaction.updateMany({
            where: {
              stripeSubscriptionId: refundRequest.stripeSubscriptionId,
            },
            data: { status: "refunded" },
          });
        }

        const event = await tx.refundRequestTimelineEvent.create({
          data: {
            refundRequestId: refundRequest.id,
            actorUserId: session.user.id,
            actorEmail: session.user.email || null,
            eventType: "approved",
            message: "Refund request approved. User membership was reset to Free.",
            metadata: {
              stripeRefundId: stripeRefund.stripeRefundId,
              stripeRefundStatus: stripeRefund.stripeRefundStatus,
              refundAmountCents: stripeRefund.refundAmountCents,
              creditReviewConfirmed: Boolean(body.confirmCreditReview),
              creditPurchaseCount: creditReview?._count.creditPurchases || 0,
              creditDebtCredits: creditReview?.creditDebtCredits || 0,
              creditDebtCostMicroUsd: Number(
                creditReview?.creditDebtCostMicroUsd || BigInt(0)
              ),
              billingRiskStatus: creditReview?.billingRiskStatus || "normal",
            },
          },
        });

        if (refundRequest.userId) {
          await tx.user.update({
            where: { id: refundRequest.userId },
            data: {
              plan: "Free",
              stripeCustomerId: null,
              stripeSubscriptionId: null,
              stripePriceId: null,
              subscriptionStatus: "cancelled_by_admin",
              subscriptionCurrentPeriodEnd: null,
              subscriptionBillingInterval: null,
            },
          });
        }

        await writeAdminAuditLog({
          session,
          request: req,
          action: "refund.approved",
          targetType: "RefundRequest",
          targetId: request.id,
          summary: `Approved refund request for ${request.email || "unknown customer"}.`,
          metadata: {
            plan: request.plan,
            stripeCustomerId: request.stripeCustomerId,
            stripeSubscriptionId: request.stripeSubscriptionId,
            stripeRefundId: request.stripeRefundId,
            refundAmountCents: request.refundAmountCents,
            creditReviewConfirmed: Boolean(body.confirmCreditReview),
            creditPurchaseCount: creditReview?._count.creditPurchases || 0,
            creditDebtCredits: creditReview?.creditDebtCredits || 0,
            creditDebtCostMicroUsd: Number(
              creditReview?.creditDebtCostMicroUsd || BigInt(0)
            ),
          },
          tx,
        });

        const delivery = await enqueueNotificationDelivery(tx, {
          kind: decision.notificationKind,
          referenceId: refundRequest.id,
        });

        return {
          refundRequest: {
            ...request,
            timelineEvents: [...request.timelineEvents, event],
          },
          deliveryId: delivery.id,
        };
      });

      await deliverRefundDecision(
        decided.deliveryId,
        decision.notificationKind,
        refundRequest.id
      );

      return NextResponse.json({
        success: true,
        refundRequest: decided.refundRequest,
      });
    }

    const decided = await prisma.$transaction(async (tx) => {
      const claimed = await tx.refundRequest.updateMany({
        where: { id: refundRequest.id, status: "pending" },
        data: {
          status: "rejected",
          adminNote: body.adminNote || null,
          reviewedByUserId: session.user.id,
          reviewedAt: new Date(),
        },
      });
      if (claimed.count !== 1) throw new RefundDecisionRaceError();
      const request = await tx.refundRequest.findUniqueOrThrow({
        where: { id: refundRequest.id },
        include: {
          timelineEvents: {
            orderBy: { createdAt: "asc" },
          },
        },
      });
      const event = await tx.refundRequestTimelineEvent.create({
        data: {
          refundRequestId: refundRequest.id,
          actorUserId: session.user.id,
          actorEmail: session.user.email || null,
          eventType: "rejected",
          message: "Refund request rejected.",
          metadata: {
            adminNote: body.adminNote || null,
          },
        },
      });
      await writeAdminAuditLog({
        session,
        request: req,
        action: "refund.rejected",
        targetType: "RefundRequest",
        targetId: request.id,
        summary: `Rejected refund request for ${request.email || "unknown customer"}.`,
        metadata: {
          plan: request.plan,
          stripeCustomerId: request.stripeCustomerId,
          stripeSubscriptionId: request.stripeSubscriptionId,
        },
        tx,
      });

      const delivery = await enqueueNotificationDelivery(tx, {
        kind: decision.notificationKind,
        referenceId: refundRequest.id,
      });

      return {
        refundRequest: {
          ...request,
          timelineEvents: [...request.timelineEvents, event],
        },
        deliveryId: delivery.id,
      };
    });

    await deliverRefundDecision(
      decided.deliveryId,
      decision.notificationKind,
      refundRequest.id
    );

    return NextResponse.json({
      success: true,
      refundRequest: decided.refundRequest,
    });
  } catch (error) {
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    if (error instanceof RefundDecisionRaceError) {
      return NextResponse.json(
        { error: "Refund request has already been reviewed." },
        { status: 409 }
      );
    }
    console.error("Refund request update failed:", error);
    return NextResponse.json(
      { error: "Failed to update refund request." },
      { status: 500 }
    );
  }
}
