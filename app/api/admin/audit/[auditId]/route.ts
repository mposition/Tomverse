export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";

type RouteContext = {
  params: Promise<{ auditId: string }>;
};

export async function GET(req: Request, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-audit-detail", {
      minute: 40,
      day: 800,
    });

    const { auditId } = await context.params;
    const audit = await prisma.adminAuditLog.findUnique({
      where: { id: auditId },
    });
    if (!audit) {
      return NextResponse.json({ error: "Audit event not found." }, { status: 404 });
    }

    return NextResponse.json({ audit });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load audit detail:", error);
    return NextResponse.json(
      { error: "Failed to load audit detail." },
      { status: 500 }
    );
  }
}
