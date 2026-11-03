import { z } from "zod";

export const AI_REVIEW_JUDGED_FLOORS = [
  "contradictionRecall",
  "contradictionPrecision",
  "omissionRecall",
  "omissionPrecision",
  "exactQuoteMatchRate",
  "schemaValidRate",
] as const;
export const AI_REVIEW_JUDGED_CEILINGS = [
  "missedEveryPlantedIssueRate",
  "inventedFindingRate",
] as const;
const rate = z.number().finite().min(0).max(1);
const draftRate = rate.nullable();
export const judgedThresholdDraftSchema = z
  .object({
    metricSource: z.literal("judged-v3"),
    version: z.string().trim().min(1),
    approvedBy: z.string().trim().min(1).nullable(),
    approvedAt: z
      .string()
      .refine(
        (value) => Number.isFinite(Date.parse(value)),
        "Unreadable approval time",
      )
      .nullable(),
    rationale: z.string(),
    minWilsonLower: z
      .object({
        contradictionRecall: draftRate,
        contradictionPrecision: draftRate,
        omissionRecall: draftRate,
        omissionPrecision: draftRate,
        exactQuoteMatchRate: draftRate,
        schemaValidRate: draftRate,
      })
      .strict(),
    maxWilsonUpper: z
      .object({
        missedEveryPlantedIssueRate: draftRate,
        inventedFindingRate: draftRate,
      })
      .strict(),
    maxLanguageArmGap: draftRate,
    maxTaskTypeArmShortfall: draftRate,
    negativeSubset: z.discriminatedUnion("policy", [
      z.object({ policy: z.literal("undecided") }).strict(),
      z.object({ policy: z.literal("diagnostic") }).strict(),
      z
        .object({ policy: z.literal("gate"), maxWilsonUpper: draftRate })
        .strict(),
    ]),
    maxZeroToleranceViolations: z.literal(0),
    minBlindReviewedCases: z.number().int().positive().nullable(),
  })
  .strict();
export type AiReviewJudgedThresholdDraft = z.infer<
  typeof judgedThresholdDraftSchema
>;

/** Activation requires a separately selected and signed set. No live set is installed. */
export const AI_REVIEW_JUDGED_THRESHOLD_SETS: readonly AiReviewJudgedThresholdDraft[] =
  [];
export const findJudgedThresholdSet = (version: string) =>
  AI_REVIEW_JUDGED_THRESHOLD_SETS.find((set) => set.version === version) ??
  null;

/** No new ceiling or arm value is silently inherited from the keyword scale. */
export function emptyJudgedThresholdDraft(): AiReviewJudgedThresholdDraft {
  return {
    metricSource: "judged-v3",
    version: "judged-v3-draft",
    approvedBy: null,
    approvedAt: null,
    rationale: "",
    minWilsonLower: {
      contradictionRecall: null,
      contradictionPrecision: null,
      omissionRecall: null,
      omissionPrecision: null,
      exactQuoteMatchRate: null,
      schemaValidRate: null,
    },
    maxWilsonUpper: {
      missedEveryPlantedIssueRate: null,
      inventedFindingRate: null,
    },
    maxLanguageArmGap: null,
    maxTaskTypeArmShortfall: null,
    negativeSubset: { policy: "undecided" },
    maxZeroToleranceViolations: 0,
    minBlindReviewedCases: null,
  };
}

export function judgedThresholdProblems(
  value: unknown,
  requireApproval = true,
): string[] {
  const parsed = judgedThresholdDraftSchema.safeParse(value);
  if (!parsed.success)
    return parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "thresholds"}: ${issue.message}`,
    );
  const set = parsed.data;
  const problems: string[] = [];
  for (const [group, values] of Object.entries({
    minWilsonLower: set.minWilsonLower,
    maxWilsonUpper: set.maxWilsonUpper,
  })) {
    for (const [key, bound] of Object.entries(values))
      if (bound === null) problems.push(`${group}.${key}: no bound selected`);
  }
  for (const key of [
    "maxLanguageArmGap",
    "maxTaskTypeArmShortfall",
    "minBlindReviewedCases",
  ] as const)
    if (set[key] === null) problems.push(`${key}: no value selected`);
  if (set.negativeSubset.policy === "undecided")
    problems.push("negativeSubset: no policy selected");
  if (
    set.negativeSubset.policy === "gate" &&
    set.negativeSubset.maxWilsonUpper === null
  )
    problems.push("negativeSubset: no ceiling selected");
  if (requireApproval && (!set.approvedBy || !set.approvedAt))
    problems.push("thresholds are unsigned; a draft cannot approve a run");
  return problems;
}
