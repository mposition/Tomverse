/**
 * Why each case left the decision set, and what took its place.
 *
 * `.github/audits/memory-eval-kind-boundary-amendment-2026-08-27.md`
 * (approved 2026-08-27) and its correction
 * `.github/audits/memory-eval-kind-boundary-correction-2026-08-27.md`.
 *
 * A case used to author or approve a rule cannot also measure that rule: it
 * would score the new prompt against its own evidence. run1 exposed 112
 * cases; 99 of them decided a rule or a verdict and move here, and 13 were
 * read without influencing anything and stay.
 *
 * `replacementId` names the decision-set case written to take its place. The
 * separation test reads it as an invariant rather than a record: an original
 * is in exactly one of the two sets, and it has a replacement exactly when it
 * has left the decision set. Both flip together or the check fails, so the
 * corpus cannot half-migrate.
 *
 * All 99 were filled in on 2026-08-27, in the one change that wired
 * `mem-eval-succ-3`. Before that they were null and the same invariant said
 * so — these cases were still in the decision set, and claiming a replacement
 * would have claimed a migration that had not happened.
 */

export type RegressionRuleId =
    | "rule-1"
    | "rule-2"
    | "rule-3"
    | "rule-4"
    | "rule-5"
    /** A gold corrected against a sentence v4 already carried, not a new rule. */
    | "v4-kind-guide";

export type RegressionProvenance = {
    originalId: string;
    /** Which frozen rules this case was used to author or approve. */
    ruleIds: readonly RegressionRuleId[];
    /** Sections of the amendment that adjudicated or quoted it. */
    auditRefs: readonly string[];
    reason: string;
    /**
     * The decision-set case written to take its place.
     *
     * Still `string | null` rather than `string`: the type is what the next
     * migration will need, and narrowing it now would make the null state
     * unrepresentable in a file whose whole point is that both states are
     * checkable.
     */
    replacementId: string | null;
};

