/**
 * Subtype declarations for the succ-7 `assistant_only` replacements.
 *
 * Separate from `ASSISTANT_ONLY_SUBTYPES` on purpose, and the reason is the
 * freeze rather than tidiness. `subtypeTableFingerprintInput()` folds every
 * row of that table into `subtypeTableDigest`, which is pinned inside succ-6's
 * frozen manifest — adding fourteen rows there would move the digest and break
 * the freeze of a dataset these cases have not joined yet.
 *
 * All fourteen are subtype 3, matching the fourteen they replace one for one,
 * so both arms keep their subtype 3/4 composition exactly rather than merely
 * keeping the count above the floor.
 */
export type Succ7SubtypeEntry = {
    /** Subtype 3 (the user corrected it) or 4 (the user supposed it). */
    subtype: 3 | 4;
    /** The clause that decides it. */
    ground: string;
};

export const SUCC7_ASSISTANT_ONLY_SUBTYPES: Readonly<
    Record<string, Succ7SubtypeEntry>
> = {
    "succ-assistant-en-601": { subtype: 3, ground: "I am not a carpenter" },
    "succ-assistant-en-602": {
        subtype: 3,
        ground: "I do not go bowling on Thursdays or any other night",
    },
    "succ-assistant-en-603": { subtype: 3, ground: "I have never kept bees" },
    "succ-assistant-en-604": { subtype: 3, ground: "I do not own a bicycle" },
    "succ-assistant-en-605": {
        subtype: 3,
        ground: "I was not born on the mainland",
    },
    "succ-assistant-en-606": {
        subtype: 3,
        ground: "I am not based at the annexe",
    },
    "succ-assistant-en-607": {
        subtype: 3,
        ground: "I am not a tailor",
    },
    "succ-assistant-en-608": {
        subtype: 3,
        ground: "I have no experience with houseplants at all",
    },
    "succ-assistant-ko-601": { subtype: 3, ground: "저는 원장이 아닙니다" },
    "succ-assistant-ko-602": { subtype: 3, ground: "저는 볼링을 치러 다니지 않습니다" },
    "succ-assistant-ko-603": { subtype: 3, ground: "저희 집 마당에는 잔디가 없습니다" },
    "succ-assistant-ko-604": { subtype: 3, ground: "저는 사범이 아닙니다" },
    "succ-assistant-ko-605": { subtype: 3, ground: "저는 화분을 좋아하지 않습니다" },
    "succ-assistant-ko-606": { subtype: 3, ground: "저는 재단사가 아니고" },
};
