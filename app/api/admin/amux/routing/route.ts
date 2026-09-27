export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { isAdminSession } from "@/lib/adminAuth";
import { getAmuxExplainabilityReport } from "@/lib/amux/explainability";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(request, session.user.id, "admin-amux-routing", {
      minute: 30,
      day: 1_000,
    });
    return NextResponse.json(await getAmuxExplainabilityReport(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("admin AMUX routing report failed", error);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
