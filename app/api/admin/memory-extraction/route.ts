export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { getMemoryExtractionReport } from "@/lib/memoryExtractionMetrics";

/**
 * Content-free monitoring for memory extraction runs (policy §22, the B list).
 *
 * It exists because extraction became a background worker that spends credits:
 * the two §11.1 drivers execute runs with no request watching them, so without
 * this an operator cannot tell whether the dispatcher is keeping up, whether
 * one approved pair is failing where the others are not, or what chunks are
 * failing *of* -- a provider outage and a deleted source look identical in a
 * success rate and need different responses.
 *
 * Everything here is a count, a rate or a version label. Statements, titles,
 * conversation ids and digests are excluded at the query layer
 * (lib/memoryExtractionMetrics.ts), not merely omitted from the response.
 */
export async function GET(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id || !isAdminSession(session)) {
            return NextResponse.json({ error: "Not found." }, { status: 404 });
        }
        await consumeApiRateLimit(req, session.user.id, "admin-memory-extraction", {
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

        return NextResponse.json(await getMemoryExtractionReport({ windowDays }));
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("Admin memory extraction report failed:", error);
        return NextResponse.json(
            { error: "Failed to load the memory extraction report." },
            { status: 500 }
        );
    }
}
