export const dynamic = "force-dynamic";

import { getUserBillingPlan } from "@/lib/billingEntitlements";
import { externalApiOfferedModels } from "@/lib/externalApiCatalog";
import { externalApiChannelFor, toOpenAiModelEntry } from "@/lib/externalApiCatalogCore";
import { NO_STORE_HEADERS, withBearerKey } from "@/lib/externalApiRoutes";

// The models this key's account can run now: the runtime registry, the
// operator's verified list and the account's plan, read on every call.
export async function GET(request: Request) {
    return withBearerKey(request, async (key) => {
        const plan = await getUserBillingPlan(key.userId);
        const models = await externalApiOfferedModels(plan.tier, {
            channel: externalApiChannelFor(request.headers.get("user-agent")),
        });
        return Response.json(
            { object: "list", data: models.map(toOpenAiModelEntry) },
            { headers: NO_STORE_HEADERS }
        );
    });
}
