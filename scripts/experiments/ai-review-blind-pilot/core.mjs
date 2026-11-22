// Blind answer-comparison pilot: does a reviewer find the contradictions that
// are really there, judged by people who do not know which product wrote it?
//
// Usage and file formats: scripts/experiments/ai-review-blind-pilot/README.md.
//
// This is a small offline pilot for product learning. It is NOT the M5 eval:
// it reads no M5 register, threshold or budget, writes no ledger line, calls no
// provider, and nothing here may be read as an M5 approval or promotion input.
//
// Reused rather than re-implemented:
//   * quote grounding -- `verifyComparisonReviewResult()`, the product's own
//     check (NFKC, quotes, whitespace, case), so "the quote is in the answer"
//     means the same thing here as on the product screen;
//   * the missing-point kind -- `scoreJudgedCase()` (judged-v3): target answer +
//     requirement + `missing`, gold completeness, duplicates, gold gaps;
//   * content digests -- `observationRefFor()`.
// A contradiction is a SYMMETRIC pair of incompatible propositions, which
// judged-v3 has no field for; it is not stored as `missing`. It is counted by
// `scorePlantedKind()` below under the same rules judged-v3 applies (precision
// only on complete gold, a repeat is a duplicate, an unruled or gap finding on a
// complete gold refuses the case).

import { createHash } from "node:crypto";

import { verifyComparisonReviewResult } from "../../../lib/comparisonReview.ts";
import {
    AI_REVIEW_SCORING_CONTRACT_VERSION,
    observationRefFor,
    scoreJudgedCase,
} from "../../../lib/aiReviewEvalJudgement.ts";

export const SCHEMA = {
    plan: "ai-review-blind-pilot-plan/1",
    cases: "ai-review-blind-pilot-cases/1",
    gold: "ai-review-blind-pilot-gold/1",
    output: "ai-review-blind-pilot-output/1",
    freeze: "ai-review-blind-pilot-freeze/1",
    key: "ai-review-blind-pilot-key/1",
    record: "ai-review-blind-pilot-judgement/1",
    adjudication: "ai-review-blind-pilot-adjudication/1",
    report: "ai-review-blind-pilot-report/1",
};

export const DOCUMENT_EXPOSURES = ["shown_in_question", "hidden"];
export const OUTPUT_SOURCES = ["synthetic_mock", "real_capture"];
export const OUTPUT_FORMATS = ["structured", "free_text", "observation_only"];
/** What a judge may say a submitted item is. Only the first three are scored. */
export const ROW_KINDS = [
    "contradiction",
    "missing",
    "document_error",
    "agreement",
    "difference",
    "not_a_finding",
    "other",
];
export const SCORED_KINDS = ["contradiction", "missing", "document_error"];
export const SUPPORT_VALUES = ["supports", "does_not_support", "undeterminable"];
export const VERDICTS = ["matched", "false_finding", "gold_gap", "undetermined"];
const GOLD_KIND = {
    contradiction: "contradictions",
    missing: "missing",
    document_error: "jointDocumentErrors",
};
const COMPLETENESS_KIND = {
    contradiction: "contradiction",
    missing: "missing",
    document_error: "jointDocumentError",
};
const REDACTION = "[가림]";

export class PilotInputError extends Error {
    constructor(problems) {
        super(`입력 검증 실패:\n  - ${problems.join("\n  - ")}`);
        this.problems = problems;
    }
}

export const digestOf = (value) => observationRefFor(value);
const shortDigest = (value) => digestOf(value).slice(7, 19);
const isText = (value) => typeof value === "string" && value.trim() !== "";
const isTime = (value) => isText(value) && !Number.isNaN(Date.parse(value));

/** The product's own normalised containment check, for any (needle, haystack). */
export function appearsIn(needle, haystack) {
    if (!isText(needle) || typeof haystack !== "string") return false;
    const result = verifyComparisonReviewResult(
        {
            consensus: [],
            differences: [],
            contradictions: [{ text: "-", citations: [{ responseId: "A", quote: needle }] }],
            missingPoints: [],
            verificationNeeded: [],
            modelAssessments: [],
            synthesis: "",
            limitations: [],
        },
        { A: haystack }
    );
    return result.contradictions[0].citations[0].verified;
}

/** Deterministic order from a seed; same rule as the M5 blind sheet. */
export const seededOrder = (ids, seed) =>
    [...ids]
        .map((id) => ({ id, key: createHash("sha256").update(`${seed}:${id}`).digest("hex") }))
        .sort((left, right) => left.key.localeCompare(right.key))
        .map((item) => item.id);

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function validatePlan(plan) {
    const p = [];
    if (plan?.schema !== SCHEMA.plan) p.push(`plan.schema는 ${SCHEMA.plan}이어야 합니다`);
    if (!isText(plan?.pilotId)) p.push("plan.pilotId가 없습니다");
    if (!Number.isInteger(plan?.seed)) p.push("plan.seed는 정수여야 합니다");
    if (![1, 2].includes(plan?.judges)) p.push("plan.judges는 1 또는 2입니다");
    if (!DOCUMENT_EXPOSURES.includes(plan?.documentExposure)) {
        p.push(`plan.documentExposure는 ${DOCUMENT_EXPOSURES.join("|")} 중 하나입니다`);
    }
    const slots = (plan?.products ?? []).map((product) => product?.slot);
    if (slots.length < 1 || slots.length > 2) p.push("plan.products는 1~2개입니다");
    if (new Set(slots).size !== slots.length || !slots.every((slot) => /^[A-Z]$/.test(slot ?? ""))) {
        p.push("plan.products[].slot은 서로 다른 대문자 한 글자(X, Y 등)입니다");
    }
    return p;
}

function validateCases(doc) {
    const p = [];
    if (doc?.schema !== SCHEMA.cases) p.push(`cases.schema는 ${SCHEMA.cases}이어야 합니다`);
    const cases = Array.isArray(doc?.cases) ? doc.cases : [];
    if (cases.length === 0) p.push("cases.cases가 비었습니다");
    const ids = new Set();
    for (const testCase of cases) {
        const at = `사례 ${testCase?.caseId ?? "(id 없음)"}`;
        if (!isText(testCase?.caseId) || ids.has(testCase.caseId)) p.push(`${at}: caseId가 비었거나 중복입니다`);
        ids.add(testCase?.caseId);
        if (!["ko", "en"].includes(testCase?.language)) p.push(`${at}: language는 ko|en입니다`);
        for (const field of ["familyId", "variantId", "translationPairId", "question"]) {
            if (!isText(testCase?.[field])) p.push(`${at}: ${field}가 없습니다`);
        }
        const clauses = testCase?.document?.clauses;
        if (!isText(testCase?.document?.version)) p.push(`${at}: document.version이 없습니다`);
        if (!Array.isArray(clauses) || clauses.length === 0 || !clauses.every((c) => isText(c?.id) && isText(c?.text))) {
            p.push(`${at}: document.clauses[]에 id와 text가 필요합니다`);
        }
        const answers = testCase?.answers;
        if (
            !Array.isArray(answers) ||
            answers.length < 2 ||
            answers.length > 3 ||
            !answers.every((a) => isText(a?.id) && isText(a?.content)) ||
            new Set(answers.map((a) => a.id)).size !== answers.length
        ) {
            p.push(`${at}: answers는 id가 서로 다른 2~3개 고정 답변입니다`);
        }
    }
    const byPair = new Map();
    for (const testCase of cases) {
        byPair.set(testCase?.translationPairId, [...(byPair.get(testCase?.translationPairId) ?? []), testCase]);
    }
    for (const [pairId, members] of byPair) {
        const languages = members.map((member) => member.language).sort().join(",");
        if (languages !== "en,ko" || members[0].familyId !== members[1].familyId || members[0].variantId !== members[1].variantId) {
            p.push(`번역쌍 ${pairId}: 같은 과제군·변형의 ko 1개와 en 1개여야 합니다`);
        }
    }
    return p;
}

