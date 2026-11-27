import { resolveChatRouteSession } from "@/lib/chatRouteSession";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { readUserPersonalization, saveUserPersonalization } from "@/lib/chatPersonalization";
import { userPersonalizationSchema, PERSONALIZATION_TEXT_MAX_LENGTH } from "@/lib/chatPersonalizationCore";

/**
 * The account owner's personal instructions (lib/chatPersonalizationCore.ts):
 * read and replaced as one object, from the AI personalization settings tab.
 * Signed-in accounts only. What is saved here is added to every Chat and
 * Review turn's context block; it never reaches the external APIs.
 */
export async function GET(req: Request) {
    try {
        const routeAuth = await resolveChatRouteSession(req);
        if (routeAuth.response) return routeAuth.response;
        const userId = routeAuth.session?.user?.id;
        if (!userId) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
        await consumeApiRateLimit(req, userId, "personalization-read", { minute: 60, day: 5_000 });
        return NextResponse.json({
            personalization: await readUserPersonalization(userId),
            maxLength: PERSONALIZATION_TEXT_MAX_LENGTH,
        });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("Failed to read personal instructions:", error);
        return NextResponse.json({ error: "Failed to load personal instructions." }, { status: 500 });
    }
}

export async function PUT(req: Request) {
    try {
        const routeAuth = await resolveChatRouteSession(req);
        if (routeAuth.response) return routeAuth.response;
        const userId = routeAuth.session?.user?.id;
        if (!userId) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
        await consumeApiRateLimit(req, userId, "personalization-save", { minute: 10, day: 200 });
        // Two 1,500-character fields of four-byte characters fit well inside 16 KiB.
        const body = await readLimitedJson(req, 16 * 1024, userPersonalizationSchema);
        return NextResponse.json({ personalization: await saveUserPersonalization(userId, body) });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("Failed to save personal instructions:", error);
        return NextResponse.json({ error: "Failed to save personal instructions." }, { status: 500 });
    }
}
