/**
 * Which bundle the human review is drawn from, and what seed draws it.
 *
 * ## Why the source is frozen rather than dispatched
 *
 * By the time this sample is drawn, the model judges have already graded these
 * answers and their disagreement is known -- +40.48pp between Luna and Fable
 * on pilot 20260830a. A draw taken after seeing that is a draw somebody could
 * steer, and the two levers are the bundle and the seed.
 *
 * So neither is an input. The bundle is pinned here by run, artifact, filename
 * and content digest; the seed is derived from that digest. Nobody picks the
 * seed because nobody knows the digest until the artifact is read, and once it
 * is read the seed follows from it with no choice left.
 *
 * That is the whole design: a dispatch may say who is reviewing, and nothing
 * about what they review.
 */

/** The one bundle the primary human review may be drawn from. */
export type FrozenReviewSource = {
    /** Workflow run that produced the bundle. */
    sourceRunId: string;
    sourceArtifact: string;
    bundleFile: string;
    /**
     * `bundleDigest()` over the pinned bundle, as `sha256:<hex>`.
     *
     * Null until one free read has established it. A null does not permit a
     * draw -- it refuses, prints what it observed, and waits for that value to
     * be committed. The point is that this number is read off the artifact
     * rather than chosen.
     */
    bundleDigest: string | null;
    /** How many pairs the draw must produce. Checked, not assumed. */
    expectedCells: number;
    expectedPrimaryPairs: number;
    /**
     * Named before the first two reviews exist, so the third reviewer is not
     * chosen once it is known which way they would break a tie. Their sheet is
     * built only after a disagreement, from the disagreeing pairs.
     */
    adjudicatorId: string;
};

/**
 * The seed, from the bundle's own digest.
 *
 * Deterministic and unchosen: the same bundle always draws the same sample,
 * and a different bundle draws a different one. Taken from the leading hex of
 * the digest and kept inside the safe-integer range, which is far more entropy
 * than a draw over 210 pairs consumes.
 */
export const seedFromBundleDigest = (digest: string): number => {
    const hex = digest.replace(/^sha256:/, "").slice(0, 13);
    if (!/^[0-9a-f]{13}$/.test(hex)) {
        throw new Error(`"${digest}" is not a sha256 digest, so no seed can be derived from it.`);
    }
    // 13 hex digits is 52 bits: inside Number.MAX_SAFE_INTEGER, and zero is
    // excluded because the draw requires a positive seed.
    return Number.parseInt(hex, 16) || 1;
};

/**
 * Why this bundle may not be drawn from. Empty means it may.
 *
 * `observed` is what was actually read from the artifact this run downloaded.
 */
export const reviewSourceProblems = (
    frozen: FrozenReviewSource,
    observed: { bundleDigest: string; pairs: number; cells: number }
): readonly string[] => {
    const problems: string[] = [];
    if (frozen.bundleDigest === null) {
        problems.push(
            `the pre-registration freezes no bundleDigest. The bundle read here is ` +
                `${observed.bundleDigest} — commit that value, then dispatch again. Nothing was ` +
                "drawn and no sheet was written."
        );
    } else if (frozen.bundleDigest !== observed.bundleDigest) {
        problems.push(
            `this bundle is ${observed.bundleDigest}, not the pre-registered ` +
                `${frozen.bundleDigest}. The review is drawn from one frozen bundle and this is a ` +
                "different one"
        );
    }
    if (observed.cells !== frozen.expectedCells) {
        problems.push(`the bundle covers ${observed.cells} cell(s), not the ${frozen.expectedCells} frozen`);
    }
    return problems;
};

/** Why a drawn manifest does not match what was frozen. Empty means it does. */
export const drawShapeProblems = (
    frozen: FrozenReviewSource,
    manifest: { cells?: readonly { primary?: readonly unknown[] }[] }
): readonly string[] => {
    const problems: string[] = [];
    const cells = manifest.cells ?? [];
    if (cells.length !== frozen.expectedCells) {
        problems.push(`the draw covers ${cells.length} cell(s), not the ${frozen.expectedCells} frozen`);
    }
    const primary = cells.reduce((sum, cell) => sum + (cell.primary?.length ?? 0), 0);
    if (primary !== frozen.expectedPrimaryPairs) {
        problems.push(
            `the draw holds ${primary} primary pair(s), not the ${frozen.expectedPrimaryPairs} frozen`
        );
    }
    return problems;
};
