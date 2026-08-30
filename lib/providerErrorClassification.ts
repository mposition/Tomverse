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
        // AWS SDK v3 puts the HTTP status here and nowhere else. Reading it
        // does not make an S3 error a provider error -- the failure layer
        // decides that (lib/chatFailureLayer.ts) -- but a status of `undefined`
        // on a 404 is how a storage failure reached classifyProviderFailure
        // with nothing to classify on and fell through to "count it against
        // the provider".
        $metadata?: { httpStatusCode?: unknown };
    };
    const httpStatus =
        typeof candidate.statusCode === "number"
            ? candidate.statusCode
            : typeof candidate.status === "number"
              ? candidate.status
              : typeof candidate.$metadata?.httpStatusCode === "number"
                ? candidate.$metadata.httpStatusCode
                : undefined;
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
        statusCode: httpStatus,
        isRetryable:
            typeof candidate.isRetryable === "boolean"
                ? candidate.isRetryable
                : undefined,
    };
};

/**
 * Strips credentials out of provider-originated text before it is persisted or
 * shown to an operator. Provider errors routinely echo the request back, which
 * is how an Authorization header ends up in an error message.
 *
 * Returns null for anything that reduces to empty, so callers can store NULL
 * rather than an empty string.
 */
export const redactProviderText = (
    value: string | null | undefined,
    maxLength: number
): string | null => {
    if (!value) return null;
    return (
        value
            .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
            .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]")
            .replace(
                /\b(api[_-]?key|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi,
                "$1=[REDACTED]"
            )
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, maxLength) || null
    );
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

/**
 * Diagnostic-code roots that are only ever produced *after* an actual HTTP
 * request left this process for a provider. Anything else recorded through
 * recordProviderFailure -- a ChatAccessError code, a quota rejection, an
 * attachment validation failure -- describes a request Tomverse refused to
 * send, and must never be counted against the provider.
 *
 * This allowlist, not the HTTP status, is what decides "did we actually talk
 * to the provider": ChatAccessError carries its own `status` (429 for a quota
 * rejection, 402 for insufficient credit), and safeErrorMetadata surfaces it,
 * so status-first classification would file our own rate limiting as the
 * provider's. Roots are matched on the segment before the first ".", which is
 * the `fallback` argument providerDiagnosticCode() is called with.
 *
 * Adding a new provider-call code means adding it here too; tests/
 * providerErrorClassification.test.mjs statically scans the route handlers
 * and fails if a recordProviderFailure code is missing from this list.
 */
export const PROVIDER_CALL_DIAGNOSTIC_ROOTS = [
    "AI_REQUEST_FAILED",
    "AI_STREAM_FAILED",
    "AI_EMPTY_RESPONSE",
    "PROVIDER_PROBE_FAILED",
    "PROVIDER_VERIFICATION_FAILED",
    "QUICK_COMPARISON_FAILED",
    "VERIFICATION_ITEM_FAILED",
    // AI Review's own generateText wrapper, the same shape as the two above.
    // It was missing because the drift test listed route files by hand and
    // this call lives in a service, so every AI Review failure -- including a
    // real provider outage -- classified as a local rejection and taught
    // provider health nothing. Safe to count only because the service now
    // records nothing at all for its own ChatAccessError refusals.
    "COMPARISON_REVIEW_FAILED",
    "DEEP_RESEARCH_SUBMIT_FAILED",
    "DEEP_RESEARCH_JOB_FAILED",
] as const;

const providerCallRoots = new Set<string>(PROVIDER_CALL_DIAGNOSTIC_ROOTS);

/**
 * Whether a diagnostic code names a failure that happened after a request left
 * this process for a provider.
 *
 * Exported so a caller can ask *before* recording rather than relying on
 * `recordProviderFailure` to file the code and then classify it away. The
 * difference matters for `ProviderErrorEvent`: a locally rejected request is
 * still written to that table for the diagnostic trail, and a storage 404 has
 * no business being in a table of provider errors at all.
 */
export const isProviderCallDiagnosticCode = (
    code: string | null | undefined
): boolean => providerCallRoots.has((code || "").split(".")[0] || "");

