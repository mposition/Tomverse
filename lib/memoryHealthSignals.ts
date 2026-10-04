/**
 * Deterministic health signals for the memory validator.
 *
 * docs/policy/external-conversation-import-and-memory.md §8.4, and the
 * sensitivity contract in
 * `.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md` §3.2
 * (approved 2026-08-25).
 *
 * ## What this is for
 *
 * Health information is extractable and must never be auto-approved. The
 * model reports its own `sensitivity`, and the validator may raise that but
 * never lower it — so this registry is the half that does not depend on the
 * model getting it right.
 *
 * ## Why a registry rather than a word list in the policy
 *
 * The policy states the semantic scope — allergies and intolerances,
 * diagnoses and conditions, medication and treatment, mental health,
 * pregnancy and reproductive health — and stops there. Vocabulary lives here,
 * so widening it is an ordinary change rather than a policy amendment.
 *
 * Two rules make that safe:
 *
 *   * **Patterns are contextual, not single words.** `진단` appears in "정적
 *     진단 도구", and `intolerant` appears in "intolerant of vague answers".
 *     A bare keyword would mark ordinary memories sensitive, and the cost of
 *     that is not zero — it lands on bulk eligibility recall, which the
 *     amendment added precisely to stop over-blocking from looking free.
 *   * **Every entry ships negatives.** A pattern with no counterexample is a
 *     pattern nobody has tested in the direction that hurts, and
 *     `tests/memoryHealthSignals.test.mjs` asserts both directions for every
 *     entry in this file.
 *
 * ## What it does not do
 *
 * It reads the candidate's normalised `statement`, never the quoted message.
 * A message that mentions an allergy and an answer-style preference in one
 * breath must not drag the style memory into review with it.
 *
 * It also does not decide anything on its own: a match raises the candidate
 * to `sensitive`, which routes it to individual review. Nothing here rejects.
 *
 * ## One over-match, kept on purpose
 *
 * "The user says they are allergic to long meetings" is raised to sensitive.
 * The metaphor and the diagnosis share their whole vocabulary, and no pattern
 * separates them — so this errs toward review, and the cost is a little bulk
 * eligibility recall rather than an allergy auto-approved. The shape is
 * recorded in `lib/memoryValidatorProbeCorpus.ts`'s `NEEDS_JUDGEMENT`, which
 * is where the amendment puts what rules cannot decide; a person or the eval
 * settles it, not a regex.
 */

/** The semantic scopes the policy names. Used for reporting, not for logic. */
export const HEALTH_SIGNAL_SCOPES = [
    "allergy_intolerance",
    "diagnosis_condition",
    "medication_treatment",
    "mental_health",
    "reproductive_health",
] as const;

export type HealthSignalScope = (typeof HEALTH_SIGNAL_SCOPES)[number];

export type HealthSignal = {
    id: string;
    scope: HealthSignalScope;
    pattern: RegExp;
    /** Statements this must catch. */
    positives: readonly string[];
    /** Statements this must NOT catch, and which must stay bulk-safe. */
    negatives: readonly string[];
};

/**
 * The stable reason code a raise records. Named rather than assembled, so a
 * log query written today keeps working when the vocabulary changes.
 */
export const MEMORY_SENSITIVE_HEALTH = "MEMORY_SENSITIVE_HEALTH";

