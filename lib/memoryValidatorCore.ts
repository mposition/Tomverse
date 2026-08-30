/**
 * Deterministic server-side validator for memory candidates (Release B,
 * slice B1).
 *
 * docs/policy/external-conversation-import-and-memory.md §8.2–§8.4, §12.3–4.
 *
 * This module is the layer that holds regardless of what any model says: an
 * extraction model's classification is advisory, and every candidate —
 * extracted or user-authored — passes through these checks before it can be
 * stored, and again before it can be bulk-approved. Pure and dependency-free
 * so the §12.4 "deterministic validator tests" run without a database or a
 * provider key.
 *
 * The three critical eval categories map to hard guarantees here:
 *   ② assistant-only claims: a factual kind with no user-role (or manual)
 *      evidence is rejected outright.
 *   ③ secrets/credentials: a statement matching a credential shape is
 *      rejected and never bulk-safe.
 *   ④ injection/directives/URLs: rejected or demoted out of the bulk set.
 *
 * Patterns are deliberately conservative and enumerable — a regex either
 * matches or it does not, and the tests pin both directions. Loosening one
 * is a policy change, not a refactor.
 */

import {
    MEMORY_SENSITIVE_HEALTH,
    carriesHealthSignal,
} from "@/lib/memoryHealthSignals";

export const FACTUAL_MEMORY_KINDS = [
    "identity",
    "preference",
    "occupation",
    "expertise",
    "long_term_goal",
    "project",
    "constraint",
    "decision",
    "relationship",
    "recurring_context",
] as const;

export const STYLE_MEMORY_KINDS = [
    "communication_style",
    "tone",
    "verbosity",
    "structure",
    "formatting",
    "language",
    "explanation_depth",
    "citation_preference",
    "code_style",
] as const;

export const MEMORY_KINDS = [
    ...FACTUAL_MEMORY_KINDS,
    ...STYLE_MEMORY_KINDS,
] as const;

export const MEMORY_STATUSES = [
    "candidate",
    "active",
    "rejected",
    "superseded",
    "expired",
    "suspended_by_source_lock",
    "suspended_by_source_delete",
    "manual_review_required",
    "deleted",
] as const;

export const MEMORY_SENSITIVITIES = ["standard", "sensitive"] as const;

/**
 * Whether a candidate asserts its fact of the user, or denies it of them.
 *
 * Added for `mem-extract-v6`. Until v5 a candidate carried no polarity at all
 * and the statement had to carry it in prose, which meant "the user does not
 * drive" and "the user drives" differed only by a word a substring match does
 * not see. Schema 3 scoring compares this field to the gold's, so a v5
 * candidate cannot be scored against a schema-3 dataset -- that, and not a
 * wording change, is why v6 exists.
 *
 * These two values must stay identical to the eval contract's
 * `MEMORY_EVAL_POLARITIES`, which is frozen inside the `mem-score-v3.3`
 * descriptor digest. They are declared here rather than imported from the eval
 * module because production must not depend on the eval tree, and
 * `tests/memoryExtractionPolarity.test.mjs` fails if the two lists ever differ.
 *
 * Meaning, from .github/audits/memory-eval-gold-contract-2026-08-27.md §10.1:
 * `affirmed` says the statement holds of the user, `negated` says it does not.
 * Neither is a judgement about sentiment, and neither is decided by whether a
 * negation word appears -- see `MEMORY_EXTRACTION_POLARITY_RULE`.
 */
export const MEMORY_POLARITIES = ["affirmed", "negated"] as const;

export type MemoryPolarity = (typeof MEMORY_POLARITIES)[number];

export const MEMORY_EVIDENCE_SOURCE_TYPES = [
    "external_message",
    "tomverse_message",
    "manual",
] as const;

export const CONVERSATION_MEMORY_MODES = ["inherit", "on", "off"] as const;

