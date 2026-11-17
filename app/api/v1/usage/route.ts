export const dynamic = "force-dynamic";

import { externalApiKeyUsage, listExternalApiKeys } from "@/lib/externalApiKeys";
import { NO_STORE_HEADERS, withBearerKey } from "@/lib/externalApiRoutes";

// Tomverse-specific (not an OpenAI endpoint): this key's own cap, committed
// credits and recent request receipts. Never another key's, never the account.
export async function GET(request: Request) {
    return withBearerKey(request, async (key) => {
        const limit = Number(new URL(request.url).searchParams.get("limit") ?? 50);
        const summary = (await listExternalApiKeys(key.userId)).find((entry) => entry.id === key.keyId);
        const requests = await externalApiKeyUsage(key.keyId, Number.isFinite(limit) ? limit : 50);
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
