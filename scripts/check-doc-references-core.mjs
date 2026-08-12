/**
 * Keeps the instruction documents pointing at files that exist.
 *
 * AGENTS.md opens by saying its instructions override default behaviour, and
 * every UI contract and policy document under it works the same way: "before
 * changing X, read Y". A reference to a file that is not there does not fail
 * anything -- it just sends someone to a path with nothing at it, and what
 * they learn is that the instructions are unreliable.
 *
 * Six were broken when this was written, each for a different ordinary
 * reason: a root layout that moved into route groups, a hook that moved into
 * a neighbouring module, a migration archived, two `.test.mjs` paths that are
 * `.test.ts`, and one module that was planned and never built. None of them
 * was a mistake anyone made twice; they are what happens when prose names
 * paths and nothing re-reads the prose.
 *
 * A reference to something deliberately not built yet is legitimate, but it
 * has to say so where the reader is, not here -- so the exemption list is for
 * paths whose *document* already marks them as unbuilt, and it carries the
 * reason so the next person can check that claim rather than trust this file.
 */

/**
 * Repository-relative paths inside backticks or parentheses. Deliberately
 * anchored to the directories this repository actually has, so a sentence
 * mentioning "app/api" in passing is not read as a path, and prose about
 * `some/other/thing.md` outside the tree is ignored.
 */
const REFERENCE = new RegExp(
    "[`(]((?:docs|lib|app|components|scripts|tests|prisma|locales|\\.github)/" +
        "[A-Za-z0-9._/\\[\\]()-]+" +
        "\\.(?:md|ts|tsx|mjs|cjs|yaml|yml|sql|json|css))[`)]",
    "g"
);

export const documentReferences = (markdown) => {
    REFERENCE.lastIndex = 0;
    return new Set([...markdown.matchAll(REFERENCE)].map((match) => match[1]));
};

/**
 * Paths a document names as planned rather than present. Each must be marked
 * as unbuilt in the document itself; this list only stops the check reporting
 * what the reader has already been told.
 */
export const PLANNED_REFERENCES = {
    // Empty, and that is the healthy state: an entry here is a document
    // telling the reader about something that does not exist yet.
    // `lib/marketingMemoryClaims.ts` was the last one and now exists, so §17's
    // boundary is guarded by the check again rather than exempt from it.
};

/**
 * @param {{
 *   references: Map<string, Set<string>>,
 *   exists: (path: string) => boolean,
 *   planned?: Record<string, { document: string, reason: string }>,
 * }} input
 * @returns {{ errors: string[] }}
 */
export function auditDocumentReferences({
    references,
    exists,
    planned = PLANNED_REFERENCES,
}) {
    const errors = [];
    for (const [path, sources] of references) {
        if (exists(path)) continue;
        if (path in planned) continue;
        errors.push(
            `${path} does not exist, and is referenced by ${[...sources].sort().join(", ")}. ` +
                `An instruction that sends someone to a missing file teaches them the instructions are unreliable.`
        );
    }
    for (const path of Object.keys(planned)) {
        if (exists(path)) {
            errors.push(
                `${path} is listed as planned but now exists. Remove the entry so the check guards it again.`
            );
        }
    }
    return { errors };
}
