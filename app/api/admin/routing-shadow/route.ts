export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { getRoutingShadowReport } from "@/lib/routingShadowMetrics";

/**
 * Shadow routing, for the Admin Console (routing policy §5, delivery plan §6).
 *
 * Read-only, and content-free by construction: every figure is a version, a
 * label, a count or a duration. The underlying table stores no message text,
 * no memory content and no message id, and the query names its columns rather
 * than selecting the row.
 *
 * The response deliberately carries the same caveat the command-line report
 * prints. Agreement with the user's own model choice is not a quality score --
 * ROUTE-01 grades the Router on a win-rate against the fixed-model baseline --
 * and a number this easy to misread should not travel without it.
 */
export async function GET(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id || !isAdminSession(session)) {
            return NextResponse.json({ error: "Not found." }, { status: 404 });
        }
        await consumeApiRateLimit(req, session.user.id, "admin-routing-shadow", {
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

        return NextResponse.json(await getRoutingShadowReport({ windowDays }));
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("admin routing shadow report failed", error);
        return NextResponse.json({ error: "Server error." }, { status: 500 });
    }
}
