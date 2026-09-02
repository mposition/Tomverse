import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";

/**
 * Fingerprint v4: v3 plus the conversation title.
 *
 * ## Why a new version rather than a fix to v3
 *
 * v3 omits `conversation.title`, and the omission was wrong rather than merely
 * narrow. `renderConversation()` in `lib/memoryExtractionPrompt.ts` writes
 * `## <label>: <title>` into the prompt, so the title is model input. A dataset
 * whose digest ignores it can have its titles rewritten — changing what every
 * model in every run actually reads — while the digest, the freeze, and any
 * budget bound to that digest all report no change.
 *
 * v3 cannot simply be corrected. succ-6 is frozen against it and its manifest
 * pins the resulting digest, so editing v3 would move succ-6's digest and break
 * a signature given in good faith. v3 therefore stays exactly as it is for the
 * datasets already frozen under it, and successors use v4.
 *
 * The alternative — dropping the title from the prompt — was not taken. That
 * changes what the model is asked, and so the prompt digest, which is a prompt
 * decision with its own approval rather than something a dataset module does on
 * the way past.
 *
 * Everything else is v3 verbatim: the same fields in the same order with the
 * same separators, so the two differ by exactly the field that was missing.
 */
export function datasetFingerprintInputV4(
    cases: readonly MemoryEvalCaseV3[]
): string {
    const byId = (a: { id: string }, b: { id: string }) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

    return [...cases]
        .sort(byId)
        .map((testCase) =>
            [
                `id=${testCase.id}`,
                `category=${testCase.category}`,
                `language=${testCase.language}`,
                `completeness=${testCase.goldCompleteness}`,
                `criticalGoldMode=${testCase.criticalGoldMode ?? "-"}`,
                [...testCase.expected]
                    .sort(byId)
                    .map((gold) =>
                        [
                            `gold=${gold.id}`,
                            `kind=${gold.kind}`,
                            `polarity=${gold.polarity}`,
                            `disposition=${gold.expectedDisposition}`,
                            `all=${gold.factValueAll.join("|")}`,
                            gold.factValueAny === undefined
                                ? "any=-"
                                : `any=[${gold.factValueAny.join("|")}]`,
                            `anchorId=${gold.evidence.evidenceMessageId}`,
                            `anchorQuote=${gold.evidence.evidenceQuote}`,
                        ].join("\u0000")
                    )
                    .join("\u0002"),
                testCase.conversations
                    .map((conversation) =>
                        [
                            `conversation=${conversation.externalConversationId}`,
                            // The field v3 was missing, and the reason v4 exists.
                            `title=${conversation.title}`,
                            ...conversation.messages.map(
                                (message) =>
                                    `${message.externalMessageId}:${message.role}:${message.content}`
                            ),
                        ].join("\u0003")
                    )
                    .join("\u0004"),
            ].join("\u0000")
        )
        .join("\u0001");
}

/** Recorded in a manifest, because v3 and v4 hash different things. */
export const MEMORY_EVAL_DATASET_FINGERPRINT_VERSION_V4 = 4;
