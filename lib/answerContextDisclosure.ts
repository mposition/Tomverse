/**
 * What an answer is allowed to say about the context it was given
 * (import/memory policy §13.4 for memory, §14.3 for profile knowledge).
 *
 * Two facts, one sentence. An answer can carry account memories, profile
 * knowledge excerpts, both, or neither, and the owner is told which — because
 * "3 memories" and "3 knowledge excerpts" are different claims about where
 * their answer came from, and collapsing them into one number would make the
 * disclosure less true than the data behind it.
 *
 * The rule both sections share is that a count is stated only above zero.
 * `null` means the request could not carry that context at all and `0` means
 * it could and nothing was selected; §13.4 forbids indicating either, so both
 * are dropped here rather than rendered as "0 used". The server enforces the
 * same threshold on the wire — the header and the owner's conversation read
 * both omit the field below one — so this is the second of two agreeing
 * gates, not the only one.
 *
 * `knowledgeChunkCount` is named for what the server can observe: excerpts
 * placed in the prompt. Whether the model drew on them is not knowable here,
 * and copy that implied it would claim more than the number supports. The
 * same is true of memory, whose column has carried the weaker name since it
 * was added.
 *
 * Pure, so the whole matrix is testable without a browser
 * (tests/answerContextDisclosure.test.mjs).
 */

export type AnswerContextPartKind = "memory" | "knowledge";

export type AnswerContextPart = {
    kind: AnswerContextPartKind;
    count: number;
};

export type AnswerContextDisclosure =
    | { shown: false }
    | { shown: true; parts: AnswerContextPart[] };

const HIDDEN: AnswerContextDisclosure = { shown: false };

/** A count worth stating: a whole number of things, at least one. */
const statable = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function decideAnswerContextDisclosure(input: {
    /** §13.4. Absent/null/0 all mean "say nothing about memory". */
    memoryUsedCount?: number | null;
    /** §14.3. Same three readings, same answer. */
    knowledgeChunkCount?: number | null;
}): AnswerContextDisclosure {
    const parts: AnswerContextPart[] = [];
    // Memory first wherever both appear, matching the order the §9.1 system
    // block assembles them in, so the sentence reads in the order the prompt
    // was built.
    if (statable(input.memoryUsedCount)) {
        parts.push({ kind: "memory", count: input.memoryUsedCount });
    }
    if (statable(input.knowledgeChunkCount)) {
        parts.push({ kind: "knowledge", count: input.knowledgeChunkCount });
    }
    if (parts.length === 0) return HIDDEN;
    return { shown: true, parts };
}