export const HEALTH_SIGNALS: readonly HealthSignal[] = [
    {
        id: "ko-allergy",
        scope: "allergy_intolerance",
        pattern: /알레르기|알러지/,
        positives: [
            "사용자는 갑각류 알레르기가 있다.",
            "사용자는 견과류 알러지가 심하다.",
        ],
        negatives: [
            "사용자는 매운 음식을 좋아한다.",
            "사용자는 향이 강한 커피를 선호한다.",
        ],
    },
    {
        id: "en-allergy",
        scope: "allergy_intolerance",
        pattern: /\ballerg(?:y|ies|ic)\b[^\n]{0,24}\b(?:to|reaction)\b|\banaphyla/i,
        positives: [
            "The user is allergic to penicillin.",
            "The user has a severe allergy to shellfish.",
            "The user carries an adrenaline pen for anaphylaxis.",
        ],
        negatives: [
            "The user prefers unscented products.",
            "The user reacted well to the new onboarding flow.",
        ],
    },
    {
        id: "intolerance",
        scope: "allergy_intolerance",
        pattern:
            /(?:락토스|유당|글루텐|밀가루|과당)[^\n]{0,8}불내증|\b(?:lactose|gluten|dairy|fructose|food)[- ]?intoleran(?:t|ce)\b/i,
        positives: [
            "사용자는 유당 불내증이 있다.",
            "The user is lactose intolerant.",
        ],
        negatives: [
            // `intolerant` on its own is a common figure of speech.
            "The user is intolerant of vague answers.",
            "사용자는 모호한 답변을 싫어한다.",
        ],
    },
    {
        id: "ko-diagnosis",
        scope: "diagnosis_condition",
        pattern: /진단[^\n]{0,4}받|(?:지병|기저질환|장애)(?:이|가|을|를|은|는)?\s|증후군/,
        positives: [
            "사용자는 손목 터널 증후군 진단을 받았다.",
            "사용자는 기저질환이 있어 무리한 일정을 피한다.",
        ],
        negatives: [
            // `진단` is ordinary engineering vocabulary.
            "사용자는 정적 진단 도구를 쓴다.",
            "사용자는 성능 진단 보고서를 매주 읽는다.",
        ],
    },
    {
        id: "en-diagnosis",
        scope: "diagnosis_condition",
        pattern:
            /\bdiagnos(?:ed|is)\b[^\n]{0,16}\b(?:with|of)\b|\b(?:diabetes|dementia|asthma|epilepsy|coeliac|celiac|migraines?)\b/i,
        positives: [
            "The user's father was diagnosed with dementia.",
            "The user gets migraines from long screen sessions.",
        ],
        negatives: [
            "The user runs a diagnostics tool before every deploy.",
            "The user reads the build diagnosis output first.",
        ],
    },
    {
        id: "ko-condition-named",
        scope: "diagnosis_condition",
        pattern: /당뇨|치매|천식|뇌전증|자폐|난청|색약|편두통/,
        positives: ["사용자의 아버지는 당뇨가 있다.", "사용자는 편두통이 잦다."],
        negatives: [
            "사용자는 당근을 즐겨 먹는다.",
            "사용자는 색상 대비를 높인 화면을 쓴다.",
        ],
    },
    {
        id: "ko-treatment",
        scope: "medication_treatment",
        pattern: /복용(?:하|중|을)|처방[^\n]{0,4}받|수술[^\n]{0,6}(?:받|후|이후)|정기검진|물리치료를/,
        positives: [
            "사용자는 혈압약을 복용하고 있다.",
            "사용자는 허리 수술 이후 무거운 것을 들지 못한다.",
            "사용자는 매년 3월에 정기검진을 받는다.",
        ],
        negatives: [
            "사용자는 수술적 리팩터링을 선호한다.",
            "사용자는 처방전 번역 업무를 한다.",
        ],
    },
    {
        id: "en-treatment",
        scope: "medication_treatment",
        pattern:
            /\b(?:medication|prescribed|prescription|chemotherapy|dialysis|physiotherapy)\b|\bsurgery\b|\bcheck-?ups?\b[^\n]{0,16}\b(?:annual|yearly|medical)\b|\b(?:annual|yearly|medical)\b[^\n]{0,16}\bcheck-?ups?\b/i,
        positives: [
            "The user cannot lift heavy things since their back surgery.",
            "The user has annual medical check-ups every March.",
        ],
        negatives: [
            "The user runs a code check-up before each release.",
            "The user works as a medical device technical writer.",
        ],
    },
    {
        id: "mental-health",
        scope: "mental_health",
        pattern:
            /우울증|불안장애|공황|공포증|외상후|\b(?:depression|anxiety disorder|panic attacks?|phobia|ptsd|adhd)\b/i,
        positives: [
            "사용자는 고소공포증이 심해 높은 곳을 피한다.",
            "The user has a phobia of heights.",
        ],
        negatives: [
            "사용자는 발표 전에 긴장하는 편이다.",
            "The user finds public speaking stressful.",
        ],
    },
    {
        id: "reproductive-health",
        scope: "reproductive_health",
        pattern: /임신\s*(?:중|했|이|을)|난임|시험관|\b(?:pregnan(?:t|cy)|fertility treatment|ivf)\b/i,
        positives: ["사용자는 임신 중이다.", "The user is pregnant."],
        negatives: [
            "사용자는 임신부용 제품을 만드는 회사에 다닌다.",
            "The user works for a company that makes prenatal products.",
        ],
    },
];

const normalize = (value: string): string =>
    value.normalize("NFC").replace(/\s+/g, " ").trim();

/**
 * Which health scopes this statement carries, if any.
 *
 * Returns the scopes rather than a boolean so a raise can say what kind of
 * signal it saw without the caller re-running the patterns.
 */
export function healthSignalScopes(statement: string): HealthSignalScope[] {
    const value = normalize(statement);
    const scopes = new Set<HealthSignalScope>();
    for (const signal of HEALTH_SIGNALS) {
        if (signal.pattern.test(value)) scopes.add(signal.scope);
    }
    return [...scopes];
}

/** Whether this statement must be raised to `sensitive`. */
export function carriesHealthSignal(statement: string): boolean {
    return healthSignalScopes(statement).length > 0;
}
