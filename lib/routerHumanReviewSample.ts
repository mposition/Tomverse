/**
 * Drawing the human review sample, and the rules that keep it honest.
 *
 * ## Why the draw is its own module
 *
 * A human sample exists to calibrate the model judges, so it has to be chosen
 * without reference to what those judges said. That is not a matter of
 * discipline: `drawPrimarySample` takes a bundle and a seed and has no
 * parameter through which a verdict could reach it. Choosing on the strength of
 * a verdict is therefore not a thing a caller can do by mistake, and the
 * diagnostic sample -- which is deliberately drawn from disagreements -- lives
 * in its own module for the same reason.
 *
 * ## What the numbers are, and are not
 *
 * 60 pairs, 4 from each of the 15 cells. The frozen set holds 14 adopted items
 * per cell, so an equal draw represents the whole development set without
 * weighting, and gives 28 ko, 28 en and 4 ko-en. Near 80% agreement that is
 * about ±10pp, which is a direction check. It is not enough to estimate any
 * single cell, and a per-cell figure from it is a diagnostic rather than a
 * measurement.
 *
 * ## The reserve
 *
 * Two per cell, in an order fixed at the draw. A reserve is spent only when a
 * pair cannot be reviewed at all -- no output, an unparseable submission, an
 * order that does not match the bundle. A verdict, a tie, or two judges
 * disagreeing are never reasons: replacing on those grounds selects the sample
 * on the thing it is meant to measure. `substitutionProblems` refuses them by
 * name rather than trusting the caller to know.
 */

import { seededRandom } from "./routerQualityEvalCore";
import type { AnswerBundle } from "./routerAnswerBundle";
import { sha256 } from "./routerAnswerBundle";

export const HUMAN_SAMPLE_MANIFEST_VERSION = "router-human-review-sample-v1";
export const HUMAN_SAMPLE_DIGEST_ALGORITHM = "sha256-canonical-pairs-v1";

/** mposition's design, fixed here so a draw cannot quietly use other numbers. */
export const HUMAN_PRIMARY_PER_CELL = 4;
export const HUMAN_RESERVE_PER_CELL = 2;
export const HUMAN_REVIEWERS_PER_PAIR = 2;
export const ADJUDICATE_ON_DISAGREEMENT = true;
export const DIAGNOSTIC_DISAGREEMENTS_PER_CELL = 2;

/**
 * The only grounds on which a primary pair may be replaced.
 *
 * Every one of them is a statement about whether the pair can be reviewed, not
 * about how it was reviewed. That is the whole distinction: a sample that
 * drops the pairs whose answers came out a particular way is no longer a
 * random sample of anything.
 */
export const STRUCTURAL_SUBSTITUTION_REASONS = [
    "missing_from_bundle",
    "missing_output",
    "parse_failure",
    "pair_order_mismatch",
] as const;
export type StructuralSubstitutionReason = (typeof STRUCTURAL_SUBSTITUTION_REASONS)[number];

export type CellDraw = {
    /** `${stratum}/${cell}`. */
    cell: string;
    primary: readonly string[];
    /** In the order they are to be spent. Not a set. */
    reserve: readonly string[];
};

export type Substitution = {
    /** The primary pair that could not be reviewed. */
    pairId: string;
    /** The reserve that took its place, which must be the next unspent one. */
    replacedBy: string;
    reason: StructuralSubstitutionReason;
    detail: string;
    at: string;
    by: string;
};

export type HumanSampleManifest = {
    manifestVersion: typeof HUMAN_SAMPLE_MANIFEST_VERSION;
    /** Of the population, not of the file it happened to be stored in. */
    populationDigest: string;
    digestAlgorithm: typeof HUMAN_SAMPLE_DIGEST_ALGORITHM;
    bundleVersion: string;
    judgeTemplateVersion: string;
    seed: number;
    drawnAt: string;
    drawnBy: string;
    perCell: { primary: number; reserve: number };
    reviewersPerPair: number;
    adjudicateOnDisagreement: boolean;
    cells: readonly CellDraw[];
    /** Append-only. Empty on a fresh draw. */
    substitutions: readonly Substitution[];
    /** Set only when this manifest replaces one over the same population. */
    redrawOf?: { populationDigest: string; previousSeed: number; reason: string } | null;
};

/**
 * A digest of what could have been drawn, not of the file it arrived in.
 *
 * Sorted by `pairId` and reduced to the fields that decide membership, so
 * reformatting the bundle, reordering its lines, or rewriting its header does
 * not make a manifest look like it was drawn from a different population.
 */
export const canonicalPopulationDigest = (bundle: AnswerBundle): string =>
    sha256(
        JSON.stringify(
            bundle.entries
                .map((entry) => [entry.pairId, entry.stratum, entry.cell, entry.first.digest, entry.second.digest])
                .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
        )
    );

const cellKey = (entry: { stratum: string; cell: string }) => `${entry.stratum}/${entry.cell}`;

