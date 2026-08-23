export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { probeOperationalAlertEmail } from "@/lib/operationalMonitoring";
import { probeProviderAlertEmail } from "@/lib/providerMonitoring";
import { OPERATOR_ALERT_PATHS } from "@/lib/operatorAlertProbeCore";

/**
 * Sends one test message through an operator-alert path.
 *
 * Contract: docs/policy/email-notifications.md §14.1.
 * Background: docs/ops/email-sending-domains.md §1.2, §3.5.2.
 *
 * The two operator-alert paths run only when something is genuinely wrong, so
 * until now the only way to learn that one had broken was for it to fail to
 * report an outage. That is how three of four senders stayed on the old sending
 * domain through a cutover with nobody noticing.
 *
 * Each probe calls the path's **own** send function. It does not rebuild the
 * send here, and it does not go through `reportOperationalIncident` -- a
 * fabricated incident on Sentry, Slack and Discord is a worse cost than the
 * gap it would close, and those channels have their own tests.
 *
 * A real send to a real operator address, so it is rate limited hard and
 * audited like any other administrative act.
 */

const requestSchema = z.object({
  path: z.enum(OPERATOR_ALERT_PATHS),
});

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const body = await readLimitedJson(req, 2 * 1024, requestSchema);
    await consumeApiRateLimit(req, session.user.id, "admin-alert-probe", {
      minute: 3,
      day: 30,
    });

    const result =
      body.path === "operational"
        ? await probeOperationalAlertEmail()
        : await probeProviderAlertEmail();

    await writeAdminAuditLog({
      session,
      request: req,
      action: "email.alert_probe.sent",
      targetType: "OperatorAlertPath",
      targetId: body.path,
      summary: result.delivered
        ? `Tested the ${body.path} alert email path; it sent from ${result.from}.`
        : `Tested the ${body.path} alert email path; it did not send (${result.failure?.code}).`,
      metadata: {
        path: result.path,
        delivered: result.delivered,
        from: result.from,
        recipient: result.recipient,
        providerMessageId: result.providerMessageId,
        failureCode: result.failure?.code ?? null,
      },
    });

    // 200 whether or not it sent. "The probe ran and the path is broken" is a
    // successful probe, and answering 5xx would make a working control look
    // like a broken one.
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    return NextResponse.json(
      { error: "Could not run the alert path test." },
      { status: 500 }
    );
  }
}
