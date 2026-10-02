import "server-only";

const PRODUCTION_CANONICAL_ORIGIN = "https://tomverse.app";

const normalizeOrigin = (value: string | undefined) => {
    if (!value) return null;

    try {
        const url = new URL(value);
        // WHATWG `hostname` keeps the brackets for an IPv6 host, so the bare
        // `::1` never matched `[::1]` and a production origin configured as
        // that loopback literal was accepted as the app's public origin --
        // the one failure direction here, since every absolute URL the app
        // hands out would then point at the server's own loopback.
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        const isLocalHost =
            hostname === "localhost" ||
            hostname.endsWith(".localhost") ||
            hostname === "127.0.0.1" ||
            hostname === "::1";
        if (
            (url.protocol !== "https:" &&
                !(process.env.NODE_ENV !== "production" &&
                    url.protocol === "http:")) ||
            (process.env.NODE_ENV === "production" && isLocalHost) ||
            url.username ||
            url.password
        ) {
            return null;
        }
        return url.origin;
    } catch {
        return null;
    }
};

export const getPublicAppOrigin = (request: Request) => {
    const configuredOrigins = [
        process.env.NEXT_PUBLIC_SHARE_BASE_URL,
        process.env.PUBLIC_APP_URL,
        process.env.NEXT_PUBLIC_APP_URL,
    ];

    for (const configuredOrigin of configuredOrigins) {
        const normalized = normalizeOrigin(configuredOrigin);
        if (normalized) return normalized;
    }

    if (process.env.NODE_ENV === "production") {
        return PRODUCTION_CANONICAL_ORIGIN;
    }

    return normalizeOrigin(new URL(request.url).origin) || "http://localhost:3000";
};