function validateGold(gold, casesDoc) {
    const p = [];
    if (gold?.schema !== SCHEMA.gold) p.push(`gold.schema는 ${SCHEMA.gold}이어야 합니다`);
    const status = gold?.review?.status;
    if (!["candidate", "human_reviewed"].includes(status)) {
        p.push("gold.review.status는 candidate|human_reviewed입니다");
    } else if (status === "human_reviewed" && (!isText(gold.review.reviewedBy) || !isTime(gold.review.reviewedAt))) {
        p.push("human_reviewed gold에는 사람이 적은 reviewedBy와 reviewedAt이 필요합니다");
    }
    const cases = casesDoc?.cases ?? [];
    const byId = new Map(cases.map((testCase) => [testCase.caseId, testCase]));
    const seen = new Map();
    for (const caseId of Object.keys(gold?.cases ?? {})) {
        if (!byId.has(caseId)) p.push(`gold에 사례 목록에 없는 ${caseId}가 있습니다`);
    }
    for (const testCase of cases) {
        const entry = gold?.cases?.[testCase.caseId];
        const at = `gold ${testCase.caseId}`;
        if (!entry) {
            p.push(`${at}: 항목이 없습니다`);
            continue;
        }
        const answerIds = new Set(testCase.answers.map((a) => a.id));
        const clauseIds = new Set(testCase.document.clauses.map((c) => c.id));
        const answerText = (id) => testCase.answers.find((a) => a.id === id)?.content;
        for (const kind of Object.values(COMPLETENESS_KIND)) {
            if (typeof entry.completeness?.[kind] !== "boolean") p.push(`${at}: completeness.${kind}가 boolean이 아닙니다`);
        }
        for (const [rowKind, field] of Object.entries(GOLD_KIND)) {
            const items = entry[field];
            if (!Array.isArray(items)) {
                p.push(`${at}: ${field} 배열이 없습니다`);
                continue;
            }
            for (const item of items) {
                const where = `${at}/${item?.goldId ?? "(goldId 없음)"}`;
                if (!isText(item?.goldId) || seen.has(item.goldId)) p.push(`${where}: goldId가 비었거나 중복입니다`);
                seen.set(item?.goldId, { caseId: testCase.caseId, rowKind, item });
                if (!clauseIds.has(item?.clauseRef)) p.push(`${where}: 원문 절 ${item?.clauseRef}이 없습니다`);
                if (!isText(item?.rationale)) p.push(`${where}: 판정 근거(rationale)가 없습니다`);
                if (!isText(item?.counterpartGoldId)) p.push(`${where}: 언어 대응(counterpartGoldId)이 없습니다`);
                const spans = Object.entries(item?.answerSpans ?? {});
                for (const [answerId, span] of spans) {
                    if (!answerIds.has(answerId)) p.push(`${where}: 답변 ${answerId}이 없습니다`);
                    else if (!appearsIn(span, answerText(answerId))) p.push(`${where}: 답변 ${answerId} 구간 "${span}"이 원답변에 없습니다`);
                }
                if (rowKind === "contradiction") {
                    if (!isText(item?.subject) || !isText(item?.condition)) p.push(`${where}: subject와 condition이 필요합니다`);
                    if (spans.length < 2) p.push(`${where}: 모순은 두 답변의 구간이 필요합니다`);
                }
                if (rowKind === "missing") {
                    if (!answerIds.has(item?.targetAnswer)) p.push(`${where}: targetAnswer가 답변 id가 아닙니다`);
                    if (!isText(item?.requirementId) || !isText(item?.requirement)) p.push(`${where}: requirementId와 requirement가 필요합니다`);
                }
                if (rowKind === "document_error") {
                    if (!isText(item?.documentValue)) p.push(`${where}: documentValue가 필요합니다`);
                    if (spans.length !== answerIds.size) p.push(`${where}: 공동 오류는 모든 답변의 구간이 필요합니다`);
                }
            }
        }
    }
    const pairOf = new Map();
    for (const testCase of cases) {
        const twin = cases.find((other) => other !== testCase && other.translationPairId === testCase.translationPairId);
        pairOf.set(testCase.caseId, twin?.caseId);
    }
    for (const [goldId, { caseId, rowKind, item }] of seen) {
        const counterpart = seen.get(item?.counterpartGoldId);
        if (!counterpart) continue;
        if (counterpart.caseId !== pairOf.get(caseId) || counterpart.rowKind !== rowKind || counterpart.item.counterpartGoldId !== goldId) {
            p.push(`gold ${goldId}: 언어 대응 ${item.counterpartGoldId}이 번역쌍의 같은 종류 항목이 아니거나 서로 가리키지 않습니다`);
        }
    }
    for (const [goldId, { item }] of seen) {
        if (isText(item?.counterpartGoldId) && !seen.has(item.counterpartGoldId)) p.push(`gold ${goldId}: 언어 대응 ${item.counterpartGoldId}이 없습니다`);
    }
    return p;
}

function validateOutput(out, slot, casesDoc) {
    const p = [];
    const at = `제품 ${slot} 출력`;
    if (out?.schema !== SCHEMA.output) p.push(`${at}: schema는 ${SCHEMA.output}이어야 합니다`);
    if (!isText(out?.productName)) p.push(`${at}: productName이 없습니다`);
    for (const field of ["aliases", "modelIds"]) {
        if (!Array.isArray(out?.[field]) || !out[field].every(isText)) p.push(`${at}: ${field}는 문자열 배열입니다`);
    }
    if (!OUTPUT_SOURCES.includes(out?.source)) p.push(`${at}: source는 ${OUTPUT_SOURCES.join("|")}입니다`);
    if (!isText(out?.captureMethod) || !isTime(out?.capturedAt)) p.push(`${at}: captureMethod와 capturedAt이 필요합니다`);
    if (typeof out?.conditions?.fixedAnswersAccepted !== "boolean") p.push(`${at}: conditions.fixedAnswersAccepted가 boolean이 아닙니다`);
    if (!DOCUMENT_EXPOSURES.includes(out?.conditions?.documentExposure)) p.push(`${at}: conditions.documentExposure가 없습니다`);
    const byId = new Map((casesDoc?.cases ?? []).map((testCase) => [testCase.caseId, testCase]));
    const seen = new Set();
    for (const item of Array.isArray(out?.items) ? out.items : []) {
        const where = `${at} ${item?.caseId}`;
        const testCase = byId.get(item?.caseId);
        if (!testCase || seen.has(item.caseId)) {
            p.push(`${where}: 알 수 없거나 중복된 caseId입니다`);
            continue;
        }
        seen.add(item.caseId);
        if (item.status === "failed") {
            if (!isText(item.failureReason)) p.push(`${where}: 실패 항목에는 failureReason이 필요합니다`);
            continue;
        }
        if (item.status !== "ok") {
            p.push(`${where}: status는 ok|failed입니다 (미수집은 항목을 빼면 됩니다)`);
            continue;
        }
        if (!OUTPUT_FORMATS.includes(item.format)) p.push(`${where}: format은 ${OUTPUT_FORMATS.join("|")}입니다`);
        const answerIds = testCase.answers.map((a) => a.id);
        if (item.displayMap !== null) {
            const entries = Object.entries(item.displayMap ?? {});
            const values = entries.map(([, value]) => value);
            if (
                entries.length !== answerIds.length ||
                !entries.every(([label, value]) => /^[A-C]$/.test(label) && answerIds.includes(value)) ||
                new Set(values).size !== values.length
            ) {
                p.push(`${where}: displayMap은 표시 라벨(A/B/C)→원답변 id의 일대일 대응이거나 null(대응 정보 없음)입니다`);
            }
        }
        if (!Array.isArray(item.findings)) {
            p.push(`${where}: findings 배열이 없습니다 (발견이 없으면 빈 배열)`);
            continue;
        }
        if (item.format === "free_text" && !isText(item.rawText)) p.push(`${where}: free_text에는 rawText가 필요합니다`);
        if (item.format === "observation_only" && (!Number.isInteger(item.totalQuotes) || !Number.isInteger(item.matchedQuotes))) {
            p.push(`${where}: observation_only에는 totalQuotes와 matchedQuotes 합계가 필요합니다`);
        }
        for (const [index, finding] of item.findings.entries()) {
            const f = `${where} findings[${index}]`;
            if (!isText(finding?.field) || !isText(finding?.text) || !Array.isArray(finding?.citations)) {
                p.push(`${f}: field, text, citations[]가 필요합니다`);
                continue;
            }
            if (item.format === "observation_only" && finding.citations.length > 0) {
                p.push(`${f}: observation_only는 인용별 출처가 없으므로 citations를 적을 수 없습니다`);
            }
            if (item.format === "free_text" && !appearsIn(finding.text, item.rawText)) {
                p.push(`${f}: free_text 발견은 rawText의 원문 구간이어야 합니다 (고쳐 쓰지 않습니다)`);
            }
            for (const citation of finding.citations) {
                if (!/^[A-C]$/.test(citation?.displayLabel ?? "") || !isText(citation?.quote)) {
                    p.push(`${f}: citation에는 displayLabel(A/B/C)과 quote가 필요합니다`);
                } else if (item.displayMap && !(citation.displayLabel in item.displayMap)) {
                    p.push(`${f}: 인용 라벨 ${citation.displayLabel}이 displayMap에 없습니다`);
                } else if (item.format === "free_text" && !appearsIn(citation.quote, item.rawText)) {
                    p.push(`${f}: free_text 인용은 rawText에 있어야 합니다`);
                }
            }
        }
    }
    return p;
}

// ---------------------------------------------------------------------------
// Freeze and prepare
// ---------------------------------------------------------------------------

/** Pins the cases and gold before any output is imported. */
export function freezeInputs(bundle, frozenAt) {
    const problems = [...validateCases(bundle.cases), ...validateGold(bundle.gold, bundle.cases)];
    if (problems.length) throw new PilotInputError(problems);
    return {
        schema: SCHEMA.freeze,
        casesDigest: digestOf(bundle.cases),
        goldDigest: digestOf(bundle.gold),
        goldReviewStatus: bundle.gold.review.status,
        frozenAt,
    };
}

