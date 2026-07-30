export const dynamic = "force-dynamic";

import { after, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { scheduleTomverseAccountDeletion } from "@/lib/accountDeletion";
import { sendAccountDeletionScheduledEmail } from "@/lib/accountEmails";
import {
  assertRecentAdminAuthentication,
  isAdminReauthenticationError,
} from "@/lib/adminReauthentication";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { logSecurityAuditEvent } from "@/lib/securityAudit";

const deleteAccountSchema = z
  .object({
    confirm: z.literal(true),
    confirmationText: z.literal("DELETE MY ACCOUNT"),
  })
  .strict();

export async function DELETE(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 }
      );
    }

    await consumeApiRateLimit(req, session.user.id, "user-account-delete", {
      minute: 2,
      day: 3,
    });

    await assertRecentAdminAuthentication(session);
    await readLimitedJson(req, 1024, deleteAccountSchema);
    const deletion = await scheduleTomverseAccountDeletion(session.user.id);
    if (!deletion.scheduled) {
      return NextResponse.json({ error: "Account not found." }, { status: 404 });
    }
    logSecurityAuditEvent("account.deletion.schedule", {
      userId: session.user.id,
      request: req,
      outcome: "success",
    });
    after(async () => {
      try {
        await sendAccountDeletionScheduledEmail({
          to: deletion.email,
          scheduledFor: deletion.scheduledFor,
        });
      } catch (error) {
        await reportOperationalIncident({
          code: "ACCOUNT_DELETION_EMAIL_FAILED",
          title: "Account deletion notification failed",
          error,
          severity: "warning",
          context: { component: "account-deletion", route: "/api/user/account" },
        });
      }
    });

    return NextResponse.json({
      success: true,
      scheduledFor: deletion.scheduledFor.toISOString(),
    });
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json(
        {
          error: "Sign in again before permanently deleting your account.",
          code: "ACCOUNT_REAUTHENTICATION_REQUIRED",
        },
        { status: 428 }
      );
    }
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    after(() =>
      reportOperationalIncident({
        code: "ACCOUNT_DELETION_SCHEDULE_FAILED",
        title: "Account deletion scheduling failed",
        error,
        severity: "error",
        context: { component: "account-deletion", route: "/api/user/account" },
      })
    );
    return NextResponse.json(
      { error: "Failed to delete account." },
      { status: 500 }
    );
  }
}
