import type { webLocales } from "./answer-locales";

/** The server's own error code, as the sentence the web shows for it. */
export function compareFailureText(chat: typeof webLocales.en.chat, code: string | null) {
  switch (code) {
    case "COMPARISON_RESPONSES_REQUIRED": return chat.aiReviewResponsesRequired;
    case "API_RATE_LIMITED": return chat.compareRateLimited;
    case "QUICK_COMPARISON_REVIEWER_UNAVAILABLE": return chat.compareServiceUnavailable;
    case "QUICK_COMPARISON_FAILED": return chat.compareGenerationFailed;
    default: return chat.compareUnavailable;
  }
}