/** Every identifier, name or signature that must not reach a judge. */
function forbiddenTerms(bundle) {
    const terms = new Set([bundle.plan.pilotId, ...(bundle.plan.forbiddenTerms ?? [])]);
    for (const testCase of bundle.cases.cases) {
        terms.add(testCase.caseId);
        terms.add(testCase.translationPairId);
        terms.add(testCase.familyId);
    }
    for (const entry of Object.values(bundle.gold.cases)) {
        for (const field of Object.values(GOLD_KIND)) {
            for (const item of entry[field]) {
                terms.add(item.goldId);
                if (item.requirementId) terms.add(item.requirementId);
            }
        }
    }
    for (const product of bundle.plan.products) {
        const out = bundle.outputs[product.slot];
        if (!out) continue;
        for (const term of [out.productName, ...out.aliases, ...out.modelIds]) terms.add(term);
        if (product.output) terms.add(product.output.split(/[\\/]/).pop());
    }
    for (const file of [bundle.plan.cases, bundle.plan.gold]) if (file) terms.add(file.split(/[\\/]/).pop());
    return [...terms].filter((term) => isText(term) && term.trim().length >= 3);
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function redact(text, terms, log) {
    let result = text;
    for (const term of terms) {
        if (!appearsIn(term, result)) continue;
        const pattern = new RegExp(escapeRegExp(term), "gi");
        const count = (result.match(pattern) ?? []).length;
        result = result.replace(pattern, REDACTION);
        if (count === 0 || appearsIn(term, result)) return null; // normalisation-only match: cannot hide it by display substitution
        log.set(term, (log.get(term) ?? 0) + count);
    }
    return result;
}

/**
 * The judge-facing form of one output, or why it cannot be blinded.
 * Quotes are never edited: a quote that names the source makes the output
 * "blinding impossible" rather than a quote nobody wrote.
 */
function anonymizeOutput(item, testCase, terms) {
    for (const finding of item.findings) {
        for (const citation of finding.citations) {
            const leaked = terms.find((term) => appearsIn(term, citation.quote));
            if (leaked) return { ok: false, reason: "인용 원문에 출처 식별 정보가 있어 인용을 고치지 않고는 가릴 수 없습니다" };
        }
    }
    const log = new Map();
    const rawText = item.format === "free_text" ? redact(item.rawText, terms, log) : null;
    if (item.format === "free_text" && rawText === null) return { ok: false, reason: "원문 표기를 표시용 치환으로 가릴 수 없습니다" };
    const answerContent = (displayLabel) => {
        const answerId = item.displayMap?.[displayLabel];
        return answerId ? testCase.answers.find((a) => a.id === answerId)?.content : undefined;
    };
    const segments = [];
    for (const [index, finding] of item.findings.entries()) {
        const text = redact(finding.text, terms, log);
        if (text === null) return { ok: false, reason: "발견 문장을 표시용 치환으로 가릴 수 없습니다" };
        segments.push({
            id: `F${index + 1}`,
            field: finding.field,
            text,
            citations: finding.citations.map((citation) => ({
                displayLabel: citation.displayLabel,
                mappedAnswer: item.displayMap?.[citation.displayLabel] ?? null,
                quote: citation.quote,
                // (a) Mechanical: is the quote in the answer the OUTPUT named,
                // through the run's own display map -- never through array order.
                match:
                    item.format === "observation_only"
                        ? "not_checkable"
                        : item.displayMap === null
                          ? "not_checkable"
                          : appearsIn(citation.quote, answerContent(citation.displayLabel))
                            ? "matched"
                            : "not_matched",
            })),
        });
    }
    return {
        ok: true,
        presented: {
            format: item.format,
            displayMap: item.displayMap,
            rawText,
            aggregateQuotes:
                item.format === "observation_only" ? { total: item.totalQuotes, matched: item.matchedQuotes } : null,
            segments,
        },
        redactions: [...log].map(([term, count]) => ({ termDigest: shortDigest(term), count })),
    };
}

const caseDigestOf = (testCase) =>
    digestOf({
        caseId: testCase.caseId,
        document: testCase.document,
        question: testCase.question,
        answers: testCase.answers,
    });

/**
 * Builds the judge packets, blank records and operator key. Pure: the report
 * calls it again on the current files, so a change to any input changes the
 * bindings the records were made against.
 */
export function prepare(bundle, freeze) {
    const outputsPresent = bundle.plan?.products?.filter((product) => bundle.outputs?.[product.slot]) ?? [];
    const problems = [
        ...validatePlan(bundle.plan),
        ...validateCases(bundle.cases),
        ...validateGold(bundle.gold, bundle.cases),
        ...outputsPresent.flatMap((product) => validateOutput(bundle.outputs[product.slot], product.slot, bundle.cases)),
    ];
    if (!freeze) {
        problems.push("정답표가 고정되지 않았습니다. 출력을 수입하기 전에 freeze를 실행하세요");
    } else {
        if (freeze.schema !== SCHEMA.freeze) problems.push("freeze 파일 형식이 다릅니다");
        if (freeze.casesDigest !== digestOf(bundle.cases)) problems.push("사례(원문·질문·답변)가 고정 이후 바뀌었습니다. 이전 판정은 재사용할 수 없습니다");
        if (freeze.goldDigest !== digestOf(bundle.gold)) problems.push("정답표가 고정 이후 바뀌었습니다. 새로 고정하고 모든 출력을 다시 판정해야 합니다");
    }
    if (problems.length) throw new PilotInputError(problems);

    const terms = forbiddenTerms(bundle);
    const leaks = [];
    for (const testCase of bundle.cases.cases) {
        const texts = [testCase.question, ...testCase.document.clauses.map((c) => `${c.id} ${c.text}`), ...testCase.answers.map((a) => a.content)];
        for (const term of terms) {
            if (texts.some((text) => appearsIn(term, text))) leaks.push(`사례 입력(문서·질문·답변)에 식별 정보가 있습니다: ${testCase.caseId} (${shortDigest(term)})`);
        }
    }
    if (leaks.length) throw new PilotInputError(leaks);

    const { plan } = bundle;
    const order = seededOrder(bundle.cases.cases.map((testCase) => testCase.caseId), plan.seed);
    const caseById = new Map(bundle.cases.cases.map((testCase) => [testCase.caseId, testCase]));
    const products = plan.products.map((product) => {
        const out = bundle.outputs[product.slot];
        const category = !out
            ? "absent"
            : !out.conditions.fixedAnswersAccepted
              ? "full_product_experience"
              : out.conditions.documentExposure !== plan.documentExposure
                ? "condition_mismatch"
                : "fixed_answer";
        return {
            slot: product.slot,
            productName: out?.productName ?? null,
            source: out?.source ?? null,
            captureMethod: out?.captureMethod ?? null,
            capturedAt: out?.capturedAt ?? null,
            conditions: out?.conditions ?? null,
            category,
        };
    });

    const usedIds = new Set();
    const outputIdFor = (caseId, slot) => {
        for (let length = 6; ; length += 2) {
            const id = `O-${createHash("sha256").update(`${plan.seed}:${caseId}:${slot}`).digest("hex").slice(0, length).toUpperCase()}`;
            if (!usedIds.has(id)) return usedIds.add(id), id;
        }
    };

    const caseEntries = order.map((caseId, index) => {
        const testCase = caseById.get(caseId);
        const label = `C${String(index + 1).padStart(2, "0")}`;
        const caseDigest = caseDigestOf(testCase);
        const outputs = products.map((product) => {
            const out = bundle.outputs[product.slot];
            const item = out?.items.find((candidate) => candidate.caseId === caseId);
            const base = { outputId: outputIdFor(caseId, product.slot), slot: product.slot, caseId, caseLabel: label };
            if (!item) return { ...base, status: "not_collected", reason: "수집된 출력 없음" };
            if (item.status === "failed") return { ...base, status: "failed", reason: item.failureReason };
            if (product.category !== "fixed_answer") return { ...base, status: product.category };
            const anonymized = anonymizeOutput(item, testCase, terms);
            if (!anonymized.ok) return { ...base, status: "blinding_impossible", reason: anonymized.reason };
            return {
                ...base,
                status: "presented",
                presented: anonymized.presented,
                redactions: anonymized.redactions,
                bindingDigest: digestOf({
                    caseDigest,
                    outputId: base.outputId,
                    original: item,
                    presented: anonymized.presented,
                    documentExposure: plan.documentExposure,
                }),
            };
        });
        return { label, testCase, caseDigest, outputs };
    });

    const packets = [];
    for (let slotIndex = 0; slotIndex < plan.judges; slotIndex += 1) {
        const arranged = caseEntries.map((entry, index) => {
            const presented = entry.outputs.filter((output) => output.status === "presented");
            // Balanced positions: rotate which product comes first per case,
            // and flip the rotation for the second judge.
            const shift = (index + slotIndex) % Math.max(1, presented.length);
            return { ...entry, presented: [...presented.slice(shift), ...presented.slice(0, shift)] };
        });
        const markdown = renderPacket(arranged, plan);
        const packetDigest = digestOf(markdown);
        // Which outputs, in which case order and position, for which judge.
        // Content is bound per output (bindingDigest), so one edited output
        // refuses only its own judgement; a changed assignment refuses all.
        const assignmentDigest = digestOf({
            seed: plan.seed,
            judgeSlot: slotIndex + 1,
            order: arranged.map((entry) => ({ label: entry.label, caseId: entry.testCase.caseId, outputs: entry.presented.map((output) => output.outputId) })),
        });
        const record = blankRecord(arranged, packetDigest, slotIndex + 1, assignmentDigest);
        const judgeFacing = `${markdown}\n${JSON.stringify(record)}`;
        const finalLeaks = terms.filter((term) => appearsIn(term, judgeFacing));
        if (finalLeaks.length) throw new PilotInputError(finalLeaks.map((term) => `판정자 묶음에 식별 정보가 남았습니다 (${shortDigest(term)})`));
        packets.push({
            judgeSlot: slotIndex + 1,
            markdown,
            packetDigest,
            assignmentDigest,
            positions: arranged.flatMap((entry) => entry.presented.map((output, position) => ({ outputId: output.outputId, position: position + 1 }))),
            record,
        });
    }

    const key = {
        schema: SCHEMA.key,
        warning: "운영자 전용. 판정과 정답 대조가 끝날 때까지 판정자에게 보이지 않습니다.",
        pilotId: plan.pilotId,
        seed: plan.seed,
        documentExposure: plan.documentExposure,
        freeze: { casesDigest: freeze.casesDigest, goldDigest: freeze.goldDigest, goldReviewStatus: freeze.goldReviewStatus },
        products,
        cases: caseEntries.map((entry) => ({
            label: entry.label,
            caseId: entry.testCase.caseId,
            language: entry.testCase.language,
            familyId: entry.testCase.familyId,
            variantId: entry.testCase.variantId,
            translationPairId: entry.testCase.translationPairId,
            caseDigest: entry.caseDigest,
        })),
        outputs: caseEntries.flatMap((entry) =>
            entry.outputs.map((output) => ({
                outputId: output.outputId,
                caseLabel: entry.label,
                caseId: output.caseId,
                slot: output.slot,
                status: output.status,
                reason: output.reason ?? null,
                displayMap: output.presented?.displayMap ?? null,
                redactions: output.redactions ?? [],
                bindingDigest: output.bindingDigest ?? null,
            }))
        ),
        packets: packets.map((packet) => ({
            judgeSlot: packet.judgeSlot,
            packetDigest: packet.packetDigest,
            positions: packet.positions,
            firstPositionBySlot: Object.fromEntries(
                products.map((product) => [
                    product.slot,
                    packet.positions.filter(
                        (position) =>
                            position.position === 1 &&
                            caseEntries.some((entry) => entry.outputs.some((o) => o.outputId === position.outputId && o.slot === product.slot))
                    ).length,
                ])
            ),
        })),
    };
    return { caseEntries, packets, key, terms };
}

function renderPacket(arranged, plan) {
    const shown = plan.documentExposure === "shown_in_question";
    const outputCount = arranged.reduce((sum, entry) => sum + entry.presented.length, 0);
    const lines = [
        "# 답변 비교 검토 · 블라인드 판정 묶음",
        "",
        `- 사례 ${arranged.length}개, 판정할 출력 ${outputCount}개`,
        `- 검토기 입력에 문서 원문 포함: ${shown ? "예 (질문과 함께 같은 발췌를 줌)" : "아니요 (판정자만 문서를 봄)"}`,
        "",
        "## 판정 방법",
        "",
        "출력이 어느 제품·모델의 것인지, 정답이 무엇인지는 이 묶음에 없습니다. 추측하지 말고 적힌 내용만 판정합니다.",
        "",
        "출력의 항목(F1, F2 …)마다 `record.json`에 한 줄 이상 적습니다. 한 항목에 독립된 주장이 둘이면 두 줄로 나눕니다.",
        "자유서술 출력에서 항목으로 표시되지 않은 지적을 찾으면 `segment: \"RAW\"`와 그 문장을 `excerpt`에 그대로 옮깁니다.",
        "",
        "- `contradiction` — 출력이 **명시적으로** 두 답변이 같은 대상·조건·기간에서 동시에 참일 수 없다고 지적함. 두 숫자를 나열만 한 것은 아닙니다.",
        "- `missing` — 질문이 요구한 항목을 어떤 답변이 빠뜨렸다고 지적함.",
        "- `document_error` — 두 답변이 함께 문서와 다른 값을 말한다고 지적함.",
        "- `agreement`, `difference` — 합의 또는 조건이 다른 차이로 보고함. `not_a_finding` — 인용·언급일 뿐 지적이 아님. `other` — 그 밖.",
        "",
        "`targets`에는 지적이 가리키는 **원답변 번호**(아래 '답변 1', '답변 2')를 적습니다. 출력 안의 A/B는 그 출력의 표시 라벨이며 출력마다 다를 수 있습니다.",
        "`statement`에는 출력이 주장한 명제(대상·조건·기간·값)를 한 문장으로 적습니다.",
        "`support`는 인용이 있는 항목에만 적습니다: 인용이 양쪽 주장과 결론을 **실제로 지지**하면 `supports`, 아니면 `does_not_support`, 판단할 수 없으면 `undeterminable`. 인용이 없으면 `null`.",
        "인용이 지정 답변에 글자 그대로 있는지는 도구가 따로 검사하므로 적지 않습니다.",
        "",
        "출력을 모두 읽었으면 출력마다 `reviewed: true`로 바꾸고 lock 명령으로 기록을 잠급니다. 잠근 뒤에만 정답 대조가 시작됩니다.",
        "",
    ];
    for (const entry of arranged) {
        const testCase = entry.testCase;
        lines.push(`## ${entry.label} (${testCase.language})`, "", "### 문서", "");
        for (const clause of testCase.document.clauses) lines.push(`- **${clause.id}** ${clause.text}`);
        lines.push("", "### 질문", "", testCase.question, "", "### 고정 답변", "");
        for (const answer of testCase.answers) lines.push(`**답변 ${answer.id}**`, "", "```", answer.content, "```", "");
        if (entry.presented.length === 0) lines.push("_이 사례에는 판정할 출력이 없습니다._", "");
        for (const [position, output] of entry.presented.entries()) {
            const presented = output.presented;
            lines.push(`### 출력 ${output.outputId} (위치 ${position + 1})`, "");
            if (presented.displayMap) {
                lines.push(
                    `표시 라벨 대응: ${Object.entries(presented.displayMap)
                        .map(([label, answerId]) => `${label} = 답변 ${answerId}`)
                        .join(", ")}`,
                    ""
                );
            } else {
                lines.push("표시 라벨 대응: 없음 (인용이 어느 답변에서 왔는지 도구가 확인할 수 없음)", "");
            }
            if (presented.aggregateQuotes) {
                lines.push(`_이 출력은 발견 문자열과 인용 합계(${presented.aggregateQuotes.total}개)만 남아 있어 인용별 출처를 알 수 없습니다._`, "");
            }
            if (presented.rawText !== null) lines.push("원문:", "", "```", presented.rawText, "```", "");
            if (presented.segments.length === 0) lines.push("- (발견 없음 — 출력이 빈 목록을 냈습니다)");
            for (const segment of presented.segments) {
                lines.push(`- **${segment.id}** [${segment.field}] ${segment.text}`);
                for (const [index, citation] of segment.citations.entries()) {
                    const where = citation.mappedAnswer ? `${citation.displayLabel} → 답변 ${citation.mappedAnswer}` : `${citation.displayLabel} → (대응 없음)`;
                    lines.push(`  - 인용 ${index + 1} (${where}): "${citation.quote}"`);
                }
            }
            lines.push("");
        }
    }
    return `${lines.join("\n")}\n`;
}

function blankRecord(arranged, packetDigest, judgeSlot, assignmentDigest) {
    return {
        schema: SCHEMA.record,
        packetDigest,
        assignmentDigest,
        judgeSlot,
        judge: { name: "" },
        mock: false,
        status: "draft",
        lockedAt: null,
        rowTemplate: { segment: "F1", excerpt: null, kind: ROW_KINDS.join("|"), targets: ["1", "2"], statement: "", support: `${SUPPORT_VALUES.join("|")}|null`, note: "" },
        outputs: arranged.flatMap((entry) =>
            entry.presented.map((output) => ({
                outputId: output.outputId,
                bindingDigest: output.bindingDigest,
                segments: output.presented.segments.map((segment) => ({ id: segment.id, hasCitations: segment.citations.length > 0 })),
                reviewed: false,
                rows: [],
            }))
        ),
    };
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

export function recordProblems(record) {
    const p = [];
    if (record?.schema !== SCHEMA.record) p.push(`schema는 ${SCHEMA.record}이어야 합니다`);
    if (!isText(record?.judge?.name)) p.push("judge.name이 비었습니다");
    for (const output of record?.outputs ?? []) {
        const at = `출력 ${output.outputId}`;
        if (output.reviewed !== true) p.push(`${at}: reviewed가 true가 아닙니다 (끝까지 읽었는지 확인)`);
        const segments = new Map((output.segments ?? []).map((segment) => [segment.id, segment]));
        const covered = new Set();
        for (const [index, row] of (output.rows ?? []).entries()) {
            const where = `${at} rows[${index}]`;
            if (row?.segment === "RAW") {
                if (!isText(row.excerpt)) p.push(`${where}: RAW 행에는 출력 원문 excerpt가 필요합니다`);
            } else if (!segments.has(row?.segment)) {
                p.push(`${where}: segment ${row?.segment}이 이 출력에 없습니다`);
            } else covered.add(row.segment);
            if (!ROW_KINDS.includes(row?.kind)) p.push(`${where}: kind는 ${ROW_KINDS.join("|")}입니다`);
            if (SCORED_KINDS.includes(row?.kind)) {
                if (!Array.isArray(row.targets) || row.targets.length === 0) p.push(`${where}: targets(원답변 번호)가 필요합니다`);
                if (!isText(row.statement)) p.push(`${where}: statement가 필요합니다`);
            }
            const hasCitations = segments.get(row?.segment)?.hasCitations === true;
            if (hasCitations && row?.kind === "contradiction" && !SUPPORT_VALUES.includes(row.support)) {
                p.push(`${where}: 인용이 있는 모순 지적에는 support(${SUPPORT_VALUES.join("|")})가 필요합니다`);
            }
            if (!hasCitations && row?.support !== null && row?.support !== undefined) p.push(`${where}: 인용이 없는 항목의 support는 null입니다`);
        }
        for (const id of segments.keys()) if (!covered.has(id)) p.push(`${at}: 항목 ${id}에 대한 행이 없습니다`);
    }
    return p;
}

export function lockRecord(record, { judge, at }) {
    const next = { ...record, judge: { ...record.judge, name: judge ?? record.judge?.name ?? "" } };
    const problems = recordProblems(next);
    if (!isTime(at)) problems.push("잠금 시각이 올바르지 않습니다");
    if (record.status === "locked") problems.push("이미 잠긴 기록입니다. 고치려면 새 판정을 시작합니다");
    if (problems.length) throw new PilotInputError(problems);
    return { ...next, status: "locked", lockedAt: at };
}

// ---------------------------------------------------------------------------
// Adjudication (after the records are locked; still no product key)
// ---------------------------------------------------------------------------

function goldSummary(goldCase) {
    return {
        completeness: goldCase.completeness,
        contradictions: goldCase.contradictions.map((item) => ({ goldId: item.goldId, subject: item.subject, condition: item.condition, answerSpans: item.answerSpans, rationale: item.rationale })),
        missing: goldCase.missing.map((item) => ({ goldId: item.goldId, targetAnswer: item.targetAnswer, requirement: item.requirement, rationale: item.rationale })),
        jointDocumentErrors: goldCase.jointDocumentErrors.map((item) => ({ goldId: item.goldId, documentValue: item.documentValue, rationale: item.rationale })),
    };
}

export function adjudicationTemplate(bundle, freeze, records) {
    const prepared = prepare(bundle, freeze);
    const checks = records.map((record) => checkRecord(record, prepared));
    const refused = checks.filter((check) => !check.accepted);
    if (refused.length) throw new PilotInputError(refused.flatMap((check) => check.problems));
    const outputs = {};
    for (const entry of prepared.caseEntries) {
        for (const output of entry.outputs.filter((o) => o.status === "presented")) {
            const judged = checks.map((check) => check.byOutput.get(output.outputId) ?? null);
            if (judged.every((item) => item === null)) continue;
            outputs[output.outputId] = {
                caseLabel: entry.label,
                gold: goldSummary(bundle.gold.cases[entry.testCase.caseId]),
                judges: judged.map((item) =>
                    (item?.rows ?? []).map((row, index) => ({
                        row: index,
                        kind: row.kind,
                        statement: row.statement ?? "",
                        ...(SCORED_KINDS.includes(row.kind) ? { verdict: "", goldId: null, sufficiency: "sufficient" } : {}),
                    }))
                ),
                // null until the two judges' rows are reconciled; [] is a real
                // "nothing scorable", so the two must not share a spelling.
                ...(records.length > 1 ? { consensus: null } : {}),
            };
        }
    }
    return {
        schema: SCHEMA.adjudication,
        goldDigest: freeze.goldDigest,
        recordDigests: records.map((record) => digestOf(record)),
        adjudicatedBy: "",
        adjudicatedAt: null,
        mock: false,
        status: "draft",
        instructions:
            "판정 행마다 verdict를 matched|false_finding|gold_gap|undetermined 중 하나로 적습니다. matched면 goldId를, 대상만 맞고 조건·기간을 특정하지 못했으면 sufficiency: insufficient를 적습니다. 판정자가 둘이면 consensus에 {judge, row, verdict, goldId, sufficiency}로 합의 결과를 적습니다.",
        outputs,
    };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function checkRecord(record, prepared) {
    const problems = recordProblems(record);
    const packet = prepared.packets.find((candidate) => candidate.judgeSlot === record?.judgeSlot);
    if (!packet) problems.push(`판정자 슬롯 ${record?.judgeSlot}의 묶음이 없습니다`);
    else if (record.assignmentDigest !== packet.assignmentDigest) {
        problems.push("기록이 지금과 다른 배정(seed·사례 순서·출력 위치)에서 만들어졌습니다. 재사용할 수 없습니다");
    }
    if (record?.status !== "locked" || !isTime(record?.lockedAt)) problems.push("기록이 잠기지 않았습니다 (판정 미확정)");
    const presented = new Map(prepared.caseEntries.flatMap((entry) => entry.outputs).filter((o) => o.status === "presented").map((o) => [o.outputId, o]));
    const byOutput = new Map();
    const outputProblems = [];
    for (const output of record?.outputs ?? []) {
        const current = presented.get(output.outputId);
        if (!current) outputProblems.push(`출력 ${output.outputId}: 지금 판정 대상이 아닙니다`);
        else if (output.bindingDigest !== current.bindingDigest) outputProblems.push(`출력 ${output.outputId}: 판정 뒤 출력·문서가 바뀌어 이 판정을 재사용할 수 없습니다`);
        else {
            const raw = current.presented.rawText;
            const badRaw = (output.rows ?? []).filter((row) => row.segment === "RAW" && !appearsIn(row.excerpt, raw ?? ""));
            if (badRaw.length) outputProblems.push(`출력 ${output.outputId}: RAW excerpt가 출력 원문에 없습니다`);
            else byOutput.set(output.outputId, output);
        }
    }
    return {
        record,
        accepted: problems.length === 0,
        problems: [...problems, ...outputProblems],
        byOutput: problems.length === 0 ? byOutput : new Map(),
        digest: digestOf(record),
        mock: record?.mock === true,
    };
}

/**
 * One planted kind, counted the way judged-v3 counts: unique gold matched is a
 * true positive, a repeat is a duplicate, a wrong or insufficient finding is a
 * false positive only where the gold claims to be complete, and an unruled
 * finding -- or a confirmed gap in a complete gold -- refuses the case.
 */
export function scorePlantedKind({ goldIds, complete, rows }) {
    const gaps = rows.filter((row) => row.verdict === "gold_gap").length;
    if (rows.some((row) => row.verdict === "undetermined")) return { scored: false, reason: "undetermined", gaps };
    if (gaps > 0 && complete) return { scored: false, reason: "gold_defect", gaps };
    const matched = new Set();
    const outcome = { scored: true, tp: 0, fp: 0, fn: 0, duplicates: 0, insufficient: 0, falseFindings: 0, goldGaps: gaps, precisionCounted: complete, matchedGoldIds: [] };
    for (const row of rows) {
        if (row.verdict === "matched") {
            if (row.sufficiency === "insufficient") {
                outcome.insufficient += 1;
                if (complete) outcome.fp += 1;
            } else if (matched.has(row.goldId)) outcome.duplicates += 1;
            else {
                matched.add(row.goldId);
                outcome.tp += 1;
            }
        } else if (row.verdict === "false_finding") {
            outcome.falseFindings += 1;
            if (complete) outcome.fp += 1;
        }
    }
    outcome.fn = goldIds.length - matched.size;
    outcome.matchedGoldIds = [...matched];
    return outcome;
}

/** The missing kind through judged-v3 itself, so "missing" means what it means there. */
function scoreMissingJudgedV3({ testCase, caseDigest, goldCase, rows, outputId, signedBy, signedAt }) {
    const judgedCase = {
        caseId: testCase.caseId,
        contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
        sourceCaseDigest: caseDigest,
        responseLabels: testCase.answers.map((a) => a.id),
        requirements: goldCase.missing.map((item) => ({ id: item.requirementId, description: item.requirement })),
        gold: { missingPoints: goldCase.missing.map((item) => ({ requirementId: item.requirementId, targetLabel: item.targetAnswer })) },
        goldCompleteness: { missingPoints: goldCase.completeness.missing },
    };
    const claims = rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => row.kind === "missing")
        .map(({ row, index }) => {
            const gold = row.verdict === "matched" ? goldCase.missing.find((item) => item.goldId === row.goldId) : null;
            return {
                targetLabel: gold ? gold.targetAnswer : String(row.targets?.[0] ?? testCase.answers[0].id),
                requirementId: gold ? gold.requirementId : `outside-${index}`,
                assertion: "missing",
                speechAct: "finding",
                submittedAs: "missingPoints",
                sourceIndex: index,
                evidenceQuote: row.evidence,
                ...(gold ? {} : { outsideGoldVerdict: { false_finding: "false_finding", gold_gap: "gold_incomplete", undetermined: "undetermined" }[row.verdict] }),
                ...(gold && row.sufficiency === "insufficient" ? { sufficiency: "insufficient" } : {}),
                status: "confirmed",
                confirmedBy: signedBy,
                confirmedAt: signedAt,
            };
        });
    const outcome = scoreJudgedCase(
        judgedCase,
        { caseId: testCase.caseId, contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION, observationRef: outputId, reviewedBy: signedBy, reviewedAt: signedAt, sourceCaseDigest: caseDigest, claims },
        { observationRef: outputId }
    );
    if (!outcome.scored) {
        const defect = (outcome.goldGaps?.missingPoints ?? 0) > 0 && goldCase.completeness.missing;
        return { scored: false, reason: defect ? "gold_defect" : "refused", detail: outcome.reason };
    }
    const kind = outcome.byKind.missingPoints;
    return { scored: true, tp: kind.truePositives, fp: kind.falsePositives, fn: kind.falseNegatives, duplicates: kind.duplicates, insufficient: kind.insufficientFindings, precisionCounted: kind.precisionCounted };
}

function rowsProblems(rows, goldCase) {
    const p = [];
    for (const [index, row] of rows.entries()) {
        if (!SCORED_KINDS.includes(row.kind)) continue;
        if (!VERDICTS.includes(row.verdict)) {
            p.push(`행 ${index}: verdict가 없습니다 (대조 미완료)`);
            continue;
        }
        if (row.verdict === "matched") {
            const ids = new Set(goldCase[GOLD_KIND[row.kind]].map((item) => item.goldId));
            if (!ids.has(row.goldId)) p.push(`행 ${index}: goldId ${row.goldId}는 이 사례의 ${row.kind} 정답이 아닙니다`);
        } else if (row.goldId) p.push(`행 ${index}: matched가 아닌데 goldId가 있습니다`);
        if (!["sufficient", "insufficient", undefined].includes(row.sufficiency)) p.push(`행 ${index}: sufficiency는 sufficient|insufficient입니다`);
        if (row.sufficiency === "insufficient" && row.verdict !== "matched") p.push(`행 ${index}: insufficient는 matched 행에만 적습니다`);
    }
    return p;
}

const outcomeSignature = (rows) =>
    digestOf(
        SCORED_KINDS.map((kind) => {
            const ofKind = rows.filter((row) => row.kind === kind);
            return {
                kind,
                hits: [...new Set(ofKind.filter((row) => row.verdict === "matched" && row.sufficiency !== "insufficient").map((row) => row.goldId))].sort(),
                wrong: ofKind.filter((row) => row.verdict === "false_finding" || row.sufficiency === "insufficient").length,
            };
        })
    );

const ratio = (numerator, denominator) => ({ numerator, denominator, value: denominator > 0 ? numerator / denominator : null });

function emptyTotals() {
    return { tp: 0, fp: 0, fn: 0, duplicates: 0, insufficient: 0, falseFindings: 0, precisionTp: 0, gold: 0 };
}
function addKind(totals, kind) {
    totals.tp += kind.tp;
    totals.fp += kind.fp;
    totals.fn += kind.fn;
    totals.duplicates += kind.duplicates;
    totals.insufficient += kind.insufficient;
    totals.falseFindings += kind.falseFindings ?? 0;
    if (kind.precisionCounted) totals.precisionTp += kind.tp;
    totals.gold += kind.tp + kind.fn;
}
const kindRates = (totals) => ({
    ...totals,
    precision: ratio(totals.precisionTp, totals.precisionTp + totals.fp),
    recall: ratio(totals.tp, totals.gold),
});

export function buildReport(bundle, freeze, { records = [], adjudication = null } = {}) {
    const prepared = prepare(bundle, freeze);
    const { plan } = bundle;
    const notes = [];
    const recordChecks = records.map((record) => checkRecord(record, prepared));
    const accepted = recordChecks.filter((check) => check.accepted);
    const slots = accepted.map((check) => check.record.judgeSlot);
    if (new Set(slots).size !== slots.length) {
        notes.push("같은 판정자 슬롯의 기록이 둘 이상이라 독립 판정으로 볼 수 없어 모두 제외했습니다");
        accepted.length = 0;
    }

    let adjudicationState = adjudication ? "invalid" : "absent";
    const adjudicationProblems = [];
    if (adjudication) {
        if (adjudication.schema !== SCHEMA.adjudication) adjudicationProblems.push("대조 파일 형식이 다릅니다");
        if (adjudication.status !== "locked" || !isText(adjudication.adjudicatedBy) || !isTime(adjudication.adjudicatedAt)) adjudicationProblems.push("대조가 잠기지 않았거나 대조자·시각이 없습니다");
        if (adjudication.goldDigest !== freeze.goldDigest) adjudicationProblems.push("대조가 다른 정답표 버전으로 만들어졌습니다");
        const expected = accepted.map((check) => check.digest);
        if (accepted.length === 0 || JSON.stringify(adjudication.recordDigests ?? []) !== JSON.stringify(expected)) {
            adjudicationProblems.push("대조가 지금 받아들인 잠긴 판정 기록과 결속되어 있지 않습니다");
        }
        if (adjudicationProblems.length === 0) adjudicationState = "accepted";
    }

    const anyMock = accepted.some((check) => check.mock) || adjudication?.mock === true;
    const perOutput = [];
    let agreementPairs = 0;
    let agreementMatches = 0;
    for (const entry of prepared.caseEntries) {
        const goldCase = bundle.gold.cases[entry.testCase.caseId];
        for (const output of entry.outputs) {
            const base = { outputId: output.outputId, slot: output.slot, caseLabel: entry.label, caseId: entry.testCase.caseId, language: entry.testCase.language, status: output.status, reason: output.reason ?? null };
            if (output.status !== "presented") {
                perOutput.push({ ...base, state: output.status });
                continue;
            }
            const judged = accepted.map((check) => check.byOutput.get(output.outputId) ?? null);
            const available = judged.filter(Boolean);
            const bindingRefusals = recordChecks.flatMap((check) => check.problems.filter((problem) => problem.includes(output.outputId)));
            if (available.length === 0) {
                perOutput.push({ ...base, state: bindingRefusals.length ? "judgement_refused" : "unjudged", reason: bindingRefusals[0] ?? null });
                continue;
            }
            if (adjudicationState !== "accepted" || !adjudication.outputs?.[output.outputId]) {
                perOutput.push({ ...base, state: "unadjudicated" });
                continue;
            }
            const adj = adjudication.outputs[output.outputId];
            const withVerdicts = (judgeIndex) =>
                (judged[judgeIndex]?.rows ?? []).map((row, index) => ({ ...row, ...(adj.judges?.[judgeIndex]?.[index] ?? {}), kind: row.kind }));
            let rows;
            let judging;
            if (accepted.length === 1) {
                rows = withVerdicts(0).map((row, index) => ({ ...row, judge: 0, rowIndex: index }));
                judging = "solo";
            } else {
                const both = judged.every(Boolean);
                if (both) {
                    agreementPairs += 1;
                    if (outcomeSignature(withVerdicts(0)) === outcomeSignature(withVerdicts(1))) agreementMatches += 1;
                }
                rows = (Array.isArray(adj.consensus) ? adj.consensus : [{}]).map((item) => {
                    const row = judged[item.judge]?.rows?.[item.row];
                    return row ? { ...row, verdict: item.verdict, goldId: item.goldId ?? null, sufficiency: item.sufficiency, judge: item.judge, rowIndex: item.row } : { kind: "invalid" };
                });
                judging = both ? "double" : "solo";
                if (!both) rows = withVerdicts(judged.findIndex(Boolean)).map((row, index) => ({ ...row, judge: judged.findIndex(Boolean), rowIndex: index }));
                else if (rows.some((row) => row.kind === "invalid")) {
                    perOutput.push({ ...base, state: "adjudication_invalid", reason: "판정자 둘의 합의(consensus)가 없거나 없는 행을 가리킵니다" });
                    continue;
                }
            }
            const problems = rowsProblems(rows, goldCase);
            if (problems.length) {
                perOutput.push({ ...base, state: "adjudication_invalid", reason: problems.join("; ") });
                continue;
            }
            const segmentOf = (row) => output.presented.segments.find((segment) => segment.id === row.segment) ?? null;
            const rowsWithEvidence = rows.map((row) => ({ ...row, evidence: row.segment === "RAW" ? row.excerpt : (segmentOf(row)?.text ?? "") }));
            const scoreKind = (kind) =>
                scorePlantedKind({
                    goldIds: goldCase[GOLD_KIND[kind]].map((item) => item.goldId),
                    complete: goldCase.completeness[COMPLETENESS_KIND[kind]],
                    rows: rowsWithEvidence.filter((row) => row.kind === kind),
                });
            const contradiction = scoreKind("contradiction");
            const missing = scoreMissingJudgedV3({
                testCase: entry.testCase,
                caseDigest: entry.caseDigest,
                goldCase,
                rows: rowsWithEvidence,
                outputId: output.outputId,
                signedBy: adjudication.adjudicatedBy,
                signedAt: adjudication.adjudicatedAt,
            });
            const documentError =
                plan.documentExposure === "shown_in_question"
                    ? scoreKind("document_error")
                    : { scored: false, reason: "not_applicable", claims: rowsWithEvidence.filter((row) => row.kind === "document_error").length };
            const refused = [contradiction, missing, ...(documentError.reason === "not_applicable" ? [] : [documentError])].filter((kind) => !kind.scored);
            const evidence = rowsWithEvidence
                .filter((row) => row.kind === "contradiction")
                .map((row) => {
                    const citations = row.segment === "RAW" ? [] : (segmentOf(row)?.citations ?? []);
                    return {
                        verdict: row.verdict,
                        sufficiency: row.sufficiency ?? "sufficient",
                        goldId: row.goldId ?? null,
                        citations: citations.map((citation) => citation.match),
                        citesBothAnswers: new Set(citations.map((citation) => citation.mappedAnswer).filter(Boolean)).size >= 2,
                        support: citations.length === 0 ? "no_evidence" : (row.support ?? "undeterminable"),
                        text: row.evidence,
                        statement: row.statement,
                    };
                });
            perOutput.push({
                ...base,
                state: refused.length ? (refused.some((kind) => kind.reason === "gold_defect") ? "gold_defect" : "refused") : "scored",
                reason: refused.map((kind) => kind.detail ?? kind.reason).join("; ") || null,
                judging,
                contradiction,
                missing,
                documentError,
                evidence,
                aggregateQuotes: output.presented.aggregateQuotes,
            });
        }
    }

    // A gold proved short on one product's output holds the case for ALL
    // products: the others were measured against the same short list.
    const defectCases = new Set(perOutput.filter((o) => o.state === "gold_defect").map((o) => o.caseId));
    for (const output of perOutput) {
        if (defectCases.has(output.caseId) && output.state === "scored") {
            output.state = "gold_defect_hold";
            output.reason = "같은 사례의 다른 출력에서 정답표 결함이 확인되어 보류 (정답표 수정 후 양쪽 재채점)";
        }
    }

    const goldOf = (caseId) => bundle.gold.cases[caseId];
    const products = {};
    for (const product of prepared.key.products) {
        const outputs = perOutput.filter((o) => o.slot === product.slot);
        const scored = outputs.filter((o) => o.state === "scored");
        const byLanguage = {};
        const contradiction = emptyTotals();
        const missing = emptyTotals();
        const documentError = emptyTotals();
        for (const output of scored) {
            addKind(contradiction, output.contradiction);
            addKind(missing, output.missing);
            if (output.documentError.scored) addKind(documentError, output.documentError);
            byLanguage[output.language] ??= emptyTotals();
            addKind(byLanguage[output.language], output.contradiction);
        }
        const negatives = scored.filter((o) => goldOf(o.caseId).contradictions.length === 0 && goldOf(o.caseId).completeness.contradiction);
        const evidence = scored.flatMap((o) => o.evidence);
        const citations = evidence.flatMap((item) => item.citations);
        const groundedHits = new Set(
            evidence
                .filter((item) => item.verdict === "matched" && item.sufficiency !== "insufficient" && item.support === "supports" && item.citations.length > 0 && item.citations.every((c) => c === "matched"))
                .map((item) => item.goldId)
        );
        const count = (state) => outputs.filter((o) => o.state === state || o.status === state).length;
        const measurementReasons = [];
        if (product.source !== "real_capture") measurementReasons.push(product.source === null ? "출력 없음" : "출력이 합성 모의 자료");
        if (accepted.length === 0) measurementReasons.push("잠긴 사람 판정 없음");
        if (anyMock) measurementReasons.push("판정·대조가 모의(합성)");
        if (adjudicationState !== "accepted") measurementReasons.push("정답 대조 미완료");
        if (freeze.goldReviewStatus !== "human_reviewed") measurementReasons.push("정답표가 사람 검토 전 후보");
        if (product.category !== "fixed_answer") measurementReasons.push(`고정 답변 비교 대상 아님 (${product.category})`);
        products[product.slot] = {
            productName: product.productName,
            source: product.source,
            category: product.category,
            measurement: measurementReasons.length ? { status: "unmeasured", reasons: measurementReasons } : { status: "measured", reasons: [] },
            counts: {
                planned: outputs.length,
                collected: outputs.filter((o) => !["not_collected", "failed", "absent"].includes(o.status)).length,
                failed: count("failed"),
                notCollected: count("not_collected") + count("absent"),
                blindingImpossible: count("blinding_impossible"),
                fullProductExperience: count("full_product_experience"),
                conditionMismatch: count("condition_mismatch"),
                presented: outputs.filter((o) => o.status === "presented").length,
                judged: outputs.filter((o) => ["scored", "refused", "gold_defect", "gold_defect_hold", "adjudication_invalid", "unadjudicated"].includes(o.state)).length,
                unjudged: count("unjudged") + count("judgement_refused"),
                scored: scored.length,
                refused: outputs.filter((o) => ["refused", "gold_defect", "gold_defect_hold", "adjudication_invalid"].includes(o.state)).length,
            },
            contradiction: {
                ...kindRates(contradiction),
                byLanguage: Object.fromEntries(Object.entries(byLanguage).sort().map(([language, totals]) => [language, kindRates(totals)])),
            },
            negativeCaseFalseContradiction: ratio(negatives.filter((o) => o.contradiction.fp > 0 || o.contradiction.falseFindings > 0).length, negatives.length),
            missing: kindRates(missing),
            jointDocumentError:
                plan.documentExposure === "shown_in_question"
                    ? { applicable: true, detected: ratio(documentError.tp, documentError.gold), falseClaims: documentError.falseFindings }
                    : { applicable: false, detected: null, claimsRecorded: scored.reduce((sum, o) => sum + (o.documentError.claims ?? 0), 0) },
            evidence: {
                contradictionFindings: evidence.length,
                findingsWithoutCitation: evidence.filter((item) => item.citations.length === 0).length,
                citationMatch: ratio(citations.filter((c) => c === "matched").length, citations.filter((c) => c !== "not_checkable").length),
                citationsNotCheckable: citations.filter((c) => c === "not_checkable").length,
                aggregateOnlyQuotes: scored.reduce((sum, o) => sum + (o.aggregateQuotes?.total ?? 0), 0),
                citesBothAnswers: evidence.filter((item) => item.citesBothAnswers).length,
                support: {
                    supports: evidence.filter((item) => item.support === "supports").length,
                    doesNotSupport: evidence.filter((item) => item.support === "does_not_support").length,
                    undeterminable: evidence.filter((item) => item.support === "undeterminable").length,
                    noEvidence: evidence.filter((item) => item.support === "no_evidence").length,
                },
                semanticSupport: ratio(
                    evidence.filter((item) => item.support === "supports").length,
                    evidence.filter((item) => item.support === "supports" || item.support === "does_not_support").length
                ),
                groundedGoldHits: ratio(groundedHits.size, contradiction.gold),
            },
        };
    }

    const slotsOrder = prepared.key.products.map((product) => product.slot);
    const pairwise = { slots: slotsOrder, eligiblePairs: 0, notPaired: {}, golds: { both: 0, onlyFirst: 0, onlySecond: 0, neither: 0 }, byLanguage: {} };
    if (slotsOrder.length === 2) {
        for (const entry of prepared.caseEntries) {
            const [first, second] = slotsOrder.map((slot) => perOutput.find((o) => o.caseId === entry.testCase.caseId && o.slot === slot));
            if (first.state !== "scored" || second.state !== "scored") {
                const reason = first.state !== "scored" ? `${first.slot}: ${first.state}` : `${second.slot}: ${second.state}`;
                pairwise.notPaired[reason] = (pairwise.notPaired[reason] ?? 0) + 1;
                continue;
            }
            pairwise.eligiblePairs += 1;
            const language = entry.testCase.language;
            pairwise.byLanguage[language] ??= { pairs: 0, both: 0, onlyFirst: 0, onlySecond: 0, neither: 0 };
            pairwise.byLanguage[language].pairs += 1;
            for (const gold of goldOf(entry.testCase.caseId).contradictions) {
                const a = first.contradiction.matchedGoldIds.includes(gold.goldId);
                const b = second.contradiction.matchedGoldIds.includes(gold.goldId);
                const bucket = a && b ? "both" : a ? "onlyFirst" : b ? "onlySecond" : "neither";
                pairwise.golds[bucket] += 1;
                pairwise.byLanguage[language][bucket] += 1;
            }
        }
    }

    const scoredAll = perOutput.filter((o) => o.state === "scored");
    const falsePositive = scoredAll.flatMap((o) => o.evidence.filter((item) => item.verdict === "false_finding" || item.sufficiency === "insufficient").map((item) => ({ ...item, slot: o.slot, caseLabel: o.caseLabel, caseId: o.caseId, language: o.language, outputId: o.outputId })))[0] ?? null;
    const falseNegative =
        scoredAll
            .flatMap((o) =>
                goldOf(o.caseId)
                    .contradictions.filter((gold) => !o.contradiction.matchedGoldIds.includes(gold.goldId))
                    .map((gold) => ({ slot: o.slot, caseLabel: o.caseLabel, caseId: o.caseId, language: o.language, outputId: o.outputId, goldId: gold.goldId, subject: gold.subject, condition: gold.condition, clauseRef: gold.clauseRef, answerSpans: gold.answerSpans, rationale: gold.rationale }))
            )[0] ?? null;

    return {
        schema: SCHEMA.report,
        pilotId: plan.pilotId,
        notice: "작은 파일럿의 오류 분석용 결과입니다. M5 승인·승격 판정이나 제품 전체 우위의 근거가 아닙니다.",
        provenance: {
            cases: `합성 견적서 ${bundle.cases.cases.length}개 사례·언어 조합 (번역쌍 ${new Set(bundle.cases.cases.map((c) => c.translationPairId)).size}개 — 번역쌍은 독립 표본이 아님)`,
            goldReviewStatus: freeze.goldReviewStatus,
            documentExposure: plan.documentExposure,
            products: prepared.key.products,
            judgements: {
                submitted: records.length,
                accepted: accepted.length,
                refused: recordChecks.filter((check) => !check.accepted).map((check) => check.problems),
                mock: anyMock,
                judging: accepted.length === 2 ? "double" : accepted.length === 1 ? "solo" : "none",
            },
            adjudication: { state: adjudicationState, problems: adjudicationProblems, mock: adjudication?.mock === true },
        },
        agreement: accepted.length === 2 ? { doubleJudgedOutputs: agreementPairs, agreedBeforeConsensus: agreementMatches } : null,
        products,
        pairwise,
        examples: { falsePositive, falseNegative },
        goldDefects: [...defectCases],
        outputs: perOutput.map((output) => {
            const summary = { ...output };
            for (const field of ["contradiction", "missing", "documentError", "evidence", "aggregateQuotes"]) delete summary[field];
            const kind = output.contradiction;
            return { ...summary, contradiction: kind?.scored ? { tp: kind.tp, fp: kind.fp, fn: kind.fn, duplicates: kind.duplicates } : undefined };
        }),
        notes,
    };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const fmt = (rate) => (rate === null ? "N/A" : rate.denominator === 0 ? `${rate.numerator}/0 (N/A)` : `${rate.numerator}/${rate.denominator}`);

export function renderReport(report) {
    const slots = Object.keys(report.products);
    const names = Object.fromEntries(slots.map((slot) => [slot, `${slot} (${report.products[slot].productName ?? "출력 없음"})`]));
    const unmeasured = slots.filter((slot) => report.products[slot].measurement.status !== "measured");
    const lines = [
        "# AI Review 블라인드 파일럿 보고서",
        "",
        `> ${report.notice}`,
        "",
    ];
    if (unmeasured.length) {
        lines.push(`**품질 미측정** — ${unmeasured.map((slot) => `${names[slot]}: ${report.products[slot].measurement.reasons.join(", ")}`).join(" / ")}`, "");
        lines.push("아래 수치는 파이프라인 시연이며 어떤 제품의 실제 품질도 아닙니다. 제품 순위를 만들지 않습니다.", "");
    }
    lines.push("눈가림 한계: 제품명·모델·사례 ID·정답은 가렸지만, 출력 형식(구조화 필드 대 자유서술)과 문체만으로 출처를 추측할 수 있습니다.", "");
    lines.push(
        "## 출처",
        "",
        `- 과제: ${report.provenance.cases}`,
        `- 정답표 상태: ${report.provenance.goldReviewStatus === "human_reviewed" ? "사람 검토 완료" : "후보 (사람 검토 전 — adopted/confirmed 아님)"}`,
        `- 검토기 입력의 문서 노출: ${report.provenance.documentExposure === "shown_in_question" ? "질문과 함께 같은 발췌 제공" : "제공 안 함"}`,
        ...report.provenance.products.map((product) => `- 제품 ${product.slot}: ${product.productName ?? "출력 없음"} · 출처 ${product.source ?? "-"} · 수집 ${product.captureMethod ?? "-"} · 분류 ${product.category}`),
        `- 판정: 제출 ${report.provenance.judgements.submitted}, 수용 ${report.provenance.judgements.accepted} (${report.provenance.judgements.judging === "double" ? "독립 2인" : report.provenance.judgements.judging === "solo" ? "단독 관찰" : "없음"})${report.provenance.judgements.mock ? " · 모의 판정" : ""}`,
        `- 정답 대조: ${report.provenance.adjudication.state}${report.provenance.adjudication.mock ? " (모의)" : ""}`,
        ""
    );
    for (const problems of report.provenance.judgements.refused) lines.push(`- 거부된 판정 기록: ${problems.join("; ")}`);
    for (const problem of report.provenance.adjudication.problems) lines.push(`- 대조 거부: ${problem}`);
    if (report.agreement) lines.push(`- 합의 전 일치: ${report.agreement.agreedBeforeConsensus}/${report.agreement.doubleJudgedOutputs} 출력`);
    lines.push("", "## 건수", "", "| 제품 | 계획 | 실제 출력 | 실패 | 미수집 | 눈가림 불가 | 전체 제품 경험(별도) | 판정 대상 | 판정 완료 | 미판정 | 채점 | 보류·거부 |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const slot of slots) {
        const c = report.products[slot].counts;
        lines.push(`| ${names[slot]} | ${c.planned} | ${c.collected} | ${c.failed} | ${c.notCollected} | ${c.blindingImpossible} | ${c.fullProductExperience} | ${c.presented} | ${c.judged} | ${c.unjudged} | ${c.scored} | ${c.refused} |`);
    }
    lines.push("", `양쪽 적격 쌍: ${report.pairwise.eligiblePairs}`);
    for (const [reason, count] of Object.entries(report.pairwise.notPaired)) lines.push(`- 짝 미실시 ${count}건 — ${reason}`);
    lines.push("", "## 모순 (완전 gold 사례만 정밀도에 포함)", "", "| 제품 | TP | FP | FN | 중복 | 불충분 | 정밀도 | 재현율 | ko 정밀도 | ko 재현율 | en 정밀도 | en 재현율 | 음성 사례 가짜 모순 |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const slot of slots) {
        const k = report.products[slot].contradiction;
        const lang = (language, field) => (k.byLanguage[language] ? fmt(k.byLanguage[language][field]) : "N/A");
        lines.push(`| ${names[slot]} | ${k.tp} | ${k.fp} | ${k.fn} | ${k.duplicates} | ${k.insufficient} | ${fmt(k.precision)} | ${fmt(k.recall)} | ${lang("ko", "precision")} | ${lang("ko", "recall")} | ${lang("en", "precision")} | ${lang("en", "recall")} | ${fmt(report.products[slot].negativeCaseFalseContradiction)} |`);
    }
    lines.push("", "## 누락과 공동 문서 오류", "", "| 제품 | 누락 정밀도 | 누락 재현율 | 공동 문서 오류 탐지 | 근거 없는 문서 오류 지적 |", "|---|---|---|---|---|");
    for (const slot of slots) {
        const product = report.products[slot];
        const doc = product.jointDocumentError;
        lines.push(`| ${names[slot]} | ${fmt(product.missing.precision)} | ${fmt(product.missing.recall)} | ${doc.applicable ? fmt(doc.detected) : "평가 대상 아님 (검토기에 원문 미제공)"} | ${doc.applicable ? doc.falseClaims : "-"} |`);
    }
    lines.push("", "공동 오류 사례의 답변 간 모순 gold는 0건이며, 위 모순 표에서는 '모순 없음'으로만 채점됩니다.", "");
    lines.push("## 근거", "", "| 제품 | 모순 지적 | 인용 없음 | (a) 인용 일치 | 인용 판정 불가 | 합계만 있는 인용 | 양쪽 답변 인용 | (b) 지지 | 불지지 | 판정 불가 | (c) 근거 미제시 | 근거까지 갖춘 정답 모순 |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const slot of slots) {
        const e = report.products[slot].evidence;
        lines.push(`| ${names[slot]} | ${e.contradictionFindings} | ${e.findingsWithoutCitation} | ${fmt(e.citationMatch)} | ${e.citationsNotCheckable} | ${e.aggregateOnlyQuotes} | ${e.citesBothAnswers} | ${e.support.supports} | ${e.support.doesNotSupport} | ${e.support.undeterminable} | ${e.support.noEvidence} | ${fmt(e.groundedGoldHits)} |`);
    }
    lines.push("", "(a)는 표시 라벨 대응표를 거쳐 지정 원답변에서 제품의 인용 검사로 찾은 비율입니다. 인용 일치는 결론이 맞다는 뜻이 아닙니다.", "");
    if (slots.length === 2) {
        const [first, second] = slots;
        lines.push("## 짝비교 (양쪽 적격 쌍의 gold 모순)", "", `| 언어 | 쌍 | 양쪽 적중 | ${first}만 | ${second}만 | 둘 다 놓침 |`, "|---|---|---|---|---|---|");
        for (const [language, row] of Object.entries(report.pairwise.byLanguage).sort()) lines.push(`| ${language} | ${row.pairs} | ${row.both} | ${row.onlyFirst} | ${row.onlySecond} | ${row.neither} |`);
        const g = report.pairwise.golds;
        lines.push(`| 합계 | ${report.pairwise.eligiblePairs} | ${g.both} | ${g.onlyFirst} | ${g.onlySecond} | ${g.neither} |`, "");
    }
    lines.push("## 대표 사례", "");
    const fp = report.examples.falsePositive;
    lines.push(
        fp
            ? `- **오탐** ${fp.slot} · ${fp.caseLabel} (${fp.caseId}, ${fp.language}) · ${fp.outputId}: "${fp.text}" — 판정자 명제: ${fp.statement || "-"} · 인용 ${fp.citations.join(", ") || "없음"} · 지지 ${fp.support}${fp.sufficiency === "insufficient" ? " · 대상은 맞으나 조건·기간 불충분" : ""}`
            : "- 오탐: 없음"
    );
    const fn = report.examples.falseNegative;
    lines.push(
        fn
            ? `- **미탐** ${fn.slot} · ${fn.caseLabel} (${fn.caseId}, ${fn.language}) · ${fn.outputId}: ${fn.subject} [${fn.condition}] ${fn.clauseRef} — 구간 ${Object.entries(fn.answerSpans).map(([id, span]) => `답변 ${id} "${span}"`).join(" / ")} · ${fn.rationale}`
            : "- 미탐: 없음",
        ""
    );
    if (report.goldDefects.length) lines.push(`## 정답표 결함 (해당 사례 양쪽 보류)`, "", ...report.goldDefects.map((caseId) => `- ${caseId}`), "");
    const held = report.outputs.filter((o) => !["scored", "presented"].includes(o.state) && o.reason);
    if (held.length) {
        lines.push("## 채점에서 빠진 출력", "");
        for (const output of held) lines.push(`- ${output.slot} · ${output.caseLabel} (${output.caseId}) · ${output.state}: ${output.reason}`);
        lines.push("");
    }
    for (const note of report.notes) lines.push(`- ${note}`);
    return `${lines.join("\n")}\n`;
}
