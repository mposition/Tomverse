/**
 * Ranking where a reviewer should look for "the same item with the words
 * swapped", over any corpus of short texts.
 *
 * This is the arithmetic that `lib/memoryEvalNearDuplicates.ts` was written
 * for and that the Router evaluation set needs too. It lives on its own
 * because the two datasets share the question -- *did the drafter reuse a
 * template?* -- while sharing nothing about their shape: a memory case is a
 * conversation, a Router item is one prompt. Copying the scoring into a second
 * file would let the two drift, and a diversity signal that means different
 * things in different datasets is worse than one signal or none.
 *
 * **Advisory everywhere it is used.** Nothing here passes or fails a dataset.
 * A high score is a place to look; diversity remains the reviewer's call.
 */

export type NearDuplicateRecord = {
    id: string;
    /** Pairs are only compared inside a cell; see `rankNearDuplicates`. */
    cell: string;
    /** The text of the item, split into the segments it was written in. */
    segments: readonly string[];
    /**
     * Shape features the caller knows about and this file cannot see -- a
     * conversation's turn count, say. Folded in beside the derived ones.
     */
    extraShapeFeatures?: readonly string[];
};

export type NearDuplicatePairing = {
    a: string;
    b: string;
    cell: string;
    /** Jaccard over word tokens: catches a copy with synonyms swapped. */
    token: number;
    /** Jaccard over the grammatical skeleton: catches template reuse. */
    shape: number;
};

export const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
    if (a.size === 0 && b.size === 0) return 1;
    let shared = 0;
    for (const item of a) if (b.has(item)) shared += 1;
    return shared / (a.size + b.size - shared);
};

/** Every word in the text, case-folded, punctuation dropped. */
export function textTokenFeatures(segments: readonly string[]): Set<string> {
    return new Set(
        segments
            .join("\n")
            .normalize("NFC")
            .toLowerCase()
            .split(/[^\p{L}\p{N}]+/u)
            .filter(Boolean)
    );
}

/**
 * The grammatical skeleton, as ordered bigrams over per-word features.
 *
 * An earlier version of this collapsed every Hangul run to one placeholder. It
 * scored 1.00 on almost every pair, including pairs sharing nothing: a signal
 * that is constant is not a signal, and it sent the reviewer to look at noise.
 * What survives keeps the part that carries the template rather than the
 * content.
 *
 *   * Korean attaches the particle and ending to the END of a word, so a
 *     word's last two characters say more about sentence shape than its stem.
 *   * A length bucket separates "네" from "말씀드리겠습니다" without pinning an
 *     exact length.
 *   * Features are ADJACENT PAIRS, so word order counts. A bag of endings
 *     would call every polite Korean sentence identical.
 */
export function textShapeFeatures(
    segments: readonly string[],
    extra: readonly string[] = []
): Set<string> {
    const features: string[] = [...extra];
    for (const segment of segments) {
        const words = segment
            .normalize("NFC")
            .split(/\s+/)
            .filter(Boolean)
            .map((word) => {
                const bucket = word.length <= 2 ? "s" : word.length <= 5 ? "m" : "l";
                return `${word.slice(-2)}|${bucket}`;
            });
        for (let index = 0; index < words.length - 1; index += 1) {
            features.push(`${words[index]}>${words[index + 1]}`);
        }
    }
    return new Set(features);
}

/**
 * Every within-cell pair, most similar first.
 *
 * Cross-cell pairs are excluded: two cells are meant to differ, so their
 * similarity says nothing about the repetition the check is about.
 */
export function rankNearDuplicates(
    records: readonly NearDuplicateRecord[]
): NearDuplicatePairing[] {
    const prepared = records.map((record) => ({
        id: record.id,
        cell: record.cell,
        token: textTokenFeatures(record.segments),
        shape: textShapeFeatures(record.segments, record.extraShapeFeatures ?? []),
    }));
    const pairs: NearDuplicatePairing[] = [];
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
    pairs.sort((x, y) => Math.max(y.token, y.shape) - Math.max(x.token, x.shape));
    return pairs;
}
