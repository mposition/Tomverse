import { createHash, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { reconcileExpiredChatCreditReservations } from "@/lib/chatSecurity";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";

const isAuthorized = (request: Request) => {
  const configured = process.env.MAINTENANCE_SECRET;
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!configured || configured.length < 32 || !provided) return false;
  const expectedDigest = createHash("sha256").update(configured).digest();
  const providedDigest = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
};

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }
  try {
    const result = await reconcileExpiredChatCreditReservations(
      new Date(),
      1_000
    );
    return Response.json(
      { success: true, result },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    after(() =>
      reportOperationalIncident({
        code: "CREDIT_RESERVATION_RECONCILIATION_FAILED",
        title: "Credit reservation reconciliation failed",
        error,
        severity: "fatal",
        cooldownMs: 15 * 60 * 1_000,
        context: {
          component: "maintenance-credit-reservations",
          route: "/api/internal/maintenance/credit-reservations",
        },
      })
    );
    return Response.json(
      { error: "Credit reservation reconciliation failed." },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
