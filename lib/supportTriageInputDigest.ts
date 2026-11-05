/**
 * The input digest a suggestion is bound to (design section 5.3).
 *
 * SHA-256 of the canonical JSON of everything the deterministic rules read:
 * the report's own fields, its evidence and auto-fix case when present, and
 * the generator versions. A change to any of them is a new input: the old
 * open suggestion is superseded and a new one is made. A rule, keyword list
 * or template version change therefore supersedes every open suggestion.
 *
 * The digest is derived from the report's text (a short report could be
 * matched by guessing), so it lives only in the suggestion row and its
 * deletion and retention, and never in a log, a digest item or an audit row.
 *
 * Pure: no I/O.
 */
import { createHash } from "node:crypto";

/** Bump when the lane rule or anything else in the core that reads a report changes. */
export const SUPPORT_TRIAGE_CORE_VERSION = "1";
/** Bump when lib/supportTriageKeywords.ts changes a list. */
export const SUPPORT_TRIAGE_KEYWORD_LIST_VERSION = "1";
/** No reply templates exist yet (stage P1.5); "none" until they do. */
export const SUPPORT_TRIAGE_TEMPLATE_VERSION = "none";

/** JSON with object keys sorted at every depth; arrays keep their order. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("canonical JSON has no non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError(`canonical JSON cannot hold ${typeof value}`);
};

export type SuggestionInput = {
  readonly report: {
    readonly message: string;
    readonly type: string;
    readonly language: string;
    readonly status: string;
    readonly errorReportVerification: string | null;
    readonly traceProvenance: string | null;
    readonly errorClassificationSource: string | null;
    readonly clientErrorCode: string | null;
    readonly evidenceAvailability: string | null;
    readonly traceEvidenceId: string | null;
  };
  readonly evidence: {
    readonly errorCode: string | null;
    readonly routeClass: string;
    readonly release: string | null;
    readonly retryable: boolean | null;
    readonly failureLayer: string | null;
  } | null;
  readonly autoFixCase: { readonly state: string; readonly classification: string | null } | null;
};

export const suggestionInputDigest = (input: SuggestionInput): string =>
  createHash("sha256")
    .update(
      canonicalJson({
        report: input.report,
        evidence: input.evidence,
        autoFixCase: input.autoFixCase,
        generator: {
          coreVersion: SUPPORT_TRIAGE_CORE_VERSION,
          keywordListVersion: SUPPORT_TRIAGE_KEYWORD_LIST_VERSION,
          templateVersion: SUPPORT_TRIAGE_TEMPLATE_VERSION,
        },
      }),
      "utf8"
    )
    .digest("hex");
