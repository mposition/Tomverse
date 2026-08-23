/**
 * Near-duplicate detection over memory-eval cases
 * (docs/ops/memory-extraction-eval-dataset.md §6.5).
 *
 * `findDuplicateCases()` catches only byte-identical conversations. §3.1 says
 * what that leaves uncaught — "같은 틀에 단어만 바꾼 200개는 200개가 아니라
 * 1개입니다" — and hands the judgement to the reviewer. This ranks where to
 * look so that judgement is over a shortlist rather than every pair.
 *
 * **Advisory.** Nothing here passes or fails a dataset. A high score is a
 * place to look; diversity remains the reviewer's call (§6.5).
 */

import type { MemoryEvalCase } from "@/lib/memoryExtractionEvalCore";

export type NearDuplicatePair = {
    a: string;
    b: string;
    cell: string;
    /** Jaccard over word tokens: catches a copy with synonyms swapped. */
    token: number;
    /** Jaccard over the grammatical skeleton: catches template reuse. */
    shape: number;
};

const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
    if (a.size === 0 && b.size === 0) return 1;
    let shared = 0;
    for (const item of a) if (b.has(item)) shared += 1;
    return shared / (a.size + b.size - shared);
};

export function tokenFeatures(testCase: MemoryEvalCase): Set<string> {
    const body = testCase.conversations
        .flatMap((conversation) =>
            conversation.messages.map((message) => message.content)
        )
        .join("\n");
    return new Set(
        body
            .normalize("NFC")
            .toLowerCase()
            .split(/[^\p{L}\p{N}]+/u)
            .filter(Boolean)
    );
}

/**
 * The grammatical skeleton, as ordered bigrams over per-token features.
 *
 * A first version collapsed every Hangul run to one placeholder. It scored
 * 1.00 on almost every pair in the seed set, including pairs sharing nothing:
 * a signal that is constant is not a signal, and it would have sent the
 * reviewer to look at noise. This keeps the part that carries the template
 * rather than the content.
 *
 *   * Korean attaches the particle and ending to the END of a word, so a
 *     token's last two characters say more about sentence shape than its stem.
 *   * A length bucket separates "네" from "말씀드리겠습니다" without pinning an
 *     exact length.
 *   * Features are ADJACENT PAIRS, so word order counts. A bag of endings
 *     would call every polite Korean sentence identical.
 *   * Turn count and the user/assistant sequence are features of their own:
 *     reusing a two-turn call-and-response frame is itself the repetition
 *     §3.1 is about.
 */
export function shapeFeatures(testCase: MemoryEvalCase): Set<string> {
    const features: string[] = [];
    for (const conversation of testCase.conversations) {
        features.push(
            `turns:${conversation.messages.length}`,
            `roles:${conversation.messages.map((message) => message.role[0]).join("")}`
        );
        for (const message of conversation.messages) {
            const words = message.content
                .normalize("NFC")
                .split(/\s+/)
                .filter(Boolean)
                .map((word) => {
                    const bucket =
                        word.length <= 2 ? "s" : word.length <= 5 ? "m" : "l";
                    return `${word.slice(-2)}|${bucket}`;
                });
            for (let index = 0; index < words.length - 1; index += 1) {
                features.push(`${words[index]}>${words[index + 1]}`);
            }
        }
    }
    return new Set(features);
}

/**
 * Every within-cell pair, most similar first.
 *
 * Cross-cell pairs are excluded: two cells are meant to differ, so their
 * similarity says nothing about the repetition §3.1 forbids.
 */
export function nearDuplicatePairs(
    cases: readonly MemoryEvalCase[]
): NearDuplicatePair[] {
    const prepared = cases.map((testCase) => ({
        id: testCase.id,
        cell: `${testCase.category}:${testCase.language}`,
        token: tokenFeatures(testCase),
        shape: shapeFeatures(testCase),
    }));
    const pairs: NearDuplicatePair[] = [];
    for (let i = 0; i < prepared.length; i += 1) {
        for (let j = i + 1; j < prepared.length; j += 1) {
            if (prepared[i].cell !== prepared[j].cell) continue;
            pairs.push({
                a: prepared[i].id,
                b: prepared[j].id,
                cell: prepared[i].cell,
                token: jaccard(prepared[i].token, prepared[j].token),
                shape: jaccard(prepared[i].shape, prepared[j].shape),
            });
        }
    }
    pairs.sort(
        (x, y) => Math.max(y.token, y.shape) - Math.max(x.token, x.shape)
    );
    return pairs;
}