export const MEMORY_EVAL_REGRESSION_PROVENANCE: readonly RegressionProvenance[] =
    [
        {
            originalId: "succ-assistant-en-119",
            ruleIds: ["rule-2"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 2의 증거",
            replacementId: "succ-assistant-en-315",
        },
        {
            originalId: "succ-assistant-en-13",
            ruleIds: ["rule-2"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 2의 증거",
            replacementId: "succ-assistant-en-309",
        },
        {
            originalId: "succ-assistant-en-16",
            ruleIds: ["rule-2"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 2의 증거",
            replacementId: "succ-assistant-en-310",
        },
        {
            originalId: "succ-assistant-en-23",
            ruleIds: ["rule-2"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 2의 증거",
            replacementId: "succ-assistant-en-311",
        },
        {
            originalId: "succ-assistant-en-65",
            ruleIds: ["rule-2"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 2의 증거",
            replacementId: "succ-assistant-en-312",
        },
        {
            originalId: "succ-assistant-en-78",
            ruleIds: ["rule-2"],
            auditRefs: ["§2", "§4.2"],
            reason: "규칙 2의 비추출 판정 근거",
            replacementId: "succ-assistant-en-313",
        },
        {
            originalId: "succ-assistant-en-79",
            ruleIds: ["rule-2"],
            auditRefs: ["§2", "§4.1"],
            reason: "규칙 2의 정정 판정 근거",
            replacementId: "succ-assistant-en-301",
        },
        {
            originalId: "succ-assistant-en-8",
            ruleIds: ["rule-2"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 2의 증거",
            replacementId: "succ-assistant-en-308",
        },
        {
            originalId: "succ-assistant-en-80",
            ruleIds: ["rule-2"],
            auditRefs: ["§2", "§4.1"],
            reason: "규칙 2의 정정 판정 근거",
            replacementId: "succ-assistant-en-302",
        },
        {
            originalId: "succ-assistant-en-81",
            ruleIds: ["rule-2"],
            auditRefs: ["§2", "§4.1"],
            reason: "규칙 2의 정정 판정 근거",
            replacementId: "succ-assistant-en-303",
        },
        {
            originalId: "succ-assistant-en-82",
            ruleIds: ["rule-2"],
            auditRefs: ["§2", "§4.1"],
            reason: "규칙 2의 정정 판정 근거",
            replacementId: "succ-assistant-en-304",
        },
        {
            originalId: "succ-assistant-en-83",
            ruleIds: ["rule-2"],
            auditRefs: ["§4.1"],
            reason: "규칙 2의 정정 판정 근거",
            replacementId: "succ-assistant-en-305",
        },
        {
            originalId: "succ-assistant-en-84",
            ruleIds: ["rule-2"],
            auditRefs: ["§2", "§4.1"],
            reason: "규칙 2의 정정 판정 근거",
            replacementId: "succ-assistant-en-306",
        },
        {
            originalId: "succ-assistant-en-85",
            ruleIds: ["rule-2"],
            auditRefs: ["§2", "§4.1"],
            reason: "규칙 2의 정정 판정 근거",
            replacementId: "succ-assistant-en-307",
        },
        {
            originalId: "succ-assistant-en-86",
            ruleIds: ["rule-2"],
            auditRefs: ["§2", "§4.2"],
            reason: "규칙 2의 비추출 판정 근거",
            replacementId: "succ-assistant-en-314",
        },
        {
            originalId: "succ-assistant-ko-106",
            ruleIds: ["rule-2"],
            auditRefs: ["§2", "§4.2"],
            reason: "규칙 2의 비추출 판정 근거",
            replacementId: "succ-assistant-ko-318",
        },
        {
            originalId: "succ-assistant-ko-13",
            ruleIds: ["rule-2"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 2의 증거",
            replacementId: "succ-assistant-ko-310",
        },
        {
            originalId: "succ-assistant-ko-36",
            ruleIds: ["rule-2"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 2의 증거",
            replacementId: "succ-assistant-ko-311",
        },
        {
            originalId: "succ-assistant-ko-47",
            ruleIds: ["rule-2"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 2의 증거",
            replacementId: "succ-assistant-ko-312",
        },
        {
            originalId: "succ-assistant-ko-65",
            ruleIds: ["rule-2"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 2의 증거",
            replacementId: "succ-assistant-ko-313",
        },
        {
            originalId: "succ-assistant-ko-78",
            ruleIds: ["rule-2"],
            auditRefs: ["§2", "§4.2"],
            reason: "규칙 2의 비추출 판정 근거",
            replacementId: "succ-assistant-ko-314",
        },
        {
            originalId: "succ-assistant-ko-79",
            ruleIds: ["rule-2"],
            auditRefs: ["§2", "§4.1"],
            reason: "규칙 2의 정정 판정 근거",
            replacementId: "succ-assistant-ko-301",
        },
        {
            originalId: "succ-assistant-ko-8",
            ruleIds: ["rule-2"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 2의 증거",
            replacementId: "succ-assistant-ko-309",
        },
        {
            originalId: "succ-assistant-ko-80",
            ruleIds: ["rule-2"],
            auditRefs: ["§2", "§4.1"],
            reason: "규칙 2의 정정 판정 근거",
            replacementId: "succ-assistant-ko-302",
        },
        {
            originalId: "succ-assistant-ko-81",
            ruleIds: ["rule-2"],
            auditRefs: ["§2", "§4.1"],
            reason: "규칙 2의 정정 판정 근거",
            replacementId: "succ-assistant-ko-303",
        },
        {
            originalId: "succ-assistant-ko-82",
            ruleIds: ["rule-2"],
            auditRefs: ["§2", "§4.1"],
            reason: "규칙 2의 정정 판정 근거",
            replacementId: "succ-assistant-ko-304",
        },
        {
            originalId: "succ-assistant-ko-83",
            ruleIds: ["rule-2"],
            auditRefs: ["§4.1"],
            reason: "규칙 2의 정정 판정 근거",
            replacementId: "succ-assistant-ko-305",
        },
        {
            originalId: "succ-assistant-ko-84",
            ruleIds: ["rule-2"],
            auditRefs: ["§2", "§4.1"],
            reason: "규칙 2의 정정 판정 근거",
            replacementId: "succ-assistant-ko-306",
        },
        {
            originalId: "succ-assistant-ko-85",
            ruleIds: ["rule-2"],
            auditRefs: ["§2", "§4.1"],
            reason: "규칙 2의 정정 판정 근거",
            replacementId: "succ-assistant-ko-307",
        },
        {
            originalId: "succ-assistant-ko-86",
            ruleIds: ["rule-2"],
            auditRefs: ["§2", "§4.2"],
            reason: "규칙 2의 비추출 판정 근거",
            replacementId: "succ-assistant-ko-315",
        },
        {
            originalId: "succ-assistant-ko-92",
            ruleIds: ["rule-2"],
            auditRefs: ["§2", "§4.1"],
            reason: "규칙 2의 정정 판정 근거",
            replacementId: "succ-assistant-ko-308",
        },
        {
            originalId: "succ-assistant-ko-93",
            ruleIds: ["rule-2"],
            auditRefs: ["§2", "§4.2"],
            reason: "규칙 2의 비추출 판정 근거",
            replacementId: "succ-assistant-ko-316",
        },
        {
            originalId: "succ-assistant-ko-95",
            ruleIds: ["rule-2"],
            auditRefs: ["§2", "§4.2"],
            reason: "규칙 2의 비추출 판정 근거",
            replacementId: "succ-assistant-ko-317",
        },
        {
            originalId: "succ-durable-en-105",
            ruleIds: ["rule-4"],
            auditRefs: ["§5"],
            reason: "규칙 4의 재사용 명제 판정 근거",
            replacementId: "succ-durable-en-301",
        },
        {
            originalId: "succ-durable-en-106",
            ruleIds: ["rule-4"],
            auditRefs: ["§5"],
            reason: "규칙 4의 재사용 명제 판정 근거",
            replacementId: "succ-durable-en-302",
        },
        {
            originalId: "succ-durable-en-133",
            ruleIds: ["rule-3"],
            auditRefs: ["§4.3"],
            reason: "규칙 3의 kind 경계 판정 근거",
            replacementId: "succ-durable-en-303",
        },
        {
            originalId: "succ-durable-en-134",
            ruleIds: ["rule-3"],
            auditRefs: ["§4.3"],
            reason: "규칙 3의 kind 경계 판정 근거",
            replacementId: "succ-durable-en-304",
        },
        {
            originalId: "succ-durable-en-144",
            ruleIds: ["v4-kind-guide"],
            auditRefs: ["§4.4"],
            reason: "v4 KIND_GUIDE의 occupation 정의에 따른 gold 정정 근거",
            replacementId: "succ-durable-en-305",
        },
        {
            originalId: "succ-durable-en-145",
            ruleIds: ["rule-5"],
            auditRefs: ["§6"],
            reason: "규칙 4·5의 경계 판정 근거",
            replacementId: "succ-durable-en-306",
        },
        {
            originalId: "succ-durable-en-156",
            ruleIds: ["rule-4"],
            auditRefs: ["§5"],
            reason: "규칙 4의 재사용 명제 판정 근거",
            replacementId: "succ-durable-en-307",
        },
        {
            originalId: "succ-durable-en-182",
            ruleIds: ["v4-kind-guide"],
            auditRefs: ["§4.4"],
            reason: "v4 KIND_GUIDE의 occupation 정의에 따른 gold 정정 근거",
            replacementId: "succ-durable-en-308",
        },
        {
            originalId: "succ-durable-en-189",
            ruleIds: ["rule-4"],
            auditRefs: ["§5"],
            reason: "규칙 4의 재사용 명제 판정 근거",
            replacementId: "succ-durable-en-309",
        },
        {
            originalId: "succ-durable-en-190",
            ruleIds: ["rule-4"],
            auditRefs: ["§5"],
            reason: "규칙 4의 재사용 명제 판정 근거",
            replacementId: "succ-durable-en-310",
        },
        {
            originalId: "succ-durable-en-28",
            ruleIds: ["rule-3"],
            auditRefs: ["§4.3"],
            reason: "규칙 3의 kind 경계 판정 근거",
            replacementId: "succ-durable-en-311",
        },
        {
            originalId: "succ-durable-en-29",
            ruleIds: ["rule-3"],
            auditRefs: ["§4.3"],
            reason: "규칙 3의 kind 경계 판정 근거",
            replacementId: "succ-durable-en-312",
        },
        {
            originalId: "succ-durable-en-30",
            ruleIds: ["rule-4"],
            auditRefs: ["§6"],
            reason: "규칙 4·5의 경계 판정 근거",
            replacementId: "succ-durable-en-313",
        },
        {
            originalId: "succ-durable-en-41",
            ruleIds: ["v4-kind-guide"],
            auditRefs: ["§4.4"],
            reason: "v4 KIND_GUIDE의 occupation 정의에 따른 gold 정정 근거",
            replacementId: "succ-durable-en-314",
        },
        {
            originalId: "succ-durable-en-56",
            ruleIds: ["rule-4"],
            auditRefs: ["§5"],
            reason: "규칙 4의 재사용 명제 판정 근거",
            replacementId: "succ-durable-en-315",
        },
        {
            originalId: "succ-durable-en-57",
            ruleIds: ["rule-4"],
            auditRefs: ["§5"],
            reason: "규칙 4의 재사용 명제 판정 근거",
            replacementId: "succ-durable-en-316",
        },
        {
            originalId: "succ-durable-en-78",
            ruleIds: ["rule-3"],
            auditRefs: ["§4.3"],
            reason: "규칙 3의 kind 경계 판정 근거",
            replacementId: "succ-durable-en-317",
        },
        {
            originalId: "succ-durable-en-79",
            ruleIds: ["rule-3"],
            auditRefs: ["§4.3"],
            reason: "규칙 3의 kind 경계 판정 근거",
            replacementId: "succ-durable-en-318",
        },
        {
            originalId: "succ-durable-en-83",
            ruleIds: ["rule-3"],
            auditRefs: ["§4.3"],
            reason: "규칙 3의 kind 경계 판정 근거",
            replacementId: "succ-durable-en-319",
        },
        {
            originalId: "succ-durable-en-91",
            ruleIds: ["v4-kind-guide"],
            auditRefs: ["§4.4"],
            reason: "v4 KIND_GUIDE의 occupation 정의에 따른 gold 정정 근거",
            replacementId: "succ-durable-en-320",
        },
        {
            originalId: "succ-durable-ko-105",
            ruleIds: ["rule-4"],
            auditRefs: ["§5"],
            reason: "규칙 4의 재사용 명제 판정 근거",
            replacementId: "succ-durable-ko-301",
        },
        {
            originalId: "succ-durable-ko-106",
            ruleIds: ["rule-4"],
            auditRefs: ["§5"],
            reason: "규칙 4의 재사용 명제 판정 근거",
            replacementId: "succ-durable-ko-302",
        },
        {
            originalId: "succ-durable-ko-107",
            ruleIds: ["rule-4"],
            auditRefs: ["§5"],
            reason: "규칙 4의 재사용 명제 판정 근거",
            replacementId: "succ-durable-ko-303",
        },
        {
            originalId: "succ-durable-ko-116",
            ruleIds: ["rule-3"],
            auditRefs: ["§4.3"],
            reason: "규칙 3의 kind 경계 판정 근거",
            replacementId: "succ-durable-ko-304",
        },
        {
            originalId: "succ-durable-ko-133",
            ruleIds: ["rule-3"],
            auditRefs: ["§4.3"],
            reason: "규칙 3의 kind 경계 판정 근거",
            replacementId: "succ-durable-ko-305",
        },
        {
            originalId: "succ-durable-ko-134",
            ruleIds: ["rule-3"],
            auditRefs: ["§4.3"],
            reason: "규칙 3의 kind 경계 판정 근거",
            replacementId: "succ-durable-ko-306",
        },
        {
            originalId: "succ-durable-ko-145",
            ruleIds: ["rule-5"],
            auditRefs: ["§6"],
            reason: "규칙 4·5의 경계 판정 근거",
            replacementId: "succ-durable-ko-307",
        },
        {
            originalId: "succ-durable-ko-15",
            ruleIds: ["rule-4"],
            auditRefs: ["§3"],
            reason: "규칙 4의 대조 — 사람 없이 반복만 있는 절",
            replacementId: "succ-durable-ko-308",
        },
        {
            originalId: "succ-durable-ko-156",
            ruleIds: ["rule-4"],
            auditRefs: ["§5"],
            reason: "규칙 4의 재사용 명제 판정 근거",
            replacementId: "succ-durable-ko-309",
        },
        {
            originalId: "succ-durable-ko-157",
            ruleIds: ["rule-4"],
            auditRefs: ["§5"],
            reason: "규칙 4의 재사용 명제 판정 근거",
            replacementId: "succ-durable-ko-310",
        },
        {
            originalId: "succ-durable-ko-158",
            ruleIds: ["rule-4"],
            auditRefs: ["§5"],
            reason: "규칙 4의 재사용 명제 판정 근거",
            replacementId: "succ-durable-ko-311",
        },
        {
            originalId: "succ-durable-ko-163",
            ruleIds: ["rule-5"],
            auditRefs: ["§6"],
            reason: "규칙 4·5의 경계 판정 근거",
            replacementId: "succ-durable-ko-312",
        },
        {
            originalId: "succ-durable-ko-175",
            ruleIds: ["rule-3"],
            auditRefs: ["§4.3"],
            reason: "규칙 3의 kind 경계 판정 근거",
            replacementId: "succ-durable-ko-313",
        },
        {
            originalId: "succ-durable-ko-189",
            ruleIds: ["rule-4"],
            auditRefs: ["§5"],
            reason: "규칙 4의 재사용 명제 판정 근거",
            replacementId: "succ-durable-ko-314",
        },
        {
            originalId: "succ-durable-ko-190",
            ruleIds: ["rule-4"],
            auditRefs: ["§5"],
            reason: "규칙 4의 재사용 명제 판정 근거",
            replacementId: "succ-durable-ko-315",
        },
        {
            originalId: "succ-durable-ko-2",
            ruleIds: ["rule-4"],
            auditRefs: ["§3"],
            reason: "규칙 4의 대조 — 사람이 등장하지 않는 절은 후보 둘로 남는다",
            replacementId: "succ-durable-ko-316",
        },
        {
            originalId: "succ-durable-ko-21",
            ruleIds: ["rule-2"],
            auditRefs: ["§3"],
            reason: "규칙 2 세 번째 절의 기준을 '지속 표현'에서 '요청이냐 승인이냐'로 바꾸게 한 케이스",
            replacementId: "succ-durable-ko-317",
        },
        {
            originalId: "succ-durable-ko-23",
            ruleIds: ["rule-4"],
            auditRefs: ["§5"],
            reason: "규칙 4의 재사용 명제 판정 근거",
            replacementId: "succ-durable-ko-318",
        },
        {
            originalId: "succ-durable-ko-28",
            ruleIds: ["rule-3"],
            auditRefs: ["§4.3"],
            reason: "규칙 3의 kind 경계 판정 근거",
            replacementId: "succ-durable-ko-319",
        },
        {
            originalId: "succ-durable-ko-29",
            ruleIds: ["rule-3"],
            auditRefs: ["§4.3"],
            reason: "규칙 3의 kind 경계 판정 근거",
            replacementId: "succ-durable-ko-320",
        },
        {
            originalId: "succ-durable-ko-47",
            ruleIds: ["rule-4"],
            auditRefs: ["§6"],
            reason: "규칙 4·5의 경계 판정 근거",
            replacementId: "succ-durable-ko-321",
        },
        {
            originalId: "succ-durable-ko-59",
            ruleIds: ["rule-4"],
            auditRefs: ["§5"],
            reason: "규칙 4의 재사용 명제 판정 근거",
            replacementId: "succ-durable-ko-322",
        },
        {
            originalId: "succ-durable-ko-61",
            ruleIds: ["rule-4"],
            auditRefs: ["§5"],
            reason: "규칙 4의 재사용 명제 판정 근거",
            replacementId: "succ-durable-ko-323",
        },
        {
            originalId: "succ-durable-ko-62",
            ruleIds: ["rule-4"],
            auditRefs: ["§5"],
            reason: "규칙 4의 재사용 명제 판정 근거",
            replacementId: "succ-durable-ko-324",
        },
        {
            originalId: "succ-durable-ko-76",
            ruleIds: ["rule-3"],
            auditRefs: ["§3"],
            reason: "규칙 3③의 경계 — 더 구체적인 kind가 없어 identity가 남는 쪽",
            replacementId: "succ-durable-ko-325",
        },
        {
            originalId: "succ-durable-ko-78",
            ruleIds: ["rule-3"],
            auditRefs: ["§4.3"],
            reason: "규칙 3의 kind 경계 판정 근거",
            replacementId: "succ-durable-ko-326",
        },
        {
            originalId: "succ-durable-ko-79",
            ruleIds: ["rule-3"],
            auditRefs: ["§4.3"],
            reason: "규칙 3의 kind 경계 판정 근거",
            replacementId: "succ-durable-ko-327",
        },
        {
            originalId: "succ-durable-ko-83",
            ruleIds: ["rule-4"],
            auditRefs: ["§6"],
            reason: "규칙 4·5의 경계 판정 근거",
            replacementId: "succ-durable-ko-328",
        },
        {
            originalId: "succ-durable-ko-99",
            ruleIds: ["rule-4"],
            auditRefs: ["§6"],
            reason: "규칙 4·5의 경계 판정 근거",
            replacementId: "succ-durable-ko-329",
        },
        {
            originalId: "succ-injection-en-23",
            ruleIds: ["rule-1"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 1의 증거",
            replacementId: "succ-injection-en-301",
        },
        {
            originalId: "succ-injection-en-26",
            ruleIds: ["rule-1"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 1의 증거",
            replacementId: "succ-injection-en-302",
        },
        {
            originalId: "succ-injection-en-86",
            ruleIds: ["rule-1"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 1의 증거",
            replacementId: "succ-injection-en-303",
        },
        {
            originalId: "succ-injection-en-87",
            ruleIds: ["rule-1"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 1의 증거",
            replacementId: "succ-injection-en-304",
        },
        {
            originalId: "succ-injection-en-93",
            ruleIds: ["rule-1"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 1의 증거",
            replacementId: "succ-injection-en-305",
        },
        {
            originalId: "succ-injection-ko-1",
            ruleIds: ["rule-1"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 1의 증거",
            replacementId: "succ-injection-ko-301",
        },
        {
            originalId: "succ-injection-ko-125",
            ruleIds: ["rule-1"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 1의 증거",
            replacementId: "succ-injection-ko-308",
        },
        {
            originalId: "succ-injection-ko-2",
            ruleIds: ["rule-1"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 1의 증거",
            replacementId: "succ-injection-ko-302",
        },
        {
            originalId: "succ-injection-ko-23",
            ruleIds: ["rule-1"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 1의 증거",
            replacementId: "succ-injection-ko-304",
        },
        {
            originalId: "succ-injection-ko-26",
            ruleIds: ["rule-1"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 1의 증거",
            replacementId: "succ-injection-ko-305",
        },
        {
            originalId: "succ-injection-ko-3",
            ruleIds: ["rule-1"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 1의 증거",
            replacementId: "succ-injection-ko-303",
        },
        {
            originalId: "succ-injection-ko-87",
            ruleIds: ["rule-1"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 1의 증거",
            replacementId: "succ-injection-ko-306",
        },
        {
            originalId: "succ-injection-ko-95",
            ruleIds: ["rule-1"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 1의 증거",
            replacementId: "succ-injection-ko-307",
        },
        {
            originalId: "succ-secret-en-121",
            ruleIds: ["rule-2"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 2의 증거",
            replacementId: "succ-secret-en-302",
        },
        {
            originalId: "succ-secret-en-91",
            ruleIds: ["rule-2"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 2의 증거",
            replacementId: "succ-secret-en-301",
        },
        {
            originalId: "succ-secret-ko-121",
            ruleIds: ["rule-2"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 2의 증거",
            replacementId: "succ-secret-ko-302",
        },
        {
            originalId: "succ-secret-ko-91",
            ruleIds: ["rule-2"],
            auditRefs: ["§2"],
            reason: "run1 critical bulk-safe 채택 — 규칙 2의 증거",
            replacementId: "succ-secret-ko-301",
        },
    ];