/** Which health counters a single failure is legitimate evidence for. */
export type ProviderFailureScope = "provider" | "model" | "none";

export type ProviderFailureCategory =
    /** Tomverse rejected the request locally; it never reached the provider. */
    | "LOCAL_REJECTION"
    /** The provider rejected the request we sent (bad role order, bad params). */
    | "REQUEST_CONTRACT"
    /** The provider does not know this model id. */
    | "MODEL_NOT_FOUND"
    /** The call reached the model but produced nothing usable. */
    | "MODEL_TRANSIENT"
    | "AUTHENTICATION"
    | "PAYMENT_REQUIRED"
    | "RATE_LIMIT"
    | "SERVER_ERROR"
    | "NETWORK"
    | "UNKNOWN";

export type ProviderFailureClassification = {
    category: ProviderFailureCategory;
    scope: ProviderFailureScope;
    /** The HTTP status the verdict was reached with, when one was available. */
    httpStatus: number | null;
    /** Short, operator-facing justification. Never contains provider text. */
    reason: string;
};

const PROVIDER_SCOPED: ProviderFailureCategory[] = [
    "AUTHENTICATION",
    "PAYMENT_REQUIRED",
    "RATE_LIMIT",
    "SERVER_ERROR",
    "NETWORK",
    "UNKNOWN",
];

export const isProviderScopedFailureCategory = (
    category: ProviderFailureCategory
) => PROVIDER_SCOPED.includes(category);

const diagnosticRoot = (code: string | null | undefined) =>
    (code || "").split(".")[0] || "";

const parseHttpStatus = (
    httpStatus: number | null | undefined,
    diagnosticCode: string | null | undefined
): number | null => {
    if (
        typeof httpStatus === "number" &&
        Number.isSafeInteger(httpStatus) &&
        httpStatus >= 100 &&
        httpStatus <= 599
    ) {
        return httpStatus;
    }
    const match = /HTTP_(\d{3})/.exec(diagnosticCode || "");
    if (!match) return null;
    const parsed = Number(match[1]);
    return parsed >= 100 && parsed <= 599 ? parsed : null;
};

/**
 * Decides what one recorded failure is evidence *of*.
 *
 * The rule this exists to enforce: a provider answering "400 invalid_message"
 * is telling us our request was malformed, not that it is down. Five of those
 * used to read identically to five 503s, which pinned an entire provider --
 * and every model under it -- to Incident until a real success arrived, with
 * no such success possible while the whole provider was blocked.
 *
 * Pure and dependency-free so the chat route, the dashboard and the tests all
 * reach the same verdict from the same inputs.
 */
