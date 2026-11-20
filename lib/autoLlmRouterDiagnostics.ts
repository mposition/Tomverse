import {
    APICallError,
    InvalidResponseDataError,
    JSONParseError,
    NoObjectGeneratedError,
    NoOutputGeneratedError,
    TypeValidationError,
} from "ai";

type RouterFailureDetail = {
    failureKind: "output_parse" | "output_validation" | "output_generation" | "output_missing" |
        "provider" | "provider_response" | "timeout" | "unknown";
    statusCode?: number;
    statusClass?: ProviderStatusClass;
    finishReason?: string;
    outputChars?: number;
};

export type ProviderStatusClass = "auth" | "request" | "rate_limit" | "server" | "other";

/**
 * What an HTTP status says about one failed provider call: credentials
 * (401/403), the request or its parameters (400/404/409/413/422), quota (429),
 * or the provider side (408, 5xx). A label for grouping individual failures by
 * cause; it is not a verdict on why a model fails in aggregate.
 */
export const providerStatusClass = (statusCode: number): ProviderStatusClass =>
    statusCode === 401 || statusCode === 403 ? "auth"
        : [400, 404, 409, 413, 422].includes(statusCode) ? "request"
        : statusCode === 429 ? "rate_limit"
        : statusCode === 408 || (statusCode >= 500 && statusCode <= 599) ? "server"
        : "other";

const FINISH_REASONS = new Set(["stop", "length", "content-filter", "tool-calls", "error", "other", "unknown"]);

export const autoLlmRouterFinishReason = (value: unknown): string | undefined =>
    typeof value === "string" && FINISH_REASONS.has(value) ? value : undefined;

/** Only categorical and numeric diagnostics; never error messages, bodies or headers. */
export const autoLlmRouterFailureDetail = (
    error: unknown,
    context: { timedOut?: boolean; finishReason?: unknown } = {}
): RouterFailureDetail => {
    const structured = NoObjectGeneratedError.isInstance(error);
    const cause = structured ? error.cause : error;
    const detail: RouterFailureDetail = {
        failureKind: context.timedOut ? "timeout"
            : JSONParseError.isInstance(cause) ? "output_parse"
            : TypeValidationError.isInstance(cause) ? "output_validation"
            : structured ? "output_generation"
            : NoOutputGeneratedError.isInstance(error) ? "output_missing"
            : APICallError.isInstance(error) ? "provider"
            : InvalidResponseDataError.isInstance(error) ? "provider_response"
            : "unknown",
    };
    if (APICallError.isInstance(error) && typeof error.statusCode === "number" &&
        Number.isInteger(error.statusCode) && error.statusCode >= 100 && error.statusCode <= 599) {
        detail.statusCode = error.statusCode;
        detail.statusClass = providerStatusClass(error.statusCode);
    }
    const finishReason = autoLlmRouterFinishReason(structured ? error.finishReason : context.finishReason);
    if (finishReason !== undefined) {
        detail.finishReason = finishReason;
    }
    if ((structured || JSONParseError.isInstance(error)) && typeof error.text === "string") {
        detail.outputChars = error.text.length;
    }
    return detail;
};