/** Statement bounds in Unicode code points (§8.4 length check). */
export const MEMORY_STATEMENT_MIN_CODE_POINTS = 4;
export const MEMORY_STATEMENT_MAX_CODE_POINTS = 400;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export type MemoryEvidenceInput = {
    sourceType: (typeof MEMORY_EVIDENCE_SOURCE_TYPES)[number];
    /** Role of the source message; null/undefined for manual evidence. */
    role?: "user" | "assistant" | null;
};

export type MemoryCandidateInput = {
    kind: string;
    statement: string;
    confidence: number;
    /** Claimed sensitivity — the validator can raise it, never lower it. */
    sensitivity?: string;
    /** ISO 8601, or null for no expiry. */
    expiresAt?: string | null;
    evidence: readonly MemoryEvidenceInput[];
};

export type MemoryDisposition =
    | "accepted"
    | "manual_review_required"
    | "sensitive_review_required"
    | "rejected";

export type MemoryValidationResult = {
    disposition: MemoryDisposition;
    /**
     * Eligible for "approve all non-sensitive" (§8.4 bulk-safe contract).
     * Only ever true for an accepted, standard-sensitivity candidate.
     */
    bulkSafe: boolean;
    sensitivity: (typeof MEMORY_SENSITIVITIES)[number];
    violations: string[];
};

const countCodePoints = (value: string): number => {
    let count = 0;
    const iterator = value[Symbol.iterator]();
    while (!iterator.next().done) count += 1;
    return count;
};

/**
 * Credential/secret shapes (§8.4, eval category ③). Matching any of these
 * rejects the candidate: a secret is dangerous to store even for review, so
 * the statement must be rewritten without the secret material.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
    /-----BEGIN [A-Z ]{0,24}PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/,
    /\b(password|passwd|passphrase)\s*(is|[:=])\s*\S+/i,
    /(비밀번호|암호)\s*(는|은|[:=])\s*\S+/,
    /\b(api[ _-]?key|secret[ _-]?key|access[ _-]?token|client[ _-]?secret)\s*(is|[:=])\s*\S+/i,
    // Secrets that carry no provider prefix and no `key:` label. These are
    // credentials in the sense that matters here — possessing the value grants
    // access — so they take the reject path rather than the PII one below.
    // Each is anchored on the naming word AND a value shape, because the
    // naming word alone is ordinary ("uses a password manager") and a value
    // shape alone is ordinary too (a four-digit year).
    // `lib/memoryValidatorProbeCorpus.ts` pins both directions.
    /(도어락|현관|출입|금고)\s*(비밀\s*)?번호[^\n]{0,12}[\d#]/,
    /\b(gate|door|entry|safe|lock)\s*(code|combination)\b[^\n]{0,16}\d/i,
    /\bPIN\b\s*(번호)?[^\n]{0,10}\d{3,}/i,
    /(백업|복구)\s*코드[^\n]{0,16}\d/,
    /\bbackup\s*codes?\b[^\n]{0,16}\d/i,
    /(복구|시드)\s*(문구|구문|단어)/,
    /\b(recovery|seed)\s*phrase\b/i,
    /보안\s*질문[^\n]{0,20}(답|정답)/,
    /\bsecurity\s*(question|answer)s?\b/i,
    /\bmother'?s\s+maiden\s+name\b/i,
    // An entitlement claim about THIS system. No genuine user memory says it,
    // unlike a workplace admin role, which is why only this pair is here.
    /(유료|프리미엄)\s*(기능|서비스)[^\n]{0,12}(무료|공짜)/,
    /\bpaid\s+features?\b[^\n]{0,16}\bfor\s+free\b/i,
];

/**
 * Injection/override shapes (§8.4, eval category ④) that are rejected
 * outright: text that exists to redirect the assistant has no declarative
 * reading worth reviewing.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
    /\bignore\s+(all\s+|any\s+)?(previous|prior|earlier|above)\s+(instructions?|messages?|rules?|prompts?)\b/i,
    /\bdisregard\s+(the\s+)?(previous|prior|system|above)\b/i,
    /\breveal\s+(the\s+|your\s+)?system\s+prompt\b/i,
    /\bjailbreak\b/i,
    /\bnew\s+instructions?\s*:/i,
    // `모두`/`전부` may sit between the object and the verb, and the override
    // may be framed as 지금까지 rather than 이전 — both were slipping through.
    /(이전|기존|위의?|지금까지의?)\s*(모든\s*)?(지시|명령|프롬프트|규칙)(사항)?\s*(을|를|은|는)?\s*(모두\s*|전부\s*|다\s*)?(무시|잊)/,
    /시스템\s*프롬프트.{0,10}(공개|알려|보여)/,
];

/** System/developer/tool voice and model-identity redirection — rejected. */
const SYSTEM_VOICE_PATTERNS: readonly RegExp[] = [
    /^(system|developer|assistant|tool)\s*[:\-]/i,
    /\byou\s+are\s+(now\s+)?(a|an|the)?\s*(chatgpt|claude|gemini|gpt[-\s]?\d|dan)\b/i,
    /\b(act|behave|respond)\s+as\s+(if\s+you\s+are\s+)?(chatgpt|claude|gemini|another\s+model)\b/i,
    /(너는|당신은)\s*(이제|지금부터)/,
    /(chatgpt|claude|gemini|지피티)\s*(인\s*것)?처럼\s*(대답|응답|행동)/i,
];

