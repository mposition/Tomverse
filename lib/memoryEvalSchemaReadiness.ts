/**
 * Which consumers of an eval artifact can read schema 3, and which cannot.
 *
 * ## Why this exists
 *
 * `decideEvalRunMode()` refuses a live run against any dataset schema it is
 * not pinned to, and the pin is currently 2 while the harness scores schema
 * 3. That is deliberate — the 2026-08-28 approval says the block is held
 * until every consumer is converted — but "until every consumer is converted"
 * is a claim somebody has to be able to check. Held as a comment it is a
 * memory; held here it is a list with a state per row.
 *
 * The rows are written by hand, and that is the point. Deriving them by
 * scanning imports would report that a file mentions the schema-3 scorer, not
 * that it reads a schema-3 artifact correctly — and the second is the only
 * question worth asking. Each row names the evidence for its own claim.
 *
 * ## What flipping the gate is, and is not
 *
 * Moving `MEMORY_EVAL_DATASET_SCHEMA_VERSION` is its own reviewed change,
 * taken when this report is clean. It opens nothing by itself: a live run
 * still needs the budget approval of
 * docs/policy/external-conversation-import-and-memory.md §12.5, which names
 * the pair, both digests, the run count and the ceiling. This module makes the
 * first of those two steps checkable and says nothing about the second.
 */

export type SchemaReadinessState =
    /** Reads a schema-3 artifact, and something fails if it stops. */
    | "converted"
    /** Cannot read one yet. Named with what it still needs. */
    | "pending"
    /** Reads schema 1 or 2 only, by design, and always will. */
    | "historical_only";

export type SchemaReadinessRow = {
    /** The file, as a repository path. */
    consumer: string;
    state: SchemaReadinessState;
    /** What it does with an artifact, in one line. */
    role: string;
    /**
     * Why the state is what it says: the test that would fail, or the work
     * that is left. Never "looks fine" — a row nobody can check is a row that
     * will be wrong later and nobody will notice.
     */
    evidence: string;
};

export const MEMORY_EVAL_SCHEMA3_CONSUMERS: readonly SchemaReadinessRow[] = [
    {
        consumer: "lib/memoryEvalScoringV3.ts",
        state: "converted",
        role: "Scores a schema-3 case: polarity as a field, evidence bound against the source conversation.",
        evidence:
            "tests/memoryEvalScoringV3.test.mjs — polarity, binding, the safety asymmetry and the critical-case admission.",
    },
    {
        consumer: "lib/memoryEvalDatasetRegistry.ts",
        state: "converted",
        role: "Resolves an artifact to the dataset it was scored against, or refuses by name.",
        evidence:
            "tests/memoryEvalDatasetRegistrySchema3.test.mjs — resolution plus the four refusals, and the schema-1/2 path unchanged.",
    },
    {
        consumer: "lib/memoryEvalHarnessTarget.ts",
        state: "converted",
        role: "Resolves cases, scorer, fingerprint and both digests as one object; throws on an unknown schema.",
        evidence:
            "tests/memoryEvalHarnessTarget.test.mjs — the digests bind to the frozen manifest and an unknown version throws.",
    },
    {
        consumer: "scripts/evalImportedMemoryExtraction.mjs",
        state: "converted",
        role: "Runs the eval and writes the artifact.",
        evidence:
            "tests/memoryEvalSchema3DryRun.test.mjs — a smoke run over the schema-3 set reaches no provider and writes an artifact the registry resolves.",
    },
    {
        consumer: "scripts/report-memory-eval-failures-core.mjs",
        state: "converted",
        role: "Classifies an artifact's records: near misses, critical adoptions, unrecognised candidates.",
        evidence:
            "tests/memoryEvalFailureSummarySchema3.test.mjs — classification uses the schema-3 matchers and names which field differed.",
    },
    {
        consumer: "scripts/make-memory-eval-blind-review.mjs",
        state: "converted",
        role: "Builds the blind qualitative review sheet from an artifact (docs/policy/external-conversation-import-and-memory.md §12.4).",
        evidence:
            "tests/memoryEvalBlindReview.test.mjs — the sheet shows each candidate's polarity and cited span, and still shows no gold.",
    },
    {
        consumer: "scripts/check-memory-eval-run-admissibility.mjs",
        state: "converted",
        role: "Decides whether an artifact may be cited as evidence at all.",
        evidence:
            "tests/memoryEvalRunAdmissibility.test.mjs — admissibility reads the manifest's own fields and is schema-agnostic; a schema-3 artifact is checked by the same rules.",
    },
    {
        consumer: "lib/memoryEvalSucc5.ts",
        state: "converted",
        role: "The contract-only successor: succ-4's cases under the corrected contract, with the invariants that make it one.",
        evidence:
            "tests/memoryEvalSucc5.test.mjs — the sample is byte-identical to succ-4's, the contract is not, and the manifest recomputes.",
    },
    {
        consumer: "lib/memoryEvalLegacyDataset.ts",
        state: "historical_only",
        role: "Reproduces the mem-extract-v2 diagnostics against the frozen schema-1 sample.",
        evidence:
            "By design: it exists to read one superseded dataset, is not a live path, and cannot support a verdict.",
    },
];

/** Rows that still block moving the run-mode gate. */
export function memoryEvalSchema3Blockers(
    rows: readonly SchemaReadinessRow[] = MEMORY_EVAL_SCHEMA3_CONSUMERS
): readonly SchemaReadinessRow[] {
    return rows.filter((row) => row.state === "pending");
}

export type SchemaReadinessSummary = {
    converted: number;
    pending: number;
    historicalOnly: number;
    /** True when nothing is `pending`. Not a licence to run — see the header. */
    gateMayMove: boolean;
};

export function memoryEvalSchema3Readiness(
    rows: readonly SchemaReadinessRow[] = MEMORY_EVAL_SCHEMA3_CONSUMERS
): SchemaReadinessSummary {
    const count = (state: SchemaReadinessState) =>
        rows.filter((row) => row.state === state).length;
    return {
        converted: count("converted"),
        pending: count("pending"),
        historicalOnly: count("historical_only"),
        gateMayMove: count("pending") === 0,
    };
}