export const classifyProviderFailure = ({
    diagnosticCode,
    httpStatus,
    timedOut = false,
}: {
    diagnosticCode: string | null | undefined;
    httpStatus?: number | null;
    timedOut?: boolean;
}): ProviderFailureClassification => {
    const status = parseHttpStatus(httpStatus, diagnosticCode);
    const code = diagnosticCode || "";
    const root = diagnosticRoot(code);

    if (!providerCallRoots.has(root)) {
        return {
            category: "LOCAL_REJECTION",
            scope: "none",
            httpStatus: status,
            reason:
                "Tomverse rejected this request before it reached the provider, so it is not provider health evidence.",
        };
    }

    // Roots that describe a *completed* provider round trip whose outcome was
    // specific to one model: the call itself worked, the model's answer did
    // not. Escalating these to the whole provider was an explicit decision to
    // reverse -- an async deep-research job failing says nothing about whether
    // sonar can answer a question, and a genuine provider outage surfaces
    // separately as a 5xx on the submit or poll call.
    if (root === "AI_EMPTY_RESPONSE" || root === "DEEP_RESEARCH_JOB_FAILED") {
        return {
            category: "MODEL_TRANSIENT",
            scope: "model",
            httpStatus: status,
            reason:
                "The provider answered but the model returned no usable result, which is a model-scoped outcome.",
        };
    }

    if (timedOut) {
        return {
            category: "NETWORK",
            scope: "provider",
            httpStatus: status,
            reason: "The request to the provider timed out before a response arrived.",
        };
    }

    if (status !== null) {
        if (status === 401 || status === 403) {
            return {
                category: "AUTHENTICATION",
                scope: "provider",
                httpStatus: status,
                reason: `The provider rejected our credentials (HTTP ${status}), which blocks every model under it.`,
            };
        }
        if (status === 402) {
            return {
                category: "PAYMENT_REQUIRED",
                scope: "provider",
                httpStatus: status,
                reason:
                    "The provider account cannot fund requests (HTTP 402), which blocks every model under it.",
            };
        }
        if (status === 429) {
            return {
                category: "RATE_LIMIT",
                scope: "provider",
                httpStatus: status,
                reason:
                    "The provider is rate limiting this account (HTTP 429), which constrains every model under it.",
            };
        }
        if (status === 404) {
            return {
                category: "MODEL_NOT_FOUND",
                scope: "model",
                httpStatus: status,
                reason:
                    "The provider does not recognise this model id (HTTP 404), which is a registry problem for one model.",
            };
        }
        if (status === 408) {
            return {
                category: "NETWORK",
                scope: "provider",
                httpStatus: status,
                reason: "The provider timed the request out (HTTP 408).",
            };
        }
        if (status >= 400 && status < 500) {
            return {
                category: "REQUEST_CONTRACT",
                scope: "model",
                httpStatus: status,
                reason: `The provider rejected the request we sent (HTTP ${status}). This is a request-contract error, not a provider outage.`,
            };
        }
        if (status >= 500) {
            return {
                category: "SERVER_ERROR",
                scope: "provider",
                httpStatus: status,
                reason: `The provider returned a server error (HTTP ${status}).`,
            };
        }
    }

    if (/RATE.?LIMIT/i.test(code)) {
        return {
            category: "RATE_LIMIT",
            scope: "provider",
            httpStatus: status,
            reason: "The provider reported rate limiting without an HTTP status.",
        };
    }
    if (/UNAUTHORIZED|FORBIDDEN|API.?KEY|\bAUTH\b|AUTHENTICATION/i.test(code)) {
        return {
            category: "AUTHENTICATION",
            scope: "provider",
            httpStatus: status,
            reason:
                "The provider reported an authentication or authorization problem without an HTTP status.",
        };
    }
    if (
        /TIMEOUT|ETIMEDOUT|ECONN|EPIPE|ENOTFOUND|EAI_AGAIN|NETWORK|SOCKET|FETCH_FAILED|ABORTERROR/i.test(
            code
        )
    ) {
        return {
            category: "NETWORK",
            scope: "provider",
            httpStatus: status,
            reason:
                "The request never completed a round trip to the provider (network, DNS, or connection failure).",
        };
    }

    return {
        category: "UNKNOWN",
        scope: "provider",
        httpStatus: status,
        reason:
            "The failure came from a provider call but could not be classified, so it is counted against the provider.",
    };
};

export type ProbeErrorClassification =
    | "TIMEOUT"
    | "AUTH"
    | "RATE_LIMIT"
    | "MODEL_NOT_FOUND"
    | "BAD_REQUEST"
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
    // Anchored on the HTTP_ prefix providerDiagnosticCode() emits, unlike the
    // looser patterns above: a bare /404/ would also match digits that happen
    // to appear in a provider error name or code. On this call path -- a
    // chat-completion request naming exactly one model -- a 404 means the
    // provider does not know that model id (registry drift), and a 400 means
    // it rejected the request we sent. Both used to fall through to UNKNOWN,
    // which is what made a config problem indistinguishable from an outage.
    if (/HTTP_404/.test(diagnosticCode)) return "MODEL_NOT_FOUND";
    if (/HTTP_400/.test(diagnosticCode)) return "BAD_REQUEST";
    if (/5\d\d/.test(diagnosticCode)) return "SERVER_ERROR";
    if (/TIMEOUT|ECONN|NETWORK/i.test(diagnosticCode)) return "NETWORK";
    return "UNKNOWN";
};
