import { resolveChatRouteSession } from "@/lib/chatRouteSession";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { TEMPORARY_CHAT_TTL_MS } from "@/lib/temporaryChatAccess";
import { isTemporaryChatEnabled } from "@/lib/temporaryChatSettings";

/**
 * Whether this signed-in account may start a temporary Chat now
 * (lib/temporaryChatAccess.ts). The composer offers the toggle only on
 * `available: true`; the create endpoint checks the same switch again.
 */
export async function GET(req: Request) {
    try {
        const routeAuth = await resolveChatRouteSession(req);
        if (routeAuth.response) return routeAuth.response;
        const userId = routeAuth.session?.user?.id;
        if (!userId) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
        await consumeApiRateLimit(req, userId, "temporary-chat-availability", { minute: 60, day: 5_000 });
        return NextResponse.json({
            available: await isTemporaryChatEnabled(),
            ttlHours: TEMPORARY_CHAT_TTL_MS / 3_600_000,
        });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("Failed to read temporary chat availability:", error);
        return NextResponse.json({ error: "Failed to read availability." }, { status: 500 });
    }
}
