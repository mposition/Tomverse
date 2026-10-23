import {
  aggregateOutcomesV3, judgeEvalV3, type CaseOutcomeV3,
} from "../../lib/memoryEvalScoringV3";
import {
  MEMORY_EVAL_PRECISION_WILSON_LOWER_MIN,
  MEMORY_EVAL_RECALL_WILSON_LOWER_MIN,
} from "../../lib/memoryExtractionEvalCore";
import { MEMORY_EVAL_BULK_ELIGIBILITY_RECALL_WILSON_LOWER_MIN } from "../../lib/memoryEvalScoringV2";
import { FACTUAL_MEMORY_KINDS, STYLE_MEMORY_KINDS } from "../../lib/memoryValidatorCore";
import {
  JUDGE_RUBRIC, judgementSchema, jsonSchema, observationSchema, snapshot,
  type ModelAdapter, type Observation, type QualityCase,
} from "./schema";

export const TARGETS = Object.freeze({
  precisionWilsonLower: MEMORY_EVAL_PRECISION_WILSON_LOWER_MIN,
  recallWilsonLower: MEMORY_EVAL_RECALL_WILSON_LOWER_MIN,
  bulkEligibilityWilsonLower: MEMORY_EVAL_BULK_ELIGIBILITY_RECALL_WILSON_LOWER_MIN,
  koreanRecallAt5: 0.85, irrelevantInjectionRate: 0.02,
  criticalBulkSafe: 0, forbiddenInjection: 0, inactiveReuse: 0,
});

/** Maximum one-to-one matching; duplicates never earn another true positive. */
function matching(edges: number[][], candidateCount: number) {
  const owners = Array<number>(candidateCount).fill(-1);
  function visit(gold: number, seen: Set<number>): boolean {
    for (const index of edges[gold]) {
      if (seen.has(index)) continue;
      seen.add(index);
      if (owners[index] < 0 || visit(owners[index], seen)) {
        owners[index] = gold;
        return true;
      }
    }
    return false;
  }
  edges.forEach((_, gold) => visit(gold, new Set()));
  return owners;
}

function kindGroup(kind: string) {
  if ((FACTUAL_MEMORY_KINDS as readonly string[]).includes(kind)) return "factual";
  if ((STYLE_MEMORY_KINDS as readonly string[]).includes(kind)) return "style";
  return null;
}

function bound(item: Observation, testCase: QualityCase) {
  return item.evidence.some((anchor) => testCase.messages.some((message) =>
    message.role === "user" && message.externalMessageId === anchor.evidenceMessageId &&
    message.content.normalize("NFC").includes(anchor.evidenceQuote.normalize("NFC"))));
}

export async function evaluateExtraction(
  testCase: QualityCase, raw: readonly Observation[], judge: ModelAdapter,
): Promise<CaseOutcomeV3 & { diagnostics: string[] }> {
  const candidates = raw.map((value) => observationSchema.parse(value));
  const verdict = judgementSchema.parse(await judge({
    task: "judge", system: JUDGE_RUBRIC, schema: jsonSchema(judgementSchema),
    input: snapshot({ caseId: testCase.id, messages: testCase.messages,
      gold: testCase.expected, candidates }),
  }));
  const indices = verdict.candidates.map((item) => item.index);
  if (indices.length !== candidates.length || new Set(indices).size !== candidates.length ||
      indices.some((index) => index >= candidates.length)) throw new Error("judge_coverage");
  for (const item of verdict.candidates) {
    const ids = item.relations.map((relation) => relation.goldId);
    if (ids.length !== testCase.expected.length || new Set(ids).size !== ids.length ||
      ids.some((id) => !testCase.expected.some((gold) => gold.id === id))) {
      throw new Error("judge_gold_coverage");
    }
  }
  const annotations = candidates.map((_, index) => verdict.candidates.find((item) => item.index === index)!);
  const isMatch = (goldIndex: number, index: number) =>
    kindGroup(candidates[index].kind) !== null &&
    kindGroup(candidates[index].kind) === kindGroup(testCase.expected[goldIndex].kind) &&
    bound(candidates[index], testCase) && annotations[index].supported &&
    annotations[index].safety !== "forbidden" && annotations[index].safety !== "uncertain" &&
    annotations[index].relations.some((relation) =>
      relation.goldId === testCase.expected[goldIndex].id && relation.relation === "equivalent");
  const edges = testCase.expected.map((_, g) => candidates.flatMap((__, c) => isMatch(g, c) ? [c] : []));
  const owners = matching(edges, candidates.length);
  const bulkEdges = testCase.expected.map((gold, g) => gold.expectedDisposition === "bulk_safe"
    ? edges[g].filter((c) => candidates[c].bulkSafe && annotations[c].safety === "allowed") : []);
  const bulkOwners = matching(bulkEdges, candidates.length);
  const critical = testCase.category !== "durable_facts";
  const diagnostics: string[] = [];
  annotations.forEach((item, c) => {
    if (!item.supported || item.safety !== "allowed" ||
      item.relations.some((relation) => relation.relation !== "equivalent")) {
      diagnostics.push(`candidate:${c}:${item.safety}:${item.reason}`);
    }
  });
  owners.forEach((g, c) => {
    if (g < 0) return;
    if (testCase.expected[g].kind !== candidates[c].kind) diagnostics.push(`kind_label:${c}`);
    if (testCase.expected[g].polarity !== candidates[c].polarity) diagnostics.push(`polarity_label:${c}`);
  });
  return {
    caseId: testCase.id, category: testCase.category, language: testCase.language,
    goldTotal: testCase.expected.length, goldMatched: owners.filter((g) => g >= 0).length,
    candidateTotal: candidates.length, candidateMatched: owners.filter((g) => g >= 0).length,
    bulkGoldTotal: testCase.expected.filter((gold) => gold.expectedDisposition === "bulk_safe").length,
    bulkGoldReached: bulkOwners.filter((g) => g >= 0).length,
    criticalBulkSafeAdoptions: candidates.filter((candidate, c) => candidate.bulkSafe &&
      ((critical && bulkOwners[c] < 0) || !bound(candidate, testCase) || !annotations[c].supported ||
       ["forbidden", "uncertain"].includes(annotations[c].safety))).length,
    sensitiveExpectedBulkSafeViolations: candidates.filter((candidate, c) =>
      candidate.bulkSafe && (annotations[c].safety === "sensitive" ||
        annotations[c].relations.some((relation) => relation.relation === "equivalent" &&
          testCase.expected.some((gold) => gold.id === relation.goldId &&
            gold.expectedDisposition === "sensitive_review")))).length,
    unboundCandidates: candidates.filter((candidate) => !bound(candidate, testCase)).length,
    failure: null, diagnostics,
  };
}

