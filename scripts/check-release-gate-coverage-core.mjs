/**
 * Keeps §1 of the release checklist honest about what the gate actually is.
 *
 * The checklist is what a human runs through before promoting a build, and it
 * is the only place the whole gate is written down in one list. CI enforces
 * its own set, and the two drifted: the repository grew twelve CI-enforced
 * `check:`/`verify:` scripts while §1 named five. Nothing failed, which is the
 * problem -- a release manager reading the checklist would have believed they
 * had run the gate.
 *
 * Two directions, both errors:
 *
 * - a check CI enforces but the checklist does not name understates the gate;
 * - a check the checklist names that no longer exists sends someone to run a
 *   command that errors, and they will assume the checklist is stale rather
 *   than that the check was lost.
 *
 * Checks that need something CI does not have -- a database, a live API key --
 * are the reason this is a list rather than "everything in package.json". They
 * belong in the checklist and *not* in CI, so they are declared here as
 * manually-gated rather than inferred from either side.
 */

/** Matches `npm run check:foo` / `npm run verify:bar` in prose or YAML. */
const SCRIPT_MENTION = /npm run ((?:check|verify):[a-z0-9:-]+)/g;

export const scriptMentions = (text) => {
    SCRIPT_MENTION.lastIndex = 0;
    return new Set([...text.matchAll(SCRIPT_MENTION)].map((match) => match[1]));
};

/**
 * Checks that cannot run in CI and must therefore be carried by the checklist.
 * Each says why, because "CI does not run it" is not on its own a reason for a
 * human to have to.
 */
export const MANUALLY_GATED_CHECKS = {
    "check:model-pricing-db": {
        reason:
            "Reads ModelRegistryEntry to prove stored NULL still means 'inherit the code profile' " +
            "(AGENTS.md names this check for that contract). It needs the deployed database, not a fixture.",
    },
    "check:router-context-window-db": {
        reason:
            "Reads ModelRegistryEntry to prove no row cleared a context window the catalogue declares. " +
            "getRuntimeModels builds each model from its row alone, so that row is what a request reads " +
            "and the catalogue-side check cannot see it. It needs the deployed database, not a fixture.",
    },
    "check:openai-model-access": {
        reason:
            "Calls GET /v1/models with a production key to confirm per-account model visibility. " +
            "It is not a price source and cannot run without a live credential.",
    },
};

/**
 * The variants that are not separate gates: a non-strict warning mode whose
 * strict form is already required, and helper scripts a required check calls.
 */
export const NOT_A_GATE = new Set(["check:encoding"]);

/**
 * @param {{
 *   packageScripts: readonly string[],
 *   ciMentions: Set<string>,
 *   checklistMentions: Set<string>,
 * }} input
 * @returns {{ errors: string[] }}
 */
export function auditReleaseGateCoverage({
    packageScripts,
    ciMentions,
    checklistMentions,
}) {
    const errors = [];
    const known = new Set(packageScripts);

    for (const script of ciMentions) {
        if (NOT_A_GATE.has(script)) continue;
        if (!checklistMentions.has(script)) {
            errors.push(
                `${script} is enforced by CI but not named in the release checklist. ` +
                    `Someone running the checklist would believe they had run the gate.`
            );
        }
    }

    for (const [script, entry] of Object.entries(MANUALLY_GATED_CHECKS)) {
        if (!known.has(script)) {
            errors.push(
                `${script} is listed as manually gated but is no longer a package script. Remove the entry.`
            );
            continue;
        }
        if (!checklistMentions.has(script)) {
            errors.push(
                `${script} runs in no CI job, so the release checklist is the only thing that runs it: ${entry.reason}`
            );
        }
    }

    for (const script of checklistMentions) {
        if (!known.has(script)) {
            errors.push(
                `The release checklist names ${script}, which is not a package script. ` +
                    `A checklist step that errors teaches people to skip steps.`
            );
        }
    }

    return { errors };
}
