export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { marketingReachReport } from "@/lib/marketingReach";

/**
 * How many people a marketing campaign could reach today, and how many of
 * those we could prove said yes.
 *
 * Contract: docs/policy/email-notifications.md §5.1 C1, §5.6 C8, §11.2.
 * Decision this feeds: docs/ops/q2-marketing-reach-decision.md.
 *
 * ## Why an endpoint and not only a script
 *
 * `npm run report:marketing-reach` needs a shell on a host that can reach the
 * production database. That is a real barrier at the moment the number is
 * wanted -- and the number is wanted repeatedly, not once: Q2 is one caller,
 * but warm-up sizing, the consent-reconfirm batch and the double opt-in
 * rollout all ask the same question. A browser and an administrator session
 * are enough here.
 *
 * Both callers go through `marketingReachReport()`. A second copy of the three
 * queries is how the console and the CLI start disagreeing about what
 * "reachable" means.
 *
 * ## What it returns
 *
 * Counts. No query behind this selects an address, a user id or a name, so the
 * response is safe to paste into a decision record -- a property of the
 * queries rather than of a filter applied to their output.
 */
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-marketing-reach", {
      minute: 10,
      day: 200,
    });

    return NextResponse.json(await marketingReachReport());
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin marketing reach report failed:", error);
    return NextResponse.json(
      { error: "Failed to load the marketing reach report." },
      { status: 500 }
    );
  }
}