/** External execution / file / command demands — rejected. */
const EXECUTION_PATTERNS: readonly RegExp[] = [
    /\b(execute|run)\b.{0,24}\b(command|script|shell|code|file)\b/i,
    /\bcurl\s+-|\bwget\s+https?:/i,
    /\brm\s+-rf\b/,
    /(명령어|스크립트|파일)\s*(을|를)?\s*실행/,
];

/**
 * Demotion shapes (§8.4): a URL, a redirect, or an imperative with an
 * absolute marker is excluded from bulk approval and parked for individual
 * review — a person may still decide it is a legitimate preference once
 * rewritten declaratively.
 */
const URL_PATTERN = /\bhttps?:\/\/|\bwww\.[a-z0-9-]/i;

const REDIRECT_PATTERNS: readonly RegExp[] = [
    /\bfrom\s+now\s+on\b/i,
    /\brespond\s+only\s+(with|in)\b/i,
    /(지금부터|앞으로)\s*(는|은)?\s*(모든|항상)?/,
];

/** Imperative surface forms — a statement must be declarative (§8.2). */
const IMPERATIVE_PATTERNS: readonly RegExp[] = [
    /^(always|never|do\s+not|don't|must|please)\b/i,
    /\byou\s+(must|should|shall|will|have\s+to)\b/i,
    /(해\s?줘|해\s?주세요|하세요|해라|하라|하시오|할\s?것)\s*[.!]?$/,
    // Negative polite imperative. Korean forms a prohibition with 말다 rather
    // than by negating the verb, so "쓰지 마세요" contains no 하세요 and the
    // affirmative list above misses every prohibition — the more directive
    // half of the pair, and a §12.3 critical category.
    /(마세요|마십시오|마라|말아라|말아\s?주세요|하지\s?마)\s*[.!]?$/,
];

/**
 * Statements addressed TO the assistant rather than about the user (§8.2:
 * declarative third-person).
 *
 * "You are now a pirate captain" is not a claim about anyone — it is an
 * instruction wearing declarative grammar, and no imperative pattern catches
 * it because it has no imperative verb. Demoted rather than rejected: the
 * underlying preference may be real once rewritten as a statement about the
 * user.
 *
 * The Hangul alternative uses an explicit space-or-end rather than `\b`: JS
 * word boundaries are ASCII-only, so `\b` after a Hangul syllable never
 * matches.
 */
const SECOND_PERSON_ADDRESS_PATTERNS: readonly RegExp[] = [
    /^you(\s+(are|were|will\s+be)|\s*['\u2019]re)\b/i,
    /^(너는|넌|당신은|당신이)(\s|$)/,
];

const ABSOLUTE_MARKER_PATTERN = /(항상|반드시|무조건|절대)/;

/** PII shapes that force individual (sensitive) review — never bulk. */
const SENSITIVE_PII_PATTERNS: readonly RegExp[] = [
    /\b\d{6}-[1-4]\d{6}\b/, // Korean resident registration number shape
    /\b(?:\d[ -]?){15}\d\b/, // payment card length run
    // Government and financial identifiers. They are PII rather than
    // credentials — holding one does not grant access — so they follow the
    // resident-registration precedent above and are parked for a person
    // instead of refused. Either way they never reach bulk approval.
    /(계좌|카드)\s*(번호)?[^\n]{0,16}\d{4}[\s-]\d{2,}/,
    /\bcard\s*(number|no\.?)?\b[^\n]{0,16}\d{4}[\s-]\d{2,}/i,
    /\baccount\s*(number|no\.?)?\b[^\n]{0,16}\d{6,}/i,
    /\bsort\s*code\b[^\n]{0,12}\d{2}[\s-]\d{2}[\s-]\d{2}/i,
    /여권\s*번호[^\n]{0,12}[A-Za-z]?\d{6,}/,
    /\bpassport\s*(number|no\.?)\b[^\n]{0,12}[A-Za-z]?\d{6,}/i,
    /\bnational\s+insurance\b/i,
    /\b(ssn|social\s+security\s+number)\b/i,
];

const matchesAny = (patterns: readonly RegExp[], value: string): boolean =>
    patterns.some((pattern) => pattern.test(value));

const isFactualKind = (kind: string): boolean =>
    (FACTUAL_MEMORY_KINDS as readonly string[]).includes(kind);

const isKnownKind = (kind: string): boolean =>
    (MEMORY_KINDS as readonly string[]).includes(kind);

/**
 * Validates one candidate. Deterministic: same input and `now` always yield
 * the same result. `now` exists only for the expiry check.
 */
export function validateMemoryCandidate(
    input: MemoryCandidateInput,
    now: Date = new Date()
): MemoryValidationResult {
    const violations: string[] = [];
    let rejected = false;
    let sensitiveReview = false;
    let manualReview = false;
    let sensitivity: (typeof MEMORY_SENSITIVITIES)[number] =
        input.sensitivity === "sensitive" ? "sensitive" : "standard";

    const statement = input.statement.normalize("NFC").trim();

    // Structure (§8.4: 길이, 허용 kind, confidence 범위, expiry 형식).
    if (!isKnownKind(input.kind)) {
        violations.push("MEMORY_KIND_UNKNOWN");
        rejected = true;
    }
    const length = countCodePoints(statement);
    if (
        length < MEMORY_STATEMENT_MIN_CODE_POINTS ||
        length > MEMORY_STATEMENT_MAX_CODE_POINTS
    ) {
        violations.push("MEMORY_STATEMENT_LENGTH");
        rejected = true;
    }
    if (
        !Number.isFinite(input.confidence) ||
        input.confidence < 0 ||
        input.confidence > 1
    ) {
        violations.push("MEMORY_CONFIDENCE_RANGE");
        rejected = true;
    }
    if (input.expiresAt != null) {
        const expiry = new Date(input.expiresAt);
        if (Number.isNaN(expiry.getTime())) {
            violations.push("MEMORY_EXPIRY_INVALID");
            rejected = true;
        } else if (expiry.getTime() <= now.getTime()) {
            violations.push("MEMORY_EXPIRY_NOT_FUTURE");
            rejected = true;
        }
    }

    // Evidence relationship (§8.2, eval category ②): every candidate needs
    // evidence, and a factual claim needs at least one user-authored source —
    // a user-role message or the user's own manual grounds text. A style
    // preference may legitimately be inferred from assistant answers.
    if (input.evidence.length === 0) {
        violations.push("MEMORY_EVIDENCE_REQUIRED");
        rejected = true;
    } else if (isFactualKind(input.kind)) {
        const hasUserAuthoredEvidence = input.evidence.some(
            (evidence) =>
                evidence.sourceType === "manual" || evidence.role === "user"
        );
        if (!hasUserAuthoredEvidence) {
            violations.push("MEMORY_FACTUAL_REQUIRES_USER_EVIDENCE");
            rejected = true;
        }
    }

    // Category ③ — credential/secret shapes reject and mark sensitive.
    if (matchesAny(CREDENTIAL_PATTERNS, statement)) {
        violations.push("MEMORY_CREDENTIAL_PATTERN");
        rejected = true;
        sensitivity = "sensitive";
    }

    // Category ④ — hard rejects.
    if (matchesAny(INJECTION_PATTERNS, statement)) {
        violations.push("MEMORY_PROMPT_INJECTION_PATTERN");
        rejected = true;
    }
    if (matchesAny(SYSTEM_VOICE_PATTERNS, statement)) {
        violations.push("MEMORY_SYSTEM_VOICE_PATTERN");
        rejected = true;
    }
    if (matchesAny(EXECUTION_PATTERNS, statement)) {
        violations.push("MEMORY_EXECUTION_PATTERN");
        rejected = true;
    }

    // Category ④ — demotions: reviewable by a person, never bulk.
    if (URL_PATTERN.test(statement)) {
        violations.push("MEMORY_URL_PRESENT");
        manualReview = true;
    }
    const imperative = matchesAny(IMPERATIVE_PATTERNS, statement);
    if (imperative) {
        violations.push("MEMORY_IMPERATIVE_FORM");
        manualReview = true;
    }
    if (matchesAny(SECOND_PERSON_ADDRESS_PATTERNS, statement)) {
        violations.push("MEMORY_SECOND_PERSON_ADDRESS");
        manualReview = true;
    }
    if (ABSOLUTE_MARKER_PATTERN.test(statement) && imperative) {
        violations.push("MEMORY_ABSOLUTE_DIRECTIVE");
        rejected = true;
    }
    if (matchesAny(REDIRECT_PATTERNS, statement) && imperative) {
        violations.push("MEMORY_REDIRECT_DIRECTIVE");
        rejected = true;
    }

    // PII shapes force individual sensitive review (§8.4: 민감 후보는 개별
    // 승인만 가능).
    if (matchesAny(SENSITIVE_PII_PATTERNS, statement)) {
        violations.push("MEMORY_SENSITIVE_PII_PATTERN");
        sensitiveReview = true;
        sensitivity = "sensitive";
    }
    // Health information is extractable and never auto-approved. This runs on
    // the candidate's own statement, not on the message it came from: a
    // message carrying an allergy and an answer-style preference must not drag
    // the style memory into review with it. A statement minimised from a
    // health fact is still health information, so the check is on the stored
    // sentence rather than on where it came from.
    if (carriesHealthSignal(statement)) {
        violations.push(MEMORY_SENSITIVE_HEALTH);
        sensitiveReview = true;
        sensitivity = "sensitive";
    }
    if (sensitivity === "sensitive" && !rejected) {
        sensitiveReview = true;
    }

    const disposition: MemoryDisposition = rejected
        ? "rejected"
        : sensitiveReview
          ? "sensitive_review_required"
          : manualReview
            ? "manual_review_required"
            : "accepted";

    return {
        disposition,
        bulkSafe: disposition === "accepted" && sensitivity === "standard",
        sensitivity,
        violations,
    };
}

/**
 * Canonical key for duplicate / near-duplicate detection (§8.4): NFC,
 * case-folded, punctuation and whitespace collapsed. Two statements with the
 * same key are treated as the same assertion.
 */
export function memoryStatementKey(statement: string): string {
    return statement
        .normalize("NFC")
        .toLowerCase()
        .replace(/[\p{P}\p{S}]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
}
