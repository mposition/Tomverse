export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getGuestUsageSnapshot } from "@/lib/chatSecurity";
import { getGuestComparisonReviewRemaining } from "@/lib/comparisonReviewQuota";
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
        // The AI Review trial is a separate, feature-scoped monthly bucket, and
        // the rail needs its state before the review dialog is ever opened --
        // otherwise the button could offer a run the server would refuse.
        const aiReviewTrial = await getGuestComparisonReviewRemaining(
            snapshot.subjectKey
        );
        const response = NextResponse.json({
            used: snapshot.used,
            limit: snapshot.limit,
            remaining: snapshot.remaining,
            // Server-authoritative spendable balance for the guest comparison
            // actions, read from the same buckets acquireChatAccess enforces.
            // The client never computes this and never sends it back.
            creditsAvailable: snapshot.creditsAvailable,
            aiReviewTrial: {
                limit: aiReviewTrial.limit,
                used: aiReviewTrial.used,
                remaining: aiReviewTrial.remaining,
            },
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
