export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { getProviderHealthDashboard } from "@/lib/providerMonitoring";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
} from "@/lib/apiSecurity";

export async function GET(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id) {
            return NextResponse.json(
                { error: "Authentication required." },
                { status: 401 }
            );
        }
        if (!isAdminSession(session)) {
            return NextResponse.json({ error: "Forbidden." }, { status: 403 });
        }

        await consumeApiRateLimit(req, session.user.id, "admin-provider-health", {
            minute: 30,
            day: 1_000,
        });

        const dashboard = await getProviderHealthDashboard();
        return NextResponse.json(dashboard, {
            headers: {
                "Cache-Control": "no-store",
            },
        });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("Failed to load provider health dashboard:", error);
        return NextResponse.json(
            { error: "Failed to load provider health dashboard." },
            { status: 500 }
        );
    }
}
