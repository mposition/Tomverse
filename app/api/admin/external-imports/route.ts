export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { getExternalImportReport } from "@/lib/externalImportMetrics";

/**
 * Content-free monitoring for external conversation import (policy §22).
 *
 * Everything in the report is a count, a rate, a bucket or a version label.
 * Titles, filenames, content, external IDs, digests and fingerprints are
 * excluded at the query layer (lib/externalImportMetrics.ts), not merely
 * omitted from the response shape.
 */
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-external-imports", {
      minute: 30,
      day: 1_000,
    });

    const url = new URL(req.url);
    const requested = url.searchParams.get("days");
    const windowDays = requested === null ? undefined : Number(requested);
    if (requested !== null && !Number.isFinite(windowDays)) {
      return NextResponse.json(
        { error: "days must be a number.", code: "INVALID_WINDOW" },
        { status: 400 }
      );
    }

    return NextResponse.json(await getExternalImportReport({ windowDays }));
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin external import report failed:", error);
    return NextResponse.json(
      { error: "Failed to load the external import report." },
      { status: 500 }
    );
  }
}
