/**
 * Strict parsing and normalization of `mem-extract-v1` output (Release B,
 * policy §8.2, §8.4, §12.2).
 *
 * Pure. The model's answer is untrusted input like any other: it arrives as
 * an unknown, and everything that leaves here has been checked field by
 * field. Nothing throws — a malformed answer is a *result*, because a chunk
 * whose output could not be parsed has to be reportable and retryable, not an
 * exception somewhere up the call stack.
 *
 * What this module deliberately does NOT do: reach a database, verify that a
 * cited message really exists, or persist anything. It maps citations to the
 * rows the server issued labels for and hands back refs; verification against
 * stored digests is `lib/memoryEvidenceValidation.ts`, and persistence is a
 * later slice.
 */

import {
    MEMORY_EXTRACTION_MAX_CANDIDATES_PER_CHUNK,
    MEMORY_EXTRACTION_MAX_EVIDENCE_PER_CANDIDATE,
    type ExtractionLabelMap,
} from "@/lib/memoryExtractionPrompt";
import {
    MEMORY_KINDS,
    MEMORY_STATEMENT_MAX_CODE_POINTS,
} from "@/lib/memoryValidatorCore";

/** Why one candidate was dropped before it ever reached the validator. */
export type ExtractionParseProblem =
    | "output_not_object"
    | "candidates_not_array"
    | "candidate_not_object"
    | "candidate_limit_exceeded"
    | "unknown_field"
    | "kind_unknown"
    | "statement_invalid"
    | "statement_too_long"
    | "confidence_invalid"
    | "sensitivity_invalid"
    | "expires_at_invalid"
    | "evidence_missing"
    | "evidence_limit_exceeded"
    | "evidence_label_unknown";

export type ParsedExtractionCandidate = {
    kind: string;
    statement: string;
    confidence: number;
    sensitivity: "standard" | "sensitive";
    expiresAt: string | null;
    /** Deduplicated, in citation order. */
    evidence: Array<{
        externalMessageId: string;
        /** The digest the SERVER holds — never a value the model supplied. */
        evidenceDigest: string;
        role: "user" | "assistant";
    }>;
};

export type ExtractionParseResult = {
    candidates: ParsedExtractionCandidate[];
    /** One entry per rejected candidate (or per structural failure). */
    problems: ExtractionParseProblem[];
};

