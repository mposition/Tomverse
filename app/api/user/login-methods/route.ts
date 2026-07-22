export const dynamic = "force-dynamic";

import { after, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import {
  assertRecentAdminAuthentication,
  isAdminReauthenticationError,
} from "@/lib/adminReauthentication";
import { revokeAllUserSessions } from "@/lib/sessionSecurity";
import { logSecurityAuditEvent } from "@/lib/securityAudit";
import { sendLoginMethodChangedEmail } from "@/lib/emailLoginEmails";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";

type LoginMethodProvider = "google" | "azure-ad" | "email";

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    await consumeApiRateLimit(req, session.user.id, "user-login-methods-list", {
      minute: 20,
      day: 200,
    });

    const [accounts, user] = await Promise.all([
      prisma.account.findMany({
        where: { userId: session.user.id },
        select: { provider: true },
      }),
      prisma.user.findUnique({
        where: { id: session.user.id },
        select: { emailLoginEnabled: true, email: true },
      }),
    ]);

    const linkedProviders = new Set(accounts.map((account) => account.provider));
    const methods = [
      ...(["google", "azure-ad"] as const).map((provider) => ({
        type: "oauth" as const,
        provider,
        linked: linkedProviders.has(provider),
      })),
      ...(user?.email
        ? [{ type: "email" as const, address: user.email, enabled: Boolean(user.emailLoginEnabled) }]
        : []),
    ];
    const enabledCount =
      linkedProviders.size + (user?.emailLoginEnabled && user.email ? 1 : 0);

    return NextResponse.json({ methods, canRemove: enabledCount > 1 });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to list login methods:", error);
    return NextResponse.json({ error: "Failed to load login methods." }, { status: 500 });
  }
}

const removeSchema = z
  .object({
    method: z.enum(["google", "azure-ad", "email"]),
  })
  .strict();

export async function DELETE(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    await consumeApiRateLimit(req, session.user.id, "user-login-method-remove", {
      minute: 3,
      day: 10,
    });
    await assertRecentAdminAuthentication(session);
    const body = await readLimitedJson(req, 1_024, removeSchema);

    const [accounts, user] = await Promise.all([
      prisma.account.findMany({
        where: { userId: session.user.id },
        select: { provider: true },
      }),
      prisma.user.findUnique({
        where: { id: session.user.id },
        select: { emailLoginEnabled: true, email: true },
      }),
    ]);
    const linkedProviders = new Set(accounts.map((account) => account.provider));
    const enabledCount = linkedProviders.size + (user?.emailLoginEnabled && user.email ? 1 : 0);
    const removingEnabledMethod =
      body.method === "email" ? Boolean(user?.emailLoginEnabled) : linkedProviders.has(body.method);
    if (removingEnabledMethod && enabledCount <= 1) {
      return NextResponse.json(
        { error: "At least one login method is required." },
        { status: 409 }
      );
    }

    if (body.method === "email") {
      await prisma.user.update({
        where: { id: session.user.id },
        data: { emailLoginEnabled: false },
      });
    } else {
      await prisma.account.deleteMany({
        where: { userId: session.user.id, provider: body.method },
      });
    }
    await revokeAllUserSessions(session.user.id);

    logSecurityAuditEvent("auth.login_method.remove", {
      userId: session.user.id,
      provider: body.method,
      outcome: "success",
    });

    after(async () => {
      try {
        await sendLoginMethodChangedEmail({
          to: session.user.email,
          action: "unlinked",
          method: body.method as LoginMethodProvider,
        });
      } catch (error) {
        await reportOperationalIncident({
          code: "LOGIN_METHOD_NOTIFICATION_FAILED",
          title: "Login-method-removed notification failed",
          error,
          severity: "warning",
          context: { component: "login-methods" },
        });
      }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json(
        { error: "Sign in again before removing a login method.", code: "ACCOUNT_REAUTHENTICATION_REQUIRED" },
        { status: 428 }
      );
    }
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to remove login method:", error);
    return NextResponse.json({ error: "Failed to remove login method." }, { status: 500 });
  }
}
