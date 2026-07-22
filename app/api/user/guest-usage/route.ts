export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getGuestUsageSnapshot } from "@/lib/chatSecurity";
import { getAnonymousClientKey } from "@/lib/clientIp";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";

export async function GET(req: Request) {
    try {
        const anonymousKey = getAnonymousClientKey(req);
        await consumeApiRateLimit(req, `ip:${anonymousKey}`, "guest-usage-read", {
            minute: 30,
            day: 3_000,
        });

        const snapshot = await getGuestUsageSnapshot(req);
        const response = NextResponse.json({
            used: snapshot.used,
            limit: snapshot.limit,
            remaining: snapshot.remaining,
            resetsAt: snapshot.resetsAt,
        });
        if (snapshot.setCookie) {
            response.headers.append("Set-Cookie", snapshot.setCookie);
        }
        return response;
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("Failed to load guest usage:", error);
        return NextResponse.json({ error: "Failed to load guest usage." }, { status: 500 });
    }
}
