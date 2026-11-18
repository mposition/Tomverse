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
