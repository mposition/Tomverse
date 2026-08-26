export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import {
  diagnoseAdminAuditEntry,
  storedAdminAuditHashInput,
} from "@/lib/adminAuditEntryDiagnosis";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";

/**
 * Why this is an endpoint and not only a script.
 *
 * The diagnosis needs two things an operator's laptop should not have: the
 * database and the signing keys. Telling them to clone the repository and run
 * `railway run` moves the work rather than doing it — and puts production
 * secrets somewhere new on the way. The application already holds both, and
 * the administrator is already authenticated in front of it, so the answer
 * belongs one click from the failure that raised the question.
 *
 * Read-only, like every path this touches: re-hashing a broken row under the
 * current key would make the checker pass by editing what it checks.
 */

type RouteContext = { params: Promise<{ auditId: string }> };

export async function GET(req: Request, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    // Each call is a few hundred HMACs over one row. Cheap, but it is a
    // diagnosis rather than a page load, and nothing should be calling it in
    // a loop.
    await consumeApiRateLimit(req, session.user.id, "admin-audit-diagnose", {
      minute: 10,
      day: 200,
    });

    const { auditId } = await context.params;
    const audit = await prisma.adminAuditLog.findUnique({ where: { id: auditId } });
    if (!audit) {
      return NextResponse.json({ error: "Audit event not found." }, { status: 404 });
    }
    if (!audit.entryHash) {
      return NextResponse.json(
        { error: "This entry predates the hash chain, so there is nothing to reproduce." },
        { status: 409 }
      );
    }

    const keys = adminAuditIntegrityKeys(process.env);
    if (keys.length === 0) {
      return NextResponse.json(
        { error: "ADMIN_AUDIT_INTEGRITY_KEY or NEXTAUTH_SECRET is not configured." },
        { status: 409 }
      );
    }

    return NextResponse.json({
      diagnosis: diagnoseAdminAuditEntry(
        storedAdminAuditHashInput(audit),
        audit.entryHash,
        keys
      ),
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to diagnose audit entry:", error);
    return NextResponse.json({ error: "Failed to diagnose audit entry." }, { status: 500 });
  }
}
