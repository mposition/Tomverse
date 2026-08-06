/**
 * Keeps `.github/audits/ui-test-tiers.md` honest about the `@ui-risk` tier.
 *
 * That document opens by declaring itself "**어떤 spec이 어느 CI tier에서
 * 실행되는지**의 단일 기준" -- the single source of truth for which spec runs
 * in which CI tier. It stopped being one. The tier is selected by a tag, not
 * by a list, so specs joined it by adding `@ui-risk` and nothing ever asked
 * the document to keep up: twenty-five spec files carried the tag while the
 * table named five.
 *
 * The cost is not bookkeeping. This tier blocks merges, and the document is
 * where its size is reasoned about -- it records a measured runtime and has a
 * whole section on what is deliberately *not* in the PR tier because of what
 * PR-tier time costs. A table showing five entries against a 67-second budget
 * is the wrong input to "should this spec be tagged too?".
 *
 * So: every tagged spec must appear in the table, and every spec the table
 * names must still carry the tag.
 */

/** A tagged spec is one whose source mentions the tier's grep tag. */
export const UI_RISK_TAG = "@ui-risk";

/** Spec filenames as they appear in the document, in `code` spans. */
export const specMentions = (markdown) =>
    new Set(
        [...markdown.matchAll(/`([a-z0-9][a-z0-9.-]*\.spec\.ts)`/g)].map(
            (match) => match[1]
        )
    );

/**
 * @param {{
 *   taggedSpecs: readonly string[],
 *   documentedSpecs: Set<string>,
 * }} input
 * @returns {{ errors: string[] }}
 */
export function auditUiTierCoverage({ taggedSpecs, documentedSpecs }) {
    const errors = [];
    const tagged = new Set(taggedSpecs);

    for (const spec of taggedSpecs) {
        if (!documentedSpecs.has(spec)) {
            errors.push(
                `${spec} carries ${UI_RISK_TAG} but is not recorded in the tier document. ` +
                    `It blocks merges and nothing says so.`
            );
        }
    }

    for (const spec of documentedSpecs) {
        if (!tagged.has(spec)) {
            errors.push(
                `The tier document records ${spec} in the ${UI_RISK_TAG} tier, but the spec no longer carries the tag. ` +
                    `Either the tag was dropped by accident or the document is describing coverage that does not run.`
            );
        }
    }

    return { errors };
}
