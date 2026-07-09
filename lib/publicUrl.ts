import "server-only";

const PRODUCTION_CANONICAL_ORIGIN = "https://tomverse.app";

const normalizeOrigin = (value: string | undefined) => {
    if (!value) return null;

    try {
        const url = new URL(value);
        const isLocalHost =
            url.hostname === "localhost" ||
            url.hostname.endsWith(".localhost") ||
            url.hostname === "127.0.0.1" ||
            url.hostname === "::1";
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
