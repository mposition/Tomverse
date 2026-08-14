export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { BILLING_CURRENCIES } from "@/lib/billingMarkets";
import { runPromotionDiagnostics } from "@/lib/promotionDiagnostics";

/**
 * Read-only diagnosis of one promotion against one plan, and optionally one
 * existing account.
 *
 * It exists because the only way to investigate "This promotion is not
 * currently available." used to be to create a throwaway account and press the
 * button -- which burns a redemption on a capped promotion, writes a
 * redemption row, and on the internal-pass path changes somebody's plan. None
 * of that is an acceptable price for a support question, and none of it is
 * repeatable.
 *
 * What this route may do is bounded deliberately. It reads the promotion row,
 * the plan catalogue, the selected account, and Stripe. It never provisions,
 * never reserves a checkout lease, never creates a Session or a Customer, and
 * never touches the row's Stripe linkage. The single side effect is the audit
 * entry below, which records that an operator looked.
 *
 * The request body cannot name a Stripe object or a Stripe customer. An
 * operator supplies a promotion, a plan, an interval and at most an internal
 * user id; every Stripe identifier is resolved server-side from the row. A body
 * that could carry `cus_...` or `promo_...` would turn an authenticated console
 * into a general-purpose Stripe reader pointed at any object in the account.
 */

const inputSchema = z
  .object({
    promotionId: z.string().trim().min(1).max(120).optional(),
    code: z.string().trim().toUpperCase().min(2).max(32).optional(),
    planId: z.enum(["pro", "max"]),
    billingInterval: z.enum(["monthly", "annual"]),
    currency: z.enum(BILLING_CURRENCIES).optional(),
    userId: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .strict()
  .refine((input) => Boolean(input.promotionId || input.code), {
    message: "Provide promotionId or code.",
  });

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    // 404 rather than 401/403 for a non-admin: the console's convention, so an
    // unauthorised caller cannot map which admin routes exist.
    if (!session?.user?.id || !isAdminSession(session)) {
      return json({ error: "Not found." }, 404);
    }
    // Promotions live under Billing, and so does the permission. `readonly`,
    // `support` and `ops` are refused: the diagnosis exposes Stripe object ids
    // and the promotion's internal reason slugs.
    if (!hasAdminPermission(session, "billing:write")) {
      return json({ error: "Forbidden." }, 403);
    }

    await consumeApiRateLimit(
      req,
      session.user.id,
      "admin-promotion-diagnostics",
      { minute: 10, day: 200 }
    );

    const input = await readLimitedJson(req, 2 * 1024, inputSchema);
    const outcome = await runPromotionDiagnostics({
      promotionId: input.promotionId,
      code: input.code,
      planId: input.planId,
      billingInterval: input.billingInterval,
      currency: input.currency,
      userId: input.userId || null,
    });

    if (!outcome.ok) {
      return json({ code: outcome.code, error: "Promotion not found." }, 404);
    }

    // Recorded per run, and deliberately thin: who, which promotion, which
    // plan, whether an account was named, the verdict, and the reason slugs.
    // No Stripe object id, no Checkout URL, no email, no raw IP, no payment
    // fingerprint, no provider error text, and not the whole payload -- an
    // audit log that mirrors its subject stops being an index and becomes a
    // second copy of the data it was meant to describe.
    await writeAdminAuditLog({
      session,
      request: req,
      action: "promotion.diagnostics.executed",
      targetType: "billing_promotion",
      targetId: outcome.promotion.id,
      summary: `Ran promotion diagnostics for ${outcome.promotion.code} on ${input.planId} ${input.billingInterval}: ${outcome.report.status}.`,
      metadata: {
        promotionId: outcome.promotion.id,
        planId: input.planId,
        billingInterval: input.billingInterval,
        mode: outcome.accountSelected ? "account_specific" : "configuration_only",
        targetUserId: input.userId || null,
        status: outcome.report.status,
        reasonSlugs: outcome.report.reasonSlugs,
      },
    });

    return json(outcome);
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    // The Stripe reads above can fail, and their messages can quote request
    // parameters. Only the error's name leaves this handler.
    console.error("Promotion diagnostics failed.", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return json(
      {
        code: "PROMOTION_DIAGNOSTICS_FAILED",
        error: "Promotion diagnostics could not be completed.",
      },
      500
    );
  }
}
