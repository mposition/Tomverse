import "server-only";
import { toAnthropicModelList } from "@/lib/anthropicMessagesProtocol";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import { externalApiOfferedModels, externalApiProtocolModels, type ExternalApiSurface } from "@/lib/externalApiCatalog";
import { toOpenAiModelEntry } from "@/lib/externalApiCatalogCore";
import { authenticateNative, nativeRefusal } from "@/lib/externalApiNative";
import { anthropicMessagesSpec } from "@/lib/externalApiNativeSpecs";
import { NO_STORE_HEADERS, withBearerKey } from "@/lib/externalApiRoutes";

/**
 * The model lists of both external APIs, one handler each, told which API the
 * route serves: the general API lists the chat registry, the coding API the
 * coding catalogue while it is switched on (lib/externalApiCatalog.ts).
 * Bearer-only, like the generation routes.
 */

/** `GET /models`: the models this key's account can run now, Smart Adaptive first. */
export const handleOpenAiModelList = (request: Request, surface: ExternalApiSurface) =>
    withBearerKey(request, async (key) => {
        const plan = await getUserBillingPlan(key.userId);
        const models = await externalApiOfferedModels(plan.tier, { surface });
        return Response.json({ object: "list", data: models.map(toOpenAiModelEntry) }, { headers: NO_STORE_HEADERS });
    });

/** Claude Code's model discovery: the models this key can run natively, in Anthropic's list shape. */
export const handleAnthropicModelList = async (request: Request, surface: ExternalApiSurface) => {
    try {
        const key = await authenticateNative(request, anthropicMessagesSpec, "external-api-reads");
        const plan = await getUserBillingPlan(key.userId);
        const models = await externalApiProtocolModels(plan.tier, "anthropic_messages", { surface });
        return Response.json(toAnthropicModelList(models), { headers: NO_STORE_HEADERS });
    } catch (error) {
        const refusal = nativeRefusal(error, anthropicMessagesSpec.render);
        if (refusal) return refusal;
        console.error(JSON.stringify({ event: "external_api_route_failed", message: String(error) }));
        return anthropicMessagesSpec.render(500, "The request could not be processed.", "internal_error");
    }
};
