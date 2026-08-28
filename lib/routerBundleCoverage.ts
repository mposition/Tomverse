/**
 * Whether a bundle covers enough of what the run set out to grade.
 *
 * ## Why a gate before the expensive judge
 *
 * The independent judge costs roughly ten times the run that produced the
 * answers. Sending it a bundle that is missing a seventh of its pairs buys a
 * calibration over whatever survived, and "whatever survived" is not a
 * population anybody chose. The gate is the cheap check that stops the
 * expensive call.
 *
 * ## Why per cell as well as overall
 *
 * The strata are not interchangeable. A bundle can hold 95% of its pairs and
 * still be missing most of one cell, and a calibration computed over that
 * bundle is a calibration on a set where `coding/en` barely appears. mposition
 * set both floors: 200 of 210 overall, 13 of 14 in every cell.
 */

import type { AnswerBundle } from "./routerAnswerBundle";

/** mposition's floors, as counts over the pilot's shape. */
export const PAIRED_COVERAGE_FLOOR = { covered: 200, planned: 210 } as const;
export const CELL_PAIRED_COVERAGE_FLOOR = { covered: 13, planned: 14 } as const;

const ratio = (floor: { covered: number; planned: number }) => floor.covered / floor.planned;

export type CellCoverage = {
    cell: string;
    covered: number;
    planned: number;
};

export type BundleCoverage = {
    covered: number;
    planned: number;
    rate: number;
    cells: readonly CellCoverage[];
};

export const bundleCoverage = (
    bundle: AnswerBundle,
    plannedPerCell: Readonly<Record<string, number>>
): BundleCoverage => {
    const counted = new Map<string, number>();
    for (const entry of bundle.entries) {
        const cell = `${entry.stratum}/${entry.cell}`;
        counted.set(cell, (counted.get(cell) ?? 0) + 1);
    }
    const cells = [...new Set([...Object.keys(plannedPerCell), ...counted.keys()])]
        .sort()
        .map((cell) => ({
            cell,
            covered: counted.get(cell) ?? 0,
            planned: plannedPerCell[cell] ?? 0,
        }));
    const planned = Object.values(plannedPerCell).reduce((sum, value) => sum + value, 0);
    return {
        covered: bundle.entries.length,
        planned,
        rate: planned === 0 ? 0 : bundle.entries.length / planned,
        cells,
    };
};

/**
 * Why this bundle may not be sent to the independent judge. Empty means it may.
 *
 * Stated as counts rather than percentages in the message, because "94.8%"
 * does not tell an operator which cell to look at and "coding/en holds 9 of
 * 14" does.
 */
export const bundleCoverageProblems = (coverage: BundleCoverage): readonly string[] => {
    const problems: string[] = [];
    const floor = ratio(PAIRED_COVERAGE_FLOOR);
    if (coverage.planned === 0) {
        problems.push("the run planned no items, so there is no coverage to measure");
        return problems;
    }
    if (coverage.rate < floor) {
        problems.push(
            `the bundle holds ${coverage.covered} of ${coverage.planned} planned pair(s), under the ` +
                `${PAIRED_COVERAGE_FLOOR.covered}/${PAIRED_COVERAGE_FLOOR.planned} floor`
        );
    }
    const cellFloor = ratio(CELL_PAIRED_COVERAGE_FLOOR);
    for (const cell of coverage.cells) {
        if (cell.planned === 0) {
            problems.push(`${cell.cell} holds ${cell.covered} pair(s) the run never planned`);
            continue;
        }
        if (cell.covered / cell.planned < cellFloor) {
            problems.push(
                `${cell.cell} holds ${cell.covered} of ${cell.planned}, under the ` +
                    `${CELL_PAIRED_COVERAGE_FLOOR.covered}/${CELL_PAIRED_COVERAGE_FLOOR.planned} floor`
            );
        }
    }
    return problems;
};