/** A deterministic shuffle, so the same seed and population give the same draw. */
const shuffled = (values: readonly string[], random: () => number): string[] => {
    const order = [...values];
    for (let index = order.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        [order[index], order[swap]] = [order[swap], order[index]];
    }
    return order;
};

/**
 * Draw the primary sample and its reserve.
 *
 * Takes a bundle and a seed. There is no parameter for a verdict, a score or a
 * judge, which is what makes "drawn before the judges were read" a property of
 * the code rather than a claim in a document.
 */
export const drawPrimarySample = (input: {
    bundle: AnswerBundle;
    seed: number;
    drawnAt: string;
    drawnBy: string;
    redrawOf?: HumanSampleManifest["redrawOf"];
}): HumanSampleManifest => {
    const byCell = new Map<string, string[]>();
    for (const entry of input.bundle.entries) {
        const key = cellKey(entry);
        byCell.set(key, [...(byCell.get(key) ?? []), entry.pairId]);
    }
    const random = seededRandom(input.seed);
    const cells: CellDraw[] = [...byCell.keys()]
        .sort()
        .map((cell) => {
            // Sorted before shuffling: the bundle's line order must not reach
            // the draw, or the same seed would give different samples for the
            // same population written twice.
            const order = shuffled([...(byCell.get(cell) ?? [])].sort(), random);
            return {
                cell,
                primary: order.slice(0, HUMAN_PRIMARY_PER_CELL),
                reserve: order.slice(
                    HUMAN_PRIMARY_PER_CELL,
                    HUMAN_PRIMARY_PER_CELL + HUMAN_RESERVE_PER_CELL
                ),
            };
        });

    return {
        manifestVersion: HUMAN_SAMPLE_MANIFEST_VERSION,
        populationDigest: canonicalPopulationDigest(input.bundle),
        digestAlgorithm: HUMAN_SAMPLE_DIGEST_ALGORITHM,
        bundleVersion: input.bundle.header.bundleVersion,
        judgeTemplateVersion: input.bundle.header.judgeTemplateVersion,
        seed: input.seed,
        drawnAt: input.drawnAt,
        drawnBy: input.drawnBy,
        perCell: { primary: HUMAN_PRIMARY_PER_CELL, reserve: HUMAN_RESERVE_PER_CELL },
        reviewersPerPair: HUMAN_REVIEWERS_PER_PAIR,
        adjudicateOnDisagreement: ADJUDICATE_ON_DISAGREEMENT,
        cells,
        substitutions: [],
        redrawOf: input.redrawOf ?? null,
    };
};

/** The pairs a reviewer is actually asked about, after substitutions. */
export const effectiveSample = (manifest: HumanSampleManifest): readonly string[] => {
    const replaced = new Map(manifest.substitutions.map((entry) => [entry.pairId, entry.replacedBy]));
    return manifest.cells.flatMap((cell) => cell.primary.map((pairId) => replaced.get(pairId) ?? pairId));
};

/**
 * The invariants a drawn manifest has to hold. Empty means it can be worked.
 *
 * Checked rather than assumed because each one has a failure mode that still
 * produces a plausible sheet: a cell short of four, a reserve that is also a
 * primary, a per-cell count nobody agreed to.
 */
export const manifestProblems = (
    manifest: HumanSampleManifest,
    bundle?: AnswerBundle
): readonly string[] => {
    const problems: string[] = [];
    if (manifest.manifestVersion !== HUMAN_SAMPLE_MANIFEST_VERSION) {
        problems.push(`manifest version ${String(manifest.manifestVersion)} is not ${HUMAN_SAMPLE_MANIFEST_VERSION}`);
    }
    if (manifest.digestAlgorithm !== HUMAN_SAMPLE_DIGEST_ALGORITHM) {
        problems.push(`digest algorithm ${String(manifest.digestAlgorithm)} is not ${HUMAN_SAMPLE_DIGEST_ALGORITHM}`);
    }
    if (manifest.perCell?.primary !== HUMAN_PRIMARY_PER_CELL) {
        problems.push(`perCell.primary is ${String(manifest.perCell?.primary)}, not ${HUMAN_PRIMARY_PER_CELL}`);
    }
    if (manifest.perCell?.reserve !== HUMAN_RESERVE_PER_CELL) {
        problems.push(`perCell.reserve is ${String(manifest.perCell?.reserve)}, not ${HUMAN_RESERVE_PER_CELL}`);
    }
    if (manifest.reviewersPerPair !== HUMAN_REVIEWERS_PER_PAIR) {
        problems.push(`reviewersPerPair is ${String(manifest.reviewersPerPair)}, not ${HUMAN_REVIEWERS_PER_PAIR}`);
    }
    if (manifest.adjudicateOnDisagreement !== true) {
        problems.push("adjudicateOnDisagreement is not true, so a split between reviewers would stand unresolved");
    }
    if (!(typeof manifest.seed === "number" && Number.isInteger(manifest.seed) && manifest.seed > 0)) {
        problems.push("the manifest has no seed, so the draw cannot be replayed");
    }
    for (const field of ["drawnAt", "drawnBy", "populationDigest", "judgeTemplateVersion"] as const) {
        if (typeof manifest[field] !== "string" || manifest[field] === "") {
            problems.push(`the manifest has no ${field}`);
        }
    }

    const seen = new Map<string, string>();
    for (const cell of manifest.cells ?? []) {
        if (cell.primary.length !== HUMAN_PRIMARY_PER_CELL) {
            problems.push(`${cell.cell} holds ${cell.primary.length} primary pair(s), not ${HUMAN_PRIMARY_PER_CELL}`);
        }
        if (cell.reserve.length !== HUMAN_RESERVE_PER_CELL) {
            problems.push(`${cell.cell} holds ${cell.reserve.length} reserve pair(s), not ${HUMAN_RESERVE_PER_CELL}`);
        }
        for (const [role, ids] of [["primary", cell.primary], ["reserve", cell.reserve]] as const) {
            for (const pairId of ids) {
                const already = seen.get(pairId);
                if (already) {
                    problems.push(`${pairId} appears as ${already} and again as ${cell.cell} ${role}`);
                } else {
                    seen.set(pairId, `${cell.cell} ${role}`);
                }
            }
        }
    }

    const total = (manifest.cells ?? []).reduce((sum, cell) => sum + cell.primary.length, 0);
    const expected = (manifest.cells ?? []).length * HUMAN_PRIMARY_PER_CELL;
    if (total !== expected) {
        problems.push(`the primary sample holds ${total} pair(s) against ${expected} for ${(manifest.cells ?? []).length} cells`);
    }

    if (bundle) {
        if (canonicalPopulationDigest(bundle) !== manifest.populationDigest) {
            problems.push("the manifest was drawn from a different population than this bundle");
        }
        const known = new Set(bundle.entries.map((entry) => entry.pairId));
        for (const pairId of seen.keys()) {
            if (!known.has(pairId)) problems.push(`${pairId} is not in the bundle`);
        }
    }
    return problems;
};

