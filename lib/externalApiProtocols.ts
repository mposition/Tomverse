/**
 * The external API's wire protocols and which provider carries each natively.
 * Dependency-free so the settings page can import it without the server-side
 * estimators (docs/policy/external-api.md, section 10).
 */
export const EXTERNAL_API_PROTOCOLS = ["chat_completions", "anthropic_messages", "responses"] as const;
export type ExternalApiProtocol = (typeof EXTERNAL_API_PROTOCOLS)[number];

/** Which runtime providers a native protocol can carry without translation. */
export const NATIVE_PROTOCOL_PROVIDER: Record<Exclude<ExternalApiProtocol, "chat_completions">, string> = {
    anthropic_messages: "anthropic",
    responses: "openai",
};

/** Every protocol a model of this provider can be called through. */
export const protocolsForProvider = (provider: string): ExternalApiProtocol[] => [
    "chat_completions",
    ...(Object.entries(NATIVE_PROTOCOL_PROVIDER)
        .filter(([, owner]) => owner === provider)
        .map(([protocol]) => protocol as ExternalApiProtocol)),
];

/**
 * The model a request names: a Tomverse model id, or else the provider's own
 * model id when exactly one offered model uses it. A coding tool's built-in
 * model list (Cursor's, with the OpenAI base URL overridden) sends a provider
 * id rather than a Tomverse one, so a model Tomverse offers then works without
 * a custom model. Never a different model: a name no offered model uses is
 * not found, rather than answered by something else and charged as it.
 */
export const pickRequestedModel = <Entry extends { model: { id: string; apiModel: string } }>(
    entries: readonly Entry[],
    requested: string
): { entry: Entry } | { ambiguous: Entry[] } | null => {
    const byId = entries.find((entry) => entry.model.id === requested);
    if (byId) return { entry: byId };
    const byApiModel = entries.filter((entry) => entry.model.apiModel === requested);
    if (byApiModel.length === 1) return { entry: byApiModel[0] };
    return byApiModel.length > 1 ? { ambiguous: byApiModel } : null;
};