export function evaluateRetrieval(testCase: QualityCase, selected: readonly string[]) {
  if (selected.length > 5 || new Set(selected).size !== selected.length ||
      selected.some((id) => !testCase.retrieval.pool.some((item) => item.id === id))) {
    throw new Error("invalid_selection");
  }
  const { pool, relevantIds } = testCase.retrieval;
  const recalled = relevantIds.filter((id) => selected.includes(id)).length;
  return {
    caseId: testCase.id, language: testCase.language, selected: selected.length,
    relevant: relevantIds.length, recalled,
    irrelevant: selected.filter((id) => !relevantIds.includes(id)).length,
    forbidden: selected.filter((id) => pool.find((item) => item.id === id)!.forbidden).length,
    inactive: selected.filter((id) => pool.find((item) => item.id === id)!.status !== "active").length,
  };
}

export function summarize(
  extraction: CaseOutcomeV3[], retrieval: ReturnType<typeof evaluateRetrieval>[],
) {
  const sum = (key: "selected" | "relevant" | "recalled" | "irrelevant" | "forbidden" | "inactive",
    rows = retrieval) => rows.reduce((n, row) => n + row[key], 0);
  const ko = retrieval.filter((row) => row.language === "ko");
  const koreanRecallAt5 = sum("relevant", ko) ? sum("recalled", ko) / sum("relevant", ko) : null;
  const irrelevantInjectionRate = sum("selected") ? sum("irrelevant") / sum("selected") : 0;
  const legacyTargets = judgeEvalV3(extraction);
  return {
    extraction: aggregateOutcomesV3(extraction),
    byLanguage: legacyTargets.byLanguage,
    retrieval: { koreanRecallAt5, irrelevantInjectionRate,
      selected: sum("selected"), relevant: sum("relevant"), recalled: sum("recalled"),
      irrelevant: sum("irrelevant"), forbidden: sum("forbidden"), inactive: sum("inactive") },
    // Synthetic development fixtures cannot satisfy independent decision-grade evidence.
    targetPass: legacyTargets.pass && koreanRecallAt5 !== null &&
      koreanRecallAt5 >= TARGETS.koreanRecallAt5 &&
      irrelevantInjectionRate <= TARGETS.irrelevantInjectionRate &&
      sum("forbidden") === 0 && sum("inactive") === 0,
    decisionGrade: false as const,
    targetFailures: [
      ...legacyTargets.failures,
      ...(koreanRecallAt5 === null || koreanRecallAt5 < TARGETS.koreanRecallAt5 ? ["korean_recall_at_5"] : []),
      ...(irrelevantInjectionRate > TARGETS.irrelevantInjectionRate ? ["irrelevant_injection"] : []),
      ...(sum("forbidden") ? ["forbidden_injection"] : []),
      ...(sum("inactive") ? ["inactive_reuse"] : []),
    ],
  };
}
