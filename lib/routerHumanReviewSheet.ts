/**
 * Turning a drawn sample into sheets a person can grade blind.
 *
 * ## What a reviewer is given
 *
 * The question, two answers, the order the model judge saw them in, and the
 * rubric. Nothing else. Everything a reviewer could use to guess who wrote an
 * answer is absent by construction rather than by redaction: `SheetItem` has
 * no field for a model id, a provider, an arm, a routing reason, a verdict, a
 * score, a cost, a latency or a generation time, so a sheet cannot carry one
 * even if a caller wanted it to. `sheetBlindnessProblems` re-checks the
 * rendered text anyway, because the type says nothing about what a caller put
 * inside the answer strings.
 *
 * ## Why the answer order is not re-randomized
 *
 * The bundle fixed which answer is A. Re-drawing that per reviewer would make
 * the humans and the model judge grade different presentations, and position
 * effects are exactly one of the things this comparison is meant to expose. So
 * A is the bundle's `first`, always. What is shuffled is the order the items
 * appear in, and that is per reviewer, so two reviewers cannot compare notes
 * by item number.
 *
 * ## The key
 *
 * Which `itemId` was which pair, and which side was which arm, lives in a
 * separate object that is not part of a sheet. Keeping it in one file with the
 * sheets would make handing out the wrong file the only thing standing between
 * this and an unblinded review.
 */

import {
    JUDGE_CRITERIA_LINE,
    JUDGE_EQUIVALENT_LINE,
    JUDGE_RUBRIC_CRITERIA,
    JUDGE_TASK_LINE,
    JUDGE_TEMPLATE_VERSION,
    JUDGE_VERDICT_WORDS,
    identityDisclosures,
    selfIdentificationMarkers,
} from "./routerJudgeRubric";
import { canonicalIdentity, sha256 } from "./routerAnswerBundle";
import type { AnswerBundle, AnswerBundleEntry } from "./routerAnswerBundle";
import { HUMAN_REVIEWERS_PER_PAIR, effectiveSample } from "./routerHumanReviewSample";
import type { HumanSampleManifest } from "./routerHumanReviewSample";

export const HUMAN_REVIEW_SHEET_VERSION = "router-human-review-sheet-v1";

/**
 * Field names that would unblind a sheet if one ever appeared in it.
 *
 * The type already forbids them. This list exists so that widening the type
 * later breaks a test instead of quietly shipping a sheet that names the
 * model, or dates it precisely enough to guess.
 */
export const FORBIDDEN_SHEET_KEYS: readonly string[] = [
    "modelId",
    "provider",
    "apiModel",
    "arm",
    "routerReason",
    "routerDecision",
    "verdict",
    "score",
    "costUsd",
    "latencyMs",
    "ttftMs",
    "usage",
    "generatedAt",
    "digest",
    "stratum",
    "cell",
    "pairId",
];

/** One question and two answers, in the order the model judge saw them. */
export type SheetItem = {
    /** Opaque and per reviewer. Not the pairId, which would index the run record. */
    itemId: string;
    question: string;
    answerA: string;
    answerB: string;
};

export type ReviewSheet = {
    sheetVersion: typeof HUMAN_REVIEW_SHEET_VERSION;
    reviewerId: string;
    /** So a submission can be tied to the draw it came from. */
    populationDigest: string;
    judgeTemplateVersion: string;
    rubric: {
        task: string;
        criteriaLine: string;
        criteria: readonly string[];
        verdictWords: readonly string[];
        equivalentLine: string;
    };
    items: readonly SheetItem[];
};

/** Retained, never handed out. What a sheet deliberately does not say. */
export type SheetKeyRow = {
    reviewerId: string;
    itemId: string;
    pairId: string;
    cell: string;
    /** Which arm was shown as A, and therefore what "FIRST" means for this item. */
    aArm: "auto" | "baseline";
    bArm: "auto" | "baseline";
    aDigest: string;
    bDigest: string;
};

export type ReviewPackage = {
    sheetVersion: typeof HUMAN_REVIEW_SHEET_VERSION;
    populationDigest: string;
    builtAt: string;
    builtBy: string;
    sheets: readonly ReviewSheet[];
    key: readonly SheetKeyRow[];
    /**
     * Answers that name their own author, which the run should already have
     * excluded. Reported rather than scrubbed: a scrub changes the answer the
     * reviewer grades, and a pair that reaches here is a hole in the run's own
     * exclusion check at docs/ops/tomverse-chat-router-evaluation-set.md §5
     * that a person needs to see before sheets go out.
     */
    disclosures: readonly { pairId: string; side: "A" | "B"; markers: readonly string[] }[];
};

/**
 * An opaque per-reviewer label for a pair.
 *
 * Derived rather than counted, so regenerating a package gives the same
 * labels, and one reviewer's item numbers say nothing about another's.
 */
export const sheetItemId = (input: { reviewerId: string; seed: number; pairId: string }): string =>
    sha256(`${HUMAN_REVIEW_SHEET_VERSION}|${input.reviewerId}|${input.seed}|${input.pairId}`)
        .replace("sha256:", "")
        .slice(0, 12);

