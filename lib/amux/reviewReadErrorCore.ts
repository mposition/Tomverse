export type AmuxReviewReadError =
  | "reauthentication"
  | "disabled"
  | "proxy_configuration"
  | "access_refused"
  | "not_found"
  | "temporarily_unavailable"
  | "load_failed";

/** Classifies a failed detail read only. Never use this to retry a decision. */
export function amuxReviewReadError(status: number, code: string | null): AmuxReviewReadError {
  if (status === 428 || code === "ADMIN_REAUTHENTICATION_REQUIRED") return "reauthentication";
  if (code === "AMUX_AGENT_APPROVAL_UNAVAILABLE") return "disabled";
  if (code === "AMUX_REVIEW_PROXY_CONFIG_INVALID" ||
      code === "AMUX_REVIEW_PROXY_ORIGIN_MISMATCH" ||
      code === "AMUX_REVIEW_PROXY_COOKIE_UNAVAILABLE" ||
      code === "AMUX_REVIEW_PROXY_REDIRECT_REFUSED") return "proxy_configuration";
  if (status === 401 || status === 403 || status === 421) return "access_refused";
  if (status === 404) return "not_found";
  if (status === 429 || status === 503 || status === 504) return "temporarily_unavailable";
  return "load_failed";
}
