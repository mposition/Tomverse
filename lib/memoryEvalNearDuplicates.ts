/**
 * Near-duplicate detection over memory-eval cases
 * (docs/ops/memory-extraction-eval-dataset.md §6.5).
 *
 * `findDuplicateCases()` catches only byte-identical conversations. docs/ops/memory-extraction-eval-dataset.md §3.1 says
 * what that leaves uncaught — "같은 틀에 단어만 바꾼 200개는 200개가 아니라
 * 1개입니다" — and hands the judgement to the reviewer. This ranks where to
 * look so that judgement is over a shortlist rather than every pair.
 *
 * **Advisory.** Nothing here passes or fails a dataset. A high score is a
 * place to look; diversity remains the reviewer's call (docs/ops/memory-extraction-eval-dataset.md §6.5).
 */

import type { MemoryEvalCase } from "@/lib/memoryExtractionEvalCore";
import {
    rankNearDuplicates,
    textShapeFeatures,
    textTokenFeatures,
    type NearDuplicatePairing,
} from "./nearDuplicateText.ts";

/**
 * The scoring lives in `lib/nearDuplicateText.ts`, which the Router evaluation
 * set uses too. What stays here is the part that is about memory cases: how a
 * conversation becomes text, and what its cell is called. Two adapters over
 * one implementation, so a "near-duplicate" never comes to mean two different
 * things in two datasets.
 */
export type NearDuplicatePair = NearDuplicatePairing;

const segmentsOf = (testCase: MemoryEvalCase): string[] =>
    testCase.conversations.flatMap((conversation) =>
        conversation.messages.map((message) => message.content)
    );

/**
 * Turn count and the user/assistant sequence are features of their own:
 * reusing a two-turn call-and-response frame is itself the repetition
 * docs/ops/memory-extraction-eval-dataset.md §3.1 is about, and nothing in the
 * message text records it.
 */
const conversationShapeFeatures = (testCase: MemoryEvalCase): string[] =>
    testCase.conversations.flatMap((conversation) => [
        `turns:${conversation.messages.length}`,
        `roles:${conversation.messages.map((message) => message.role[0]).join("")}`,
    ]);

export function tokenFeatures(testCase: MemoryEvalCase): Set<string> {
    return textTokenFeatures(segmentsOf(testCase));
}

export function shapeFeatures(testCase: MemoryEvalCase): Set<string> {
    return textShapeFeatures(segmentsOf(testCase), conversationShapeFeatures(testCase));
}

export function nearDuplicatePairs(
    cases: readonly MemoryEvalCase[]
): NearDuplicatePair[] {
    return rankNearDuplicates(
        cases.map((testCase) => ({
            id: testCase.id,
            cell: `${testCase.category}:${testCase.language}`,
            segments: segmentsOf(testCase),
            extraShapeFeatures: conversationShapeFeatures(testCase),
        }))
    );
}
