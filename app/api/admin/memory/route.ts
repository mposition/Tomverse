export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { getMemoryReport } from "@/lib/memoryMetrics";

/**
 * Content-free monitoring for account memory (policy §22 B).
 *
 * Everything in the report is a count, a rate or a closed enum label.
 * Statements, evidence, conversation titles and ids are excluded at the query
 * layer (lib/memoryMetrics.ts), not merely omitted from the response shape.
 *
 * The report also names the §22 metrics it cannot supply yet, with the reason
 * for each: a zero for a metric nothing measures is indistinguishable from a
 * feature nobody uses, and that is the mistake this list exists to prevent.
 */
export async function GET(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id || !isAdminSession(session)) {
            return NextResponse.json({ error: "Not found." }, { status: 404 });
        }
        await consumeApiRateLimit(req, session.user.id, "admin-memory", {
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

        return NextResponse.json(await getMemoryReport({ windowDays }));
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("Admin memory report failed:", error);
        return NextResponse.json(
            { error: "Failed to load the memory report." },
            { status: 500 }
        );
    }
}
