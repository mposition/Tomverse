/**
 * The diagnostic supplement: pairs the two model judges read differently.
 *
 * ## Why this is a separate module from the primary draw
 *
 * The primary sample measures how often people agree with the judges, so it
 * has to be drawn without reference to what the judges said --
 * lib/routerHumanReviewSample.ts has no parameter through which a verdict
 * could arrive. This draw is the opposite: it goes looking for disagreements
 * on purpose, because a handful of the cases the judges split on says more
 * about *why* they differ than sixty random ones do.
 *
 * Those are two different measurements and they cannot share a module, a
 * command, or a rate. A diagnostic pair is chosen because of its verdict, so
 * counting it in the primary agreement rate would be counting a sample
 * selected on the thing being measured. `DiagnosticDraw` is a different type
 * from `HumanSampleManifest` for exactly that reason: nothing that takes the
 * primary draw can be handed this one.
 *
 * ## Outside the sixty, always
 *
 * Every pair named anywhere in the primary manifest is excluded -- primary,
 * reserve, and anything a reserve has already replaced. A pair in both draws
 * would be a pair whose human verdict was collected once and used twice, once
 * as a random observation and once as a selected one.
 *
 * ## At most two per cell, and fewer is said out loud
 *
 * A cell with no disagreements contributes nothing, and the draw records that
 * rather than making it up elsewhere. The supplement is read per cell as an
 * illustration; it is not a rate and has no interval.
 */

import type { AnswerBundle } from "./routerAnswerBundle";
import type { JudgePass, JudgeVerdictRecord } from "./routerJudgeCalibration";
import { seededRandom } from "./routerQualityEvalCore";
import {
    DIAGNOSTIC_DISAGREEMENTS_PER_CELL,
    canonicalPopulationDigest,
} from "./routerHumanReviewSample";
import type { HumanSampleManifest } from "./routerHumanReviewSample";

export const DIAGNOSTIC_DRAW_VERSION = "router-human-review-diagnostic-v1";

export type DiagnosticCell = {
    cell: string;
    /** Chosen, in the order the seed put them. */
    pairIds: readonly string[];
    /** How many the judges split on in this cell, before the cap. */
    disagreementsAvailable: number;
};

export type DiagnosticDraw = {
    drawVersion: typeof DIAGNOSTIC_DRAW_VERSION;
    purpose: "diagnostic";
    populationDigest: string;
    /** The draw this one must not overlap, named so the two can be checked apart. */
    primaryPopulationDigest: string;
    primarySeed: number;
    bundleDigest: string;
    targetJudge: string;
    referenceJudge: string;
    perCellCap: number;
    seed: number;
    drawnAt: string;
    drawnBy: string;
    cells: readonly DiagnosticCell[];
};

/** Every pair the primary draw has spoken for, in any role. */
export const primaryFootprint = (manifest: HumanSampleManifest): ReadonlySet<string> =>
    new Set([
        ...manifest.cells.flatMap((cell) => [...cell.primary, ...cell.reserve]),
        ...manifest.substitutions.map((entry) => entry.replacedBy),
    ]);

const verdictMap = (verdicts: readonly JudgeVerdictRecord[]) =>
    new Map(verdicts.map((entry) => [entry.pairId, entry.verdict]));

/** Pairs the two judges read differently, whatever the primary draw did with them. */
export const judgeDisagreements = (target: JudgePass, reference: JudgePass): readonly string[] => {
    const other = verdictMap(reference.verdicts);
    return target.verdicts
        .filter((entry) => other.has(entry.pairId) && other.get(entry.pairId) !== entry.verdict)
        .map((entry) => entry.pairId)
        .sort();
};

const shuffled = (values: readonly string[], random: () => number): string[] => {
    const order = [...values];
    for (let index = order.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        [order[index], order[swap]] = [order[swap], order[index]];
    }
    return order;
};

/**
 * Draw up to two disagreements per cell, from outside the primary sixty.
 *
 * Throws on the conditions that would make the result meaningless rather than
 * merely small: two judge passes over different answers, or a bundle the
 * primary draw was not made from. A cell with nothing to draw is not an error.
 */
