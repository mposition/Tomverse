import { z } from "zod";

import { ProtocolError, parseChatCompletionRequest, type ChatCompletionRequest } from "@/lib/openAiChatProtocol";
import { SMART_ADAPTIVE_MODEL_ID } from "@/lib/externalApiCatalogCore";
import type { AiProvider } from "@/lib/models";

/**
 * The coding API's route-only choice (`POST /api/code/v1/route`): Smart
 * Adaptive's pick for one request, without running it. Desktop Code in
 * provider-CLI mode asks which provider's model suits the task, then runs it
 * on the person's own CLI when that provider's CLI is connected on the PC, and
 * on the Tomverse API otherwise (owner decision 2026-11-28).
 *
 * Pure: the switch, the request schema and the answer. The server half is
 * lib/externalApiRouteOnly.ts. See docs/policy/external-api.md section 5.3.
 */

/** Exactly "true" turns the route on. Default off; EXTERNAL_API_ENABLED must be on as well. */
export const ROUTE_ONLY_SWITCH_ENV = "EXTERNAL_API_ROUTE_ONLY_ENABLED";

export const routeOnlySwitchOn = (env: Record<string, string | undefined>) => env[ROUTE_ONLY_SWITCH_ENV] === "true";

export const ROUTE_ONLY_PATH = "/api/code/v1/route";

/** What a receipt-less request log and the rate-limit bucket are called. */
export const ROUTE_ONLY_EVENT = "external_api_route_only";
export const ROUTE_ONLY_RATE_SCOPE = "external-api-route-only";

/** A choice reads the task, not a whole session: far below a completion request's body limit. */
export const ROUTE_ONLY_MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * The providers whose command-line tool Desktop can connect and trust on the
 * PC. Z.ai is `zhipu`. A value outside this list is refused, never ignored.
 */
export const ROUTE_ONLY_LOCAL_CLI_PROVIDERS = [
    "openai",
    "anthropic",
    "zhipu",
    "qwen",
    "xai",
    "moonshot",
    "mistral",
    "minimax",
] as const satisfies readonly AiProvider[];

export type RouteOnlyLocalCli = (typeof ROUTE_ONLY_LOCAL_CLI_PROVIDERS)[number];

const envelopeSchema = z
    .object({
        messages: z.array(z.unknown()).min(1),
        localClis: z
            .array(z.enum(ROUTE_ONLY_LOCAL_CLI_PROVIDERS))
            .max(ROUTE_ONLY_LOCAL_CLI_PROVIDERS.length)
            .optional(),
    })
    .strict();

export type RouteOnlyRequest = {
    /** The messages as a Smart Adaptive request, which is what the router reads. */
    request: ChatCompletionRequest;
    localClis: readonly RouteOnlyLocalCli[];
};

/**
 * Parses and validates the body before anything is routed. The messages go
 * through Chat Completions' own parser (its limits, its message shapes), so a
 * request the router could not read as a completion is refused here, at no cost.
 */
export const parseRouteOnlyRequest = (raw: string): RouteOnlyRequest => {
    let body: unknown;
    try {
        body = JSON.parse(raw);
    } catch {
        throw new ProtocolError(400, "invalid_json", "The request body is not valid JSON.");
    }
    const parsed = envelopeSchema.safeParse(body);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        if (issue?.code === "unrecognized_keys") {
            const key = issue.keys[0] ?? "unknown";
            throw new ProtocolError(400, "unsupported_parameter", `The parameter '${key}' is not supported by this route.`, key);
        }
        const param = issue?.path.length ? issue.path.join(".") : null;
        throw new ProtocolError(
            400,
            "invalid_request",
            `Invalid request: ${param ?? "body"}: ${issue?.message ?? "invalid"}.`,
            param
        );
    }
    const localClis = parsed.data.localClis ?? [];
    if (new Set(localClis).size !== localClis.length) {
        throw new ProtocolError(400, "invalid_request", "Invalid request: localClis: each provider may be listed once.", "localClis");
    }
    const request = parseChatCompletionRequest({ model: SMART_ADAPTIVE_MODEL_ID, messages: parsed.data.messages });
    return { request, localClis };
};

/** CLI first: a provider whose CLI is connected on the PC runs there, anything else on the Tomverse API. */
export const routeOnlyExecution = (provider: string, localClis: readonly string[]): "cli" | "api" =>
    localClis.includes(provider) ? "cli" : "api";

export type RouteOnlyAnswer = {
    model: string;
    provider: string;
    providerModel?: string;
    routedBy: "router" | "default" | "continued";
    execution: "cli" | "api";
};

export const routeOnlyAnswer = (
    entry: { model: { id: string; provider: string }; capabilities: { providerModelId?: string } },
    routedBy: RouteOnlyAnswer["routedBy"],
    localClis: readonly string[]
): RouteOnlyAnswer => ({
    model: entry.model.id,
    provider: entry.model.provider,
    ...(entry.capabilities.providerModelId ? { providerModel: entry.capabilities.providerModelId } : {}),
    routedBy,
    execution: routeOnlyExecution(entry.model.provider, localClis),
});