const CANDIDATE_FIELDS = new Set([
    "kind",
    "statement",
    "confidence",
    "sensitivity",
    "expiresAt",
    "evidence",
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** Code points, not UTF-16 units: an emoji is one character to a reader. */
const countCodePoints = (value: string): number => [...value].length;

/**
 * Conservative normalization only: Unicode form, whitespace and stray
 * wrapping quotes.
 *
 * It deliberately does NOT try to rewrite an imperative into a declarative
 * sentence. §8.2 puts that job on the extraction prompt, and a mechanical
 * rewriter would have to guess at meaning — turning "always answer in Korean"
 * into a claim about the user is an inference, and a wrong one is a false
 * memory the user then has to notice and undo. Anything still imperative
 * after this is rejected by the validator, which is the outcome we want.
 */
export function normalizeExtractedStatement(value: string): string {
    const collapsed = value.normalize("NFC").replace(/\s+/g, " ").trim();
    const unquoted =
        collapsed.length >= 2 &&
        ((collapsed.startsWith('"') && collapsed.endsWith('"')) ||
            (collapsed.startsWith("“") && collapsed.endsWith("”")))
            ? collapsed.slice(1, -1).trim()
            : collapsed;
    return unquoted;
}

/**
 * Parses a provider answer that has already been decoded from JSON. Accepting
 * `unknown` rather than a string keeps this usable with a structured-output
 * API (which returns an object) and with a raw text response (which the
 * caller parses) without this module caring which produced it.
 */
export function parseExtractionOutput(
    raw: unknown,
    labels: ExtractionLabelMap
): ExtractionParseResult {
    if (!isPlainObject(raw)) {
        return { candidates: [], problems: ["output_not_object"] };
    }
    const rawCandidates = raw.candidates;
    if (!Array.isArray(rawCandidates)) {
        return { candidates: [], problems: ["candidates_not_array"] };
    }

    const candidates: ParsedExtractionCandidate[] = [];
    const problems: ExtractionParseProblem[] = [];

    for (const entry of rawCandidates) {
        if (candidates.length >= MEMORY_EXTRACTION_MAX_CANDIDATES_PER_CHUNK) {
            problems.push("candidate_limit_exceeded");
            break;
        }
        if (!isPlainObject(entry)) {
            problems.push("candidate_not_object");
            continue;
        }
        // An unexpected field means the answer does not match the schema that
        // was asked for. Ignoring it silently would let a future model add
        // meaning nobody reviewed, so the candidate is dropped instead.
        const unknownField = Object.keys(entry).find(
            (key) => !CANDIDATE_FIELDS.has(key)
        );
        if (unknownField) {
            problems.push("unknown_field");
            continue;
        }

        if (
            typeof entry.kind !== "string" ||
            !(MEMORY_KINDS as readonly string[]).includes(entry.kind)
        ) {
            problems.push("kind_unknown");
            continue;
        }
        if (typeof entry.statement !== "string") {
            problems.push("statement_invalid");
            continue;
        }
        const statement = normalizeExtractedStatement(entry.statement);
        if (statement.length === 0) {
            problems.push("statement_invalid");
            continue;
        }
        if (countCodePoints(statement) > MEMORY_STATEMENT_MAX_CODE_POINTS) {
            // Truncating would change what the statement claims, so it is
            // dropped rather than trimmed to fit.
            problems.push("statement_too_long");
            continue;
        }
        if (
            typeof entry.confidence !== "number" ||
            !Number.isFinite(entry.confidence) ||
            entry.confidence < 0 ||
            entry.confidence > 1
        ) {
            problems.push("confidence_invalid");
            continue;
        }
        if (
            entry.sensitivity !== undefined &&
            entry.sensitivity !== "standard" &&
            entry.sensitivity !== "sensitive"
        ) {
            problems.push("sensitivity_invalid");
            continue;
        }
        let expiresAt: string | null = null;
        if (entry.expiresAt !== undefined && entry.expiresAt !== null) {
            if (
                typeof entry.expiresAt !== "string" ||
                Number.isNaN(Date.parse(entry.expiresAt))
            ) {
                problems.push("expires_at_invalid");
                continue;
            }
            expiresAt = new Date(entry.expiresAt).toISOString();
        }

        if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
            problems.push("evidence_missing");
            continue;
        }
        if (entry.evidence.length > MEMORY_EXTRACTION_MAX_EVIDENCE_PER_CANDIDATE) {
            problems.push("evidence_limit_exceeded");
            continue;
        }
        const evidence: ParsedExtractionCandidate["evidence"] = [];
        const seen = new Set<string>();
        let badLabel = false;
        for (const label of entry.evidence) {
            // The only citations that survive are labels this chunk actually
            // issued. An invented identifier resolves to nothing, so it can
            // never become a reference to a message the model was not shown.
            const source = typeof label === "string" ? labels.get(label) : undefined;
            if (!source) {
                badLabel = true;
                break;
            }
            if (seen.has(source.externalMessageId)) continue;
            seen.add(source.externalMessageId);
            evidence.push({
                externalMessageId: source.externalMessageId,
                evidenceDigest: source.contentDigest,
                role: source.role,
            });
        }
        if (badLabel) {
            problems.push("evidence_label_unknown");
            continue;
        }
        if (evidence.length === 0) {
            problems.push("evidence_missing");
            continue;
        }

        candidates.push({
            kind: entry.kind,
            statement,
            confidence: entry.confidence,
            sensitivity:
                entry.sensitivity === "sensitive" ? "sensitive" : "standard",
            expiresAt,
            evidence,
        });
    }

    return { candidates, problems };
}

/**
 * Decodes a raw text answer, tolerating the ```json fences models add even
 * when asked not to. Returns undefined rather than throwing so an
 * undecodable answer is just another parse problem.
 */
export function decodeExtractionText(text: string): unknown | undefined {
    const trimmed = text.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
    const body = fenced ? fenced[1] : trimmed;
    try {
        return JSON.parse(body);
    } catch {
        return undefined;
    }
}