const orderedByLabel = (rows: readonly SheetKeyRow[]): readonly SheetKeyRow[] =>
    [...rows].sort((left, right) => (left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0));

/**
 * Build the sheets and the key for one drawn sample.
 *
 * Throws rather than returning a half-built package: a sheet missing an item,
 * or built over a bundle the manifest was not drawn from, is not something a
 * caller should be able to hand to a person by ignoring a return value.
 */
export const buildReviewPackage = (input: {
    manifest: HumanSampleManifest;
    bundle: AnswerBundle;
    reviewerIds: readonly string[];
    builtAt: string;
    builtBy: string;
    /**
     * Catalogue ids, for the disclosure re-check at
     * docs/ops/tomverse-chat-router-evaluation-set.md §5. Passed in, not imported.
     */
    routableModelIds: readonly string[];
}): ReviewPackage => {
    const { manifest, bundle } = input;
    if (input.reviewerIds.length !== HUMAN_REVIEWERS_PER_PAIR) {
        throw new Error(
            `the draw fixed ${HUMAN_REVIEWERS_PER_PAIR} reviewers per pair, so ${HUMAN_REVIEWERS_PER_PAIR} ` +
                `reviewer ids are needed, not ${input.reviewerIds.length}`
        );
    }
    if (new Set(input.reviewerIds).size !== input.reviewerIds.length) {
        throw new Error("two sheets cannot go to the same reviewer: the second review would not be independent");
    }
    if (manifest.judgeTemplateVersion !== JUDGE_TEMPLATE_VERSION) {
        throw new Error(
            `the sample was drawn against rubric ${manifest.judgeTemplateVersion}, but this build would ` +
                `render ${JUDGE_TEMPLATE_VERSION}. Two graders on two rubrics do not measure agreement.`
        );
    }

    const byPairId = new Map<string, AnswerBundleEntry>(bundle.entries.map((entry) => [entry.pairId, entry]));
    const pairIds = effectiveSample(manifest);

    const markers = selfIdentificationMarkers(input.routableModelIds);
    const disclosures: { pairId: string; side: "A" | "B"; markers: readonly string[] }[] = [];
    const key: SheetKeyRow[] = [];
    const sheets: ReviewSheet[] = [];

    for (const reviewerId of input.reviewerIds) {
        const rows: SheetKeyRow[] = [];
        for (const pairId of pairIds) {
            const entry = byPairId.get(pairId);
            if (!entry) {
                throw new Error(`${pairId} is in the sample but not in the bundle, so no sheet can be built for it`);
            }
            rows.push({
                reviewerId,
                itemId: sheetItemId({ reviewerId, seed: manifest.seed, pairId }),
                pairId,
                cell: `${entry.stratum}/${entry.cell}`,
                aArm: entry.first.arm,
                bArm: entry.second.arm,
                aDigest: entry.first.digest,
                bDigest: entry.second.digest,
            });
        }
        // Sorting by the opaque label is the shuffle: it is a hash of the
        // reviewer and the pair, so each reviewer gets a different order and
        // neither order tracks the bundle's.
        const ordered = orderedByLabel(rows);
        key.push(...ordered);
        sheets.push({
            sheetVersion: HUMAN_REVIEW_SHEET_VERSION,
            reviewerId,
            populationDigest: manifest.populationDigest,
            judgeTemplateVersion: JUDGE_TEMPLATE_VERSION,
            rubric: {
                task: JUDGE_TASK_LINE,
                criteriaLine: JUDGE_CRITERIA_LINE,
                criteria: JUDGE_RUBRIC_CRITERIA,
                verdictWords: JUDGE_VERDICT_WORDS,
                equivalentLine: JUDGE_EQUIVALENT_LINE,
            },
            items: ordered.map((row) => {
                const entry = byPairId.get(row.pairId) as AnswerBundleEntry;
                return {
                    itemId: row.itemId,
                    question: entry.prompt,
                    answerA: entry.first.text,
                    answerB: entry.second.text,
                };
            }),
        });
    }

    for (const pairId of pairIds) {
        const entry = byPairId.get(pairId) as AnswerBundleEntry;
        for (const [side, answer] of [["A", entry.first], ["B", entry.second]] as const) {
            const found = identityDisclosures(answer.text, markers);
            if (found.length > 0) disclosures.push({ pairId, side, markers: found });
        }
    }

    return {
        sheetVersion: HUMAN_REVIEW_SHEET_VERSION,
        populationDigest: manifest.populationDigest,
        builtAt: input.builtAt,
        builtBy: input.builtBy,
        sheets,
        key,
        disclosures,
    };
};

const walkKeys = (value: unknown, visit: (key: string) => void): void => {
    if (Array.isArray(value)) {
        for (const element of value) walkKeys(element, visit);
        return;
    }
    if (value && typeof value === "object") {
        for (const [key, nested] of Object.entries(value)) {
            visit(key);
            walkKeys(nested, visit);
        }
    }
};

