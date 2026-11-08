import { APICallError, JSONParseError, NoObjectGeneratedError, TypeValidationError } from "ai";
import { contentFreeErrorMetadata } from "@/lib/providerErrorClassification";

/** Only error labels and counts may leave the call; SDK errors carry request bodies. */
export const autoLlmRouterFailureDetail = (error: unknown, deadlineReached = false) => {
    const metadata = contentFreeErrorMetadata(error);
    const outputError = NoObjectGeneratedError.isInstance(error) ? error : null;
    const cause = outputError?.cause ?? error;
    const failureKind = deadlineReached || metadata.name === "TimeoutError"
        ? "timeout"
        : metadata.name === "AbortError"
          ? "aborted"
          : JSONParseError.isInstance(cause)
            ? "response_parse"
            : TypeValidationError.isInstance(cause)
              ? "response_schema"
              : outputError
                ? "response_output"
                : APICallError.isInstance(error)
                  ? "api"
                  : "unknown";
    return {
        failureKind,
        ...metadata,
        ...(outputError ? {
            causeName: contentFreeErrorMetadata(cause).name,
            finishReason: typeof outputError.finishReason === "string" &&
                /^[a-z-]{1,32}$/.test(outputError.finishReason) ? outputError.finishReason : undefined,
            outputChars: outputError.text?.length,
        } : {}),
    };
};