/**
 * Why a substitution may not be made. Empty means it may.
 *
 * The reserve order is not advice. Allowing a later reserve to be taken first
 * would let the person spending it choose which replacement they preferred,
 * which is the selection this whole contract exists to prevent.
 */
export const substitutionProblems = (
    manifest: HumanSampleManifest,
    proposed: Substitution
): readonly string[] => {
    const problems: string[] = [];
    const cell = (manifest.cells ?? []).find((entry) => entry.primary.includes(proposed.pairId));
    if (!cell) {
        problems.push(`${proposed.pairId} is not a primary pair in this manifest`);
        return problems;
    }
    if (!STRUCTURAL_SUBSTITUTION_REASONS.includes(proposed.reason)) {
        problems.push(
            `"${String(proposed.reason)}" is not a structural reason. A reserve is spent when a pair ` +
                `cannot be reviewed, never for how it was judged: ${STRUCTURAL_SUBSTITUTION_REASONS.join(", ")}`
        );
    }
    if (manifest.substitutions.some((entry) => entry.pairId === proposed.pairId)) {
        problems.push(`${proposed.pairId} has already been replaced`);
    }
    const spent = new Set(manifest.substitutions.map((entry) => entry.replacedBy));
    const next = cell.reserve.find((pairId) => !spent.has(pairId));
    if (!next) {
        problems.push(`${cell.cell} has no reserve left`);
    } else if (proposed.replacedBy !== next) {
        problems.push(
            `${cell.cell} must spend ${next} next, not ${proposed.replacedBy}: the reserve order was fixed at the draw`
        );
    }
    for (const field of ["detail", "at", "by"] as const) {
        if (typeof proposed[field] !== "string" || proposed[field] === "") {
            problems.push(`the substitution has no ${field}`);
        }
    }
    return problems;
};

/** Append a substitution. Callers check `substitutionProblems` first. */
export const withSubstitution = (
    manifest: HumanSampleManifest,
    substitution: Substitution
): HumanSampleManifest => ({
    ...manifest,
    substitutions: [...manifest.substitutions, substitution],
});

/**
 * Why this draw may not replace an existing one over the same population.
 *
 * Redrawing with a new seed until the sample looks convenient is the failure
 * this guards. A redraw is allowed, and it has to say so and say why.
 */
export const redrawProblems = (
    previous: HumanSampleManifest,
    next: HumanSampleManifest
): readonly string[] => {
    if (previous.populationDigest !== next.populationDigest) return [];
    const problems: string[] = [];
    if (next.seed === previous.seed) return problems;
    if (!next.redrawOf) {
        problems.push(
            `a manifest for this population already exists at seed ${previous.seed}. A different ` +
                "seed needs redrawOf naming the previous seed and the reason."
        );
        return problems;
    }
    if (next.redrawOf.previousSeed !== previous.seed) {
        problems.push(
            `redrawOf names seed ${next.redrawOf.previousSeed}, but the existing manifest was drawn at ${previous.seed}`
        );
    }
    if (!next.redrawOf.reason || next.redrawOf.reason.trim() === "") {
        problems.push("redrawOf has no reason");
    }
    return problems;
};
