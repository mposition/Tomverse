export const dynamic = "force-dynamic";

import { toAnthropicModelList } from "@/lib/anthropicMessagesProtocol";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import { externalApiProtocolModels } from "@/lib/externalApiCatalog";
import { authenticateNative, nativeRefusal } from "@/lib/externalApiNative";
import { anthropicMessagesSpec } from "@/lib/externalApiNativeSpecs";
import { NO_STORE_HEADERS } from "@/lib/externalApiRoutes";

// Claude Code's model discovery: the models this key can run natively, in
// Anthropic's list shape. Same registry, plan and credential filter as /api/v1/models.
export async function GET(request: Request) {
    try {
        const key = await authenticateNative(request, anthropicMessagesSpec, "external-api-reads");
        const plan = await getUserBillingPlan(key.userId);
        const models = await externalApiProtocolModels(plan.tier, "anthropic_messages");
        return Response.json(toAnthropicModelList(models), { headers: NO_STORE_HEADERS });
    } catch (error) {
        const refusal = nativeRefusal(error, anthropicMessagesSpec.render);
        if (refusal) return refusal;
        console.error(JSON.stringify({ event: "external_api_route_failed", message: String(error) }));
        return anthropicMessagesSpec.render(500, "The request could not be processed.", "internal_error");
    }
}
