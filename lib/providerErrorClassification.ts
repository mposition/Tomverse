// Shared, provider-agnostic error classification. Originally private to
// app/api/chat/route.ts; extracted so the AUD-R001 synthetic provider probe
// (lib/providerProbe.ts) produces failure codes in the exact same shape
// that lib/providerMonitoring.ts's errorExplanationFor() already knows how
// to classify, instead of inventing a second, incompatible taxonomy.
//
// Pure and dependency-free: no Prisma, no Next.js request/response types,
// safe to import from a Route Handler, a cron-triggered internal route, or
// a unit test.

export type SafeErrorMetadata = {
    name: string;
    code?: string;
    statusCode?: number;
    isRetryable?: boolean;
};

export const safeErrorMetadata = (error: unknown): SafeErrorMetadata => {
    if (!error || typeof error !== "object") {
        return { name: "UnknownError" };
    }

    const candidate = error as {
        name?: unknown;
        code?: unknown;
        status?: unknown;
        statusCode?: unknown;
        isRetryable?: unknown;
    };
    return {
        name:
            typeof candidate.name === "string"
                ? candidate.name.slice(0, 80)
                : "Error",
        code:
            typeof candidate.code === "string" &&
            /^[A-Za-z0-9_.-]{1,80}$/.test(candidate.code)
                ? candidate.code
                : undefined,
        statusCode:
            typeof candidate.statusCode === "number"
                ? candidate.statusCode
                : typeof candidate.status === "number"
                  ? candidate.status
                  : undefined,
        isRetryable:
            typeof candidate.isRetryable === "boolean"
                ? candidate.isRetryable
                : undefined,
    };
};

export const safeErrorMessage = (error: unknown): string | undefined => {
    if (!error || typeof error !== "object" || !("message" in error)) {
        return undefined;
    }
    return typeof error.message === "string" ? error.message : undefined;
};

/**
 * Builds codes like "AI_REQUEST_FAILED.ECONNRESET.HTTP_503.RETRYABLE" --
 * the exact shape lib/providerMonitoring.ts's errorExplanationFor() matches
 * against with its rate-limit/auth/transient-failure regexes.
 */
export const providerDiagnosticCode = (fallback: string, error: unknown): string => {
    const metadata = safeErrorMetadata(error);
    return [
        fallback,
        metadata.code || metadata.name,
        metadata.statusCode ? `HTTP_${metadata.statusCode}` : null,
        metadata.isRetryable === true ? "RETRYABLE" : null,
    ]
        .filter((value): value is string => Boolean(value))
        .join(".");
};

export type ProbeErrorClassification =
    | "TIMEOUT"
    | "AUTH"
    | "RATE_LIMIT"
    | "SERVER_ERROR"
    | "NETWORK"
    | "UNKNOWN";

/**
 * Coarse, public-safe classification for ProviderProbeResult.errorClassification
 * -- never a raw provider message, just one of a fixed small set of labels.
 * Mirrors the same regex families lib/providerMonitoring.ts's
 * errorExplanationFor() already uses for the admin-facing free-text
 * explanation, condensed to a label instead of a sentence.
 */
export const classifyProbeError = (
    diagnosticCode: string | null | undefined,
    timedOut = false
): ProbeErrorClassification => {
    if (timedOut) return "TIMEOUT";
    if (!diagnosticCode) return "UNKNOWN";
    if (/429|RATE.?LIMIT/i.test(diagnosticCode)) return "RATE_LIMIT";
    if (/401|403|AUTH|KEY/i.test(diagnosticCode)) return "AUTH";
    if (/5\d\d/.test(diagnosticCode)) return "SERVER_ERROR";
    if (/TIMEOUT|ECONN|NETWORK/i.test(diagnosticCode)) return "NETWORK";
    return "UNKNOWN";
};
