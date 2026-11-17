export const dynamic = "force-dynamic";

import { externalApiKeyUsage, listExternalApiKeys } from "@/lib/externalApiKeys";
import { NO_STORE_HEADERS, withBearerKey } from "@/lib/externalApiRoutes";

// Tomverse-specific (not an OpenAI endpoint): this key's own cap, committed
// credits and recent request receipts. Never another key's, never the account.
export async function GET(request: Request) {
    return withBearerKey(request, async (key) => {
        // An integer 1..100; anything else (1.5, "abc", -3) is the default.
        const requested = Number(new URL(request.url).searchParams.get("limit") ?? 50);
        const limit = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 100) : 50;
        const summary = (await listExternalApiKeys(key.userId)).find((entry) => entry.id === key.keyId);
        const requests = await externalApiKeyUsage(key.keyId, limit);
        return Response.json(
            {
                object: "tomverse.usage",
                key: summary
                    ? {
                          prefix: summary.keyPrefix,
                          name: summary.name,
                          credit_cap: summary.creditCap,
                          committed_credits: summary.committedCredits,
                          held_credits: summary.heldCredits,
                          remaining_cap_credits:
                              summary.creditCap === null ? null : Math.max(0, summary.creditCap - summary.committedCredits),
                          expires_at: summary.expiresAt,
                      }
                    : null,
                requests,
            },
            { headers: NO_STORE_HEADERS }
        );
    });
}
