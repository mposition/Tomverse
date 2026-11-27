import { resolveChatRouteSession } from "@/lib/chatRouteSession";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { TEMPORARY_CHAT_TTL_MS } from "@/lib/temporaryChatAccess";
import { isTemporaryChatEnabled } from "@/lib/temporaryChatSettings";

/**
 * Whether this signed-in account may start a temporary Chat now
 * (lib/temporaryChatAccess.ts). The composer offers the toggle only on
 * `available: true`; the create endpoint checks the same switch again.
 */
export async function GET(req: Request) {
    const routeAuth = await resolveChatRouteSession(req);
    if (routeAuth.response) return routeAuth.response;
    if (!routeAuth.session?.user?.id) {
        return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    return NextResponse.json({
        available: await isTemporaryChatEnabled(),
        ttlHours: TEMPORARY_CHAT_TTL_MS / 3_600_000,
    });
}