export const drawDiagnosticSample = (input: {
    bundle: AnswerBundle;
    primary: HumanSampleManifest;
    target: JudgePass;
    reference: JudgePass;
    seed: number;
    drawnAt: string;
    drawnBy: string;
}): DiagnosticDraw => {
    if (input.target.bundleDigest !== input.reference.bundleDigest) {
        throw new Error(
            "the two judge passes were made over different bundles, so a disagreement between them " +
                "is not a disagreement about the same answers"
        );
    }
    const populationDigest = canonicalPopulationDigest(input.bundle);
    if (populationDigest !== input.primary.populationDigest) {
        throw new Error(
            "this bundle is not the population the primary sample was drawn from, so 'outside the primary " +
                "sixty' would not mean anything"
        );
    }

    const spokenFor = primaryFootprint(input.primary);
    const disagreed = new Set(judgeDisagreements(input.target, input.reference));
    const byCell = new Map<string, string[]>();
    for (const entry of input.bundle.entries) {
        if (!disagreed.has(entry.pairId) || spokenFor.has(entry.pairId)) continue;
        const cell = `${entry.stratum}/${entry.cell}`;
        byCell.set(cell, [...(byCell.get(cell) ?? []), entry.pairId]);
    }

    const random = seededRandom(input.seed);
    const cells: DiagnosticCell[] = [...byCell.keys()].sort().map((cell) => {
        const available = [...(byCell.get(cell) ?? [])].sort();
        return {
            cell,
            pairIds: shuffled(available, random).slice(0, DIAGNOSTIC_DISAGREEMENTS_PER_CELL),
            disagreementsAvailable: available.length,
        };
    });

    return {
        drawVersion: DIAGNOSTIC_DRAW_VERSION,
        purpose: "diagnostic",
        populationDigest,
        primaryPopulationDigest: input.primary.populationDigest,
        primarySeed: input.primary.seed,
        bundleDigest: input.target.bundleDigest,
        targetJudge: `${input.target.identity.provider}/${input.target.identity.apiModel}`,
        referenceJudge: `${input.reference.identity.provider}/${input.reference.identity.apiModel}`,
        perCellCap: DIAGNOSTIC_DISAGREEMENTS_PER_CELL,
        seed: input.seed,
        drawnAt: input.drawnAt,
        drawnBy: input.drawnBy,
        cells,
    };
};

/** Every pair in the supplement, in a stable order. */
export const diagnosticSample = (draw: DiagnosticDraw): readonly string[] =>
    draw.cells.flatMap((cell) => cell.pairIds);

/**
 * Why a diagnostic draw cannot be worked. Empty means it can.
 *
 * The overlap check is the one that matters: a pair in both draws would have
 * one human verdict counted twice, once as a random observation and once as a
 * selected one.
 */
export const diagnosticProblems = (
    draw: DiagnosticDraw,
    primary: HumanSampleManifest
): readonly string[] => {
    const problems: string[] = [];
    if (draw.drawVersion !== DIAGNOSTIC_DRAW_VERSION) {
        problems.push(`draw version ${String(draw.drawVersion)} is not ${DIAGNOSTIC_DRAW_VERSION}`);
    }
    if (draw.purpose !== "diagnostic") {
        problems.push(`this draw calls itself "${String(draw.purpose)}", and only a diagnostic draw selects on verdicts`);
    }
    if (draw.primaryPopulationDigest !== primary.populationDigest) {
        problems.push("the draw names a different primary sample than the one it is being checked against");
    }
    if (draw.perCellCap !== DIAGNOSTIC_DISAGREEMENTS_PER_CELL) {
        problems.push(`perCellCap is ${String(draw.perCellCap)}, not ${DIAGNOSTIC_DISAGREEMENTS_PER_CELL}`);
    }
    if (!(typeof draw.seed === "number" && Number.isInteger(draw.seed) && draw.seed > 0)) {
        problems.push("the draw has no seed, so it cannot be replayed");
    }
    for (const field of ["drawnAt", "drawnBy", "targetJudge", "referenceJudge", "bundleDigest"] as const) {
        if (typeof draw[field] !== "string" || draw[field] === "") problems.push(`the draw has no ${field}`);
    }

    const spokenFor = primaryFootprint(primary);
    const seen = new Set<string>();
    for (const cell of draw.cells ?? []) {
        if (cell.pairIds.length > DIAGNOSTIC_DISAGREEMENTS_PER_CELL) {
            problems.push(
                `${cell.cell} holds ${cell.pairIds.length} diagnostic pair(s), over the ${DIAGNOSTIC_DISAGREEMENTS_PER_CELL} agreed`
            );
        }
        if (cell.pairIds.length > cell.disagreementsAvailable) {
            problems.push(`${cell.cell} draws ${cell.pairIds.length} from ${cell.disagreementsAvailable} disagreement(s)`);
        }
        for (const pairId of cell.pairIds) {
            if (spokenFor.has(pairId)) {
                problems.push(`${pairId} is already in the primary draw, so its verdict would be counted twice`);
            }
            if (seen.has(pairId)) problems.push(`${pairId} appears in the diagnostic draw twice`);
            seen.add(pairId);
        }
    }
    return problems;
};

/**
 * What the supplement can be reported as, per cell.
 *
 * Counts, never a rate. These pairs were chosen because the judges split on
 * them, so the share of them a person agrees with is not an estimate of
 * anything about the set -- and a percentage printed beside the primary one
 * would be read as though it were.
 */
export type DiagnosticReadout = {
    cell: string;
    drawn: number;
    disagreementsAvailable: number;
    /** Said out loud so a thin cell is not mistaken for a cell with no problem. */
    shortOfTarget: number;
};

export const diagnosticReadout = (draw: DiagnosticDraw): readonly DiagnosticReadout[] =>
    draw.cells.map((cell) => ({
        cell: cell.cell,
        drawn: cell.pairIds.length,
        disagreementsAvailable: cell.disagreementsAvailable,
        shortOfTarget: Math.max(0, DIAGNOSTIC_DISAGREEMENTS_PER_CELL - cell.pairIds.length),
    }));
