/**
 * The one place schema 1 and schema 2 meet.
 *
 * docs/policy/external-conversation-import-and-memory.md §12.2, as amended by
 * `.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md` §6.
 *
 * `mem-eval-seed-11` is frozen, was run twice against `mem-extract-v2`, and
 * produced the diagnostics that led to the amendment. Those runs are worth
 * reproducing, so the dataset stays readable — but it predates
 * `expectedDisposition` and `goldCompleteness`, which means it cannot answer
 * either of the questions the new scorer asks.
 *
 * ## The boundary
 *
 * This module reproduces past diagnostics. It is NOT a migration:
 *
 *   * it never invents `expectedDisposition`. There is no `bulk_safe`
 *     fallback here or anywhere else, because a missing disposition read as
 *     bulk-safe is an authoring slip resolved in the most dangerous
 *     direction;
 *   * it never invents `goldCompleteness`. Whether `durable-en-1`'s gold was
 *     complete is a question about a judgement nobody made in that dataset,
 *     and guessing "exhaustive" would turn correct extra extractions into
 *     false positives — the exact defect the amendment exists to fix;
 *   * it refuses to hand the legacy set to anything that decides something.
 *     A verdict, a freeze, or a register pair approval computed against a
 *     dataset whose scoring contract has been superseded would be a number
 *     with nothing behind it.
 *
 * A successor case carries every value explicitly. If a field is blank, the
 * answer is to write it, not to read it from here.
 */

import { MEMORY_EVAL_DATASET_SCHEMA_VERSION } from "@/lib/memoryEvalDatasetSchema";

/**
 * Dataset versions readable through this module, and nothing else.
 *
 * Pinned by name rather than by "anything without the new fields": an
 * open-ended legacy path is how a half-authored successor ends up being read
 * as a legacy set and scored anyway.
 */
export const LEGACY_DIAGNOSTIC_DATASET_VERSIONS: readonly string[] = [
    "mem-eval-seed-11",
];

/** The schema those versions are written in. */
export const LEGACY_DATASET_SCHEMA_VERSION = 1;

/**
 * What a caller wants the dataset for.
 *
 * `diagnostic` is the only use the legacy set is admitted for. The other
 * three all end in something being decided or fixed, and each of them was
 * defined on top of the scoring contract that the 2026-08-25 amendment
 * replaced.
 */
export type DatasetUse =
    | "diagnostic"
    | "decision_grade"
    | "freeze"
    | "pair_approval";

export type LegacyDatasetRefusal = {
    reason: "legacy_dataset_schema";
    datasetVersion: string;
    use: DatasetUse;
    detail: string;
};

/**
 * Whether this dataset may be used this way. `null` means yes.
 *
 * Fail-closed on the schema version rather than on the version string: a
 * dataset that does not declare schema 2 is refused for everything except a
 * diagnostic, including a version nobody has heard of. The alternative —
 * listing the versions that are forbidden — can only ever name the ones that
 * already exist.
 */
export function legacyDatasetRefusal(input: {
    datasetVersion: string;
    schemaVersion: number;
    use: DatasetUse;
}): LegacyDatasetRefusal | null {
    if (input.schemaVersion === MEMORY_EVAL_DATASET_SCHEMA_VERSION) return null;
    if (input.use === "diagnostic") return null;
    return {
        reason: "legacy_dataset_schema",
        datasetVersion: input.datasetVersion,
        use: input.use,
        detail:
            `${input.datasetVersion} is schema ${input.schemaVersion}; ` +
            `${input.use} requires schema ${MEMORY_EVAL_DATASET_SCHEMA_VERSION}. ` +
            "It has no expectedDisposition and no goldCompleteness, and this " +
            "module does not supply either.",
    };
}

/**
 * Reads the frozen legacy cases, for reproducing a past diagnostic run.
 *
 * Returns the cases exactly as the frozen file holds them — schema 1, no
 * added fields. The import is dynamic so that a schema-2 caller that never
 * takes this branch does not pull 1,150 legacy cases into its module graph.
 */
export async function readLegacyDatasetForDiagnostics(
    datasetVersion: string
): Promise<{
    schemaVersion: number;
    cases: readonly unknown[];
}> {
    if (!LEGACY_DIAGNOSTIC_DATASET_VERSIONS.includes(datasetVersion)) {
        throw new Error(
            `${datasetVersion} is not a pinned legacy diagnostic dataset. ` +
                `Pinned: ${LEGACY_DIAGNOSTIC_DATASET_VERSIONS.join(", ")}.`
        );
    }
    const fixtures = await import("@/lib/memoryExtractionEvalFixtures");
    if (fixtures.MEMORY_EVAL_DATASET_VERSION !== datasetVersion) {
        throw new Error(
            `the frozen fixtures are ${fixtures.MEMORY_EVAL_DATASET_VERSION}, ` +
                `not ${datasetVersion}.`
        );
    }
    return {
        schemaVersion: LEGACY_DATASET_SCHEMA_VERSION,
        cases: fixtures.MEMORY_EVAL_CASES,
    };
}
