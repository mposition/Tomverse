import {
    ASSISTANT_PACKAGE_IMPORT_STEPS,
    type AssistantPackageImportStep,
} from "@/lib/assistantPackageImportWizard";

/**
 * What the package import's four events add up to (Slice 7).
 *
 * docs/policy/assistant-package-import.md §9.
 *
 * The events are content-free by schema, and so is everything here: a step
 * name, a warning kind, and what the parser read a package as. There is
 * nothing in this file that could carry an instruction, a filename or a
 * digest, because there is nothing in the events that could.
 *
 * Separate from the query in `lib/assistantPackageImportMetrics.ts` because
 * that one is server-only and this is the part worth testing: an unrecognised
 * value being dropped rather than shown, and every step appearing whether or
 * not anybody reached it.
 *
 * ## Why `entered` and `abandoned` do not reconcile
 *
 * A browser closing is not observable, so `abandoned` is a floor rather than
 * the real drop-off. The number worth reading is the difference between
 * consecutive steps' `entered` counts -- which is why the steps are reported
 * in wizard order and always all eight, including the ones nobody reached.
 * A step missing from the table would look like a step that does not exist.
 */

export const PACKAGE_IMPORT_WARNING_KINDS = [
    "package_refused",
    "secret_finding",
    "scripts_skipped",
    "documents_over_limit",
    "license_absent",
    "relative_links",
    "document_unreadable",
] as const;

export type PackageImportWarningKind =
    (typeof PACKAGE_IMPORT_WARNING_KINDS)[number];

export const PACKAGE_IMPORT_SOURCES = ["agent-skill", "tomverse-native"] as const;

export type PackageImportSource = (typeof PACKAGE_IMPORT_SOURCES)[number];

export type PackageImportMetrics = {
    windowDays: number;
    steps: { step: AssistantPackageImportStep; entered: number; abandoned: number }[];
    warnings: { kind: PackageImportWarningKind; count: number }[];
    completed: { source: PackageImportSource; count: number }[];
    completedTotal: number;
};

/** One analytics row, reduced to what this reads. */
export type PackageImportEventRow = {
    eventName: string;
    properties: unknown;
};

const readProperty = (properties: unknown, key: string): string | null => {
    if (typeof properties !== "object" || properties === null) return null;
    const value = (properties as Record<string, unknown>)[key];
    return typeof value === "string" ? value : null;
};

/**
 * The counts, from rows.
 *
 * Pure, and separate from the query so the interesting part -- that an
 * unrecognised value is dropped rather than shown, and that every step appears
 * whether or not anybody reached it -- is testable without a database. An
 * unrecognised value is dropped because the enums here are the closed lists
 * the events are validated against: a row carrying something else is a row
 * from a version of the app that no longer exists, and inventing a bucket for
 * it would put a label on a dashboard that nothing in the code can explain.
 */
export function summarizePackageImportEvents(
    rows: readonly PackageImportEventRow[]
): Omit<PackageImportMetrics, "windowDays"> {
    const entered = new Map<string, number>();
    const abandoned = new Map<string, number>();
    const warnings = new Map<string, number>();
    const completed = new Map<string, number>();

    const bump = (map: Map<string, number>, key: string | null, allowed: readonly string[]) => {
        if (key === null || !allowed.includes(key)) return;
        map.set(key, (map.get(key) ?? 0) + 1);
    };

    for (const row of rows) {
        switch (row.eventName) {
            case "assistant_package_import_step_entered":
                bump(
                    entered,
                    readProperty(row.properties, "package_import_step"),
                    ASSISTANT_PACKAGE_IMPORT_STEPS
                );
                break;
            case "assistant_package_import_step_abandoned":
                bump(
                    abandoned,
                    readProperty(row.properties, "package_import_step"),
                    ASSISTANT_PACKAGE_IMPORT_STEPS
                );
                break;
            case "assistant_package_import_warning":
                bump(
                    warnings,
                    readProperty(row.properties, "package_import_warning"),
                    PACKAGE_IMPORT_WARNING_KINDS
                );
                break;
            case "assistant_package_import_completed":
                bump(
                    completed,
                    readProperty(row.properties, "package_import_source"),
                    PACKAGE_IMPORT_SOURCES
                );
                break;
            default:
                break;
        }
    }

    return {
        steps: ASSISTANT_PACKAGE_IMPORT_STEPS.map((step) => ({
            step,
            entered: entered.get(step) ?? 0,
            abandoned: abandoned.get(step) ?? 0,
        })),
        // Sorted by count because the question here is "what do the packages
        // people bring actually contain", and the answer is read off the top
        // of the list rather than looked up by name.
        warnings: PACKAGE_IMPORT_WARNING_KINDS.map((kind) => ({
            kind,
            count: warnings.get(kind) ?? 0,
        })).sort((left, right) => right.count - left.count),
        completed: PACKAGE_IMPORT_SOURCES.map((source) => ({
            source,
            count: completed.get(source) ?? 0,
        })),
        completedTotal: [...completed.values()].reduce((sum, count) => sum + count, 0),
    };
}
