/**
 * Vertex AI and Azure OpenAI in the ADR provider pool.
 *
 * Each official connection is a project, a location, or a resource name.
 * A single catalogue origin would be a region this module chose. There is
 * no global origin here, and neither host is a catalogue connection.
 * Residency stays unproven. Nothing here opens a client or writes a row.
 *
 * The request path does not import this module.
 */

export const REGION_PIN_HOSTS = ["vertex-ai", "azure-openai"] as const;

export type RegionPinHost = (typeof REGION_PIN_HOSTS)[number];

export type RegionPinHostDecision = {
    readonly host: RegionPinHost;
    readonly globalOrigin: null;
    readonly catalogueConnection: false;
    readonly residency: "unproven";
};

const named = (value: unknown): value is RegionPinHost =>
    typeof value === "string" &&
    (REGION_PIN_HOSTS as readonly string[]).includes(value);

/**
 * The decision for one named host.
 *
 * Unknown names are null. Null is not a connection and not a proof of
 * residency. The returned object cannot be assigned over.
 */
export const regionPinHostDecision = (
    host: unknown
): RegionPinHostDecision | null => {
    if (!named(host)) return null;
    return Object.freeze({
        host,
        globalOrigin: null,
        catalogueConnection: false,
        residency: "unproven",
    });
};
