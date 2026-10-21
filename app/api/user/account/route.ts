export const dynamic = "force-dynamic";

import { after, NextResponse } from "next/server";
import { z } from "zod";
import { resolveChatRouteSession, resolveAccountRouteSession } from "@/lib/chatRouteSession";
import { scheduleTomverseAccountDeletion } from "@/lib/accountDeletion";
import { ACCOUNT_DELETION_SCHEDULED_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import { enqueueStandardEmail } from "@/lib/standardEmailLane";
import {
  assertRecentAccountAuthentication,
  isAccountReauthenticationError,
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
    const authentication = await resolveAccountRouteSession(req);
    if (authentication.response) return authentication.response;
    const session = authentication.session;
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

    await assertRecentAccountAuthentication(session);
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
        await enqueueStandardEmail({
          templateKey: ACCOUNT_DELETION_SCHEDULED_TEMPLATE,
          emailAddress: deletion.email,
          userId: session.user.id,
          language: deletion.language,
          payload: { scheduledFor: deletion.scheduledFor.toISOString() },
          referenceType: "User",
          referenceId: session.user.id,
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
    if (isAccountReauthenticationError(error)) {
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

export async function GET(req: Request) {
  const authentication = await resolveChatRouteSession(req);
  if (authentication.response) return authentication.response;
  const user = authentication.session?.user;
  if (!user?.id) return NextResponse.json({ code: "AUTHENTICATION_REQUIRED" }, { status: 401 });
  return NextResponse.json({ id: user.id, email: user.email, name: user.name,
    actionsEnabled: !req.headers.has("authorization") || process.env.TOMVERSE_NATIVE_ACCOUNT_ENABLED === "true",
  }, { headers: { "Cache-Control": "private, no-store" } });
}