/**
 * Everything about a sheet that would let a reviewer guess the author.
 *
 * Empty means it can be handed out. Two things are checked: no field that
 * names a model, an arm, a cost, a latency or a time, and no answer text that
 * names one of the bundle's models outright. The second is the same rule the
 * run applies at docs/ops/tomverse-chat-router-evaluation-set.md §5; it is
 * repeated here because a sheet is the last point at which it can still be
 * caught.
 */
export const sheetBlindnessProblems = (
    sheet: ReviewSheet,
    bundle: AnswerBundle
): readonly string[] => {
    const problems: string[] = [];
    const forbidden = new Set(FORBIDDEN_SHEET_KEYS);
    walkKeys(sheet.items, (key) => {
        if (forbidden.has(key)) problems.push(`a sheet item carries "${key}", which names or dates the model`);
    });

    const identities = new Set<string>();
    for (const entry of bundle.entries) {
        for (const answer of [entry.first, entry.second]) {
            identities.add(answer.modelId);
            identities.add(answer.provider);
            identities.add(answer.apiModel);
            identities.add(canonicalIdentity(answer));
        }
    }
    // The answers only. A question that mentions a provider is the same
    // question under both answers and identifies neither author, so flagging
    // it would block a sheet over a word the reviewer was always going to see.
    const rendered = JSON.stringify(
        sheet.items.map((item) => [item.answerA, item.answerB])
    ).toLowerCase();
    for (const identity of identities) {
        if (identity && rendered.includes(identity.toLowerCase())) {
            problems.push(`an answer on the sheet contains "${identity}", which names a model in the bundle`);
        }
    }

    if (sheet.judgeTemplateVersion !== JUDGE_TEMPLATE_VERSION) {
        problems.push(
            `the sheet renders rubric ${sheet.judgeTemplateVersion}, not the ${JUDGE_TEMPLATE_VERSION} the judges used`
        );
    }
    if (new Set(sheet.items.map((item) => item.itemId)).size !== sheet.items.length) {
        problems.push("two items share an itemId, so their verdicts could not be told apart");
    }
    return [...new Set(problems)];
};

/**
 * Why two sheets are not independent. Empty means they are.
 *
 * Same items, different order, different labels. Sharing an order would let
 * two reviewers compare "number 7"; sharing labels would do the same across
 * files; holding different items would stop them from being two reviews of one
 * sample at all.
 */
export const sheetIndependenceProblems = (sheets: readonly ReviewSheet[]): readonly string[] => {
    const problems: string[] = [];
    if (sheets.length !== HUMAN_REVIEWERS_PER_PAIR) {
        problems.push(`${sheets.length} sheet(s) were built, not ${HUMAN_REVIEWERS_PER_PAIR}`);
        return problems;
    }
    const [left, right] = sheets;
    const questions = (sheet: ReviewSheet) => [...sheet.items.map((item) => item.question)].sort();
    if (JSON.stringify(questions(left)) !== JSON.stringify(questions(right))) {
        problems.push("the two sheets do not hold the same items");
    }
    if (
        left.items.length === right.items.length &&
        left.items.every((item, index) => item.question === right.items[index]?.question)
    ) {
        problems.push("both sheets present the items in the same order");
    }
    const shared = left.items.filter((item) => right.items.some((other) => other.itemId === item.itemId));
    if (shared.length > 0) {
        problems.push(`${shared.length} itemId(s) appear on both sheets, so a label identifies the same pair to both`);
    }
    return problems;
};

/** The sheet as the document a reviewer actually reads. */
export const renderSheetMarkdown = (sheet: ReviewSheet): string => {
    const lines: string[] = [
        `# Review sheet — ${sheet.reviewerId}`,
        "",
        sheet.rubric.task,
        "",
        sheet.rubric.criteriaLine,
        "",
        ...sheet.rubric.criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
        "",
        `For each item, write exactly one word: ${sheet.rubric.verdictWords.map((word) => `**${word}**`).join(", ")}.`,
        "",
        sheet.rubric.equivalentLine,
        "",
        "You are not told which system wrote either answer, and no one reviewing with you sees the",
        "items in this order. Grade each item on its own; do not go back and even them out.",
        "",
        `Sheet ${sheet.sheetVersion}, rubric ${sheet.judgeTemplateVersion}, population ${sheet.populationDigest}.`,
        "",
    ];
    sheet.items.forEach((item, index) => {
        lines.push(
            "---",
            "",
            `## ${index + 1}. Item \`${item.itemId}\``,
            "",
            "### Question",
            "",
            item.question,
            "",
            "### Answer A",
            "",
            item.answerA,
            "",
            "### Answer B",
            "",
            item.answerB,
            "",
            "### Your verdict",
            "",
            `\`${item.itemId}\`: ______________  (${sheet.rubric.verdictWords.join(" / ")})`,
            ""
        );
    });
    return lines.join("\n");
};
