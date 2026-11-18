import "server-only";
import { PROVIDER_API_CONFIGURATION, resolveProviderApiKey } from "@/lib/modelRegistryShared";

/**
 * The one place a native-protocol request leaves Tomverse. The base URL and
 * the credential are the deployment's own for that provider -- never from the
 * request, the model registry or the client -- so a client cannot point the
 * gateway anywhere else, and the customer's Tomverse key never goes upstream.
 *
 * One call, no retry: the caller treats any failure after this point as an
 * unknown outcome and settles it, never sends it again.
 */
export type NativeUpstreamProvider = "anthropic" | "openai";

export class NativeUpstreamUnavailable extends Error {
    constructor() {
        super("The provider credential is not configured on this deployment.");
        this.name = "NativeUpstreamUnavailable";
    }
}

export const nativeUpstreamFetch = (
    provider: NativeUpstreamProvider,
    path: string,
    init: { body: string; headers: Record<string, string>; signal: AbortSignal }
): Promise<Response> => {
    const apiKey = resolveProviderApiKey(provider);
    if (!apiKey) throw new NativeUpstreamUnavailable();
    const auth: Record<string, string> =
        provider === "anthropic" ? { "x-api-key": apiKey } : { authorization: `Bearer ${apiKey}` };
    return fetch(`${PROVIDER_API_CONFIGURATION[provider].baseUrl}${path}`, {
        method: "POST",
        headers: { ...init.headers, ...auth, "content-type": "application/json" },
        body: init.body,
        signal: init.signal,
        redirect: "error",
    });
};
