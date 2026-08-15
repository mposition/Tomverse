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
 * Repository-relative paths, wherever prose puts them: inside backticks, inside
 * parentheses, or bare in a sentence. Deliberately anchored to the directories
 * this repository actually has and to a file extension, so a sentence
 * mentioning "app/api" in passing is not read as a path, and prose about
 * `some/other/thing.md` outside the tree is ignored.
 *
 * Bare paths count because source comments write them that way -- "see
 * tests/scheduledJobsCore.test.mjs" carries exactly the same promise as the
 * backticked form, and the one broken reference that started this was bare.
 */
const REFERENCE = new RegExp(
    "(?:^|[\\s`(\"'])((?:docs|lib|app|components|scripts|tests|prisma|locales|hooks|packages|\\.github)/" +
        "[A-Za-z0-9._/\\[\\]()-]*" +
        "\\.(?:md|ts|tsx|mjs|cjs|yaml|yml|sql|json|css))(?=[\\s`)\"',;:.]|$)",
    "gm"
);

export const documentReferences = (markdown) => {
    REFERENCE.lastIndex = 0;
    return new Set([...markdown.matchAll(REFERENCE)].map((match) => match[1]));
};

/**
 * The comment text of a TypeScript/JavaScript source file, with the code
 * removed.
 *
 * Only comments are read. A path in an import or a `readFileSync` argument is
 * checked by the compiler or by the run itself; a path in a comment is checked
 * by nobody, which is the whole reason this exists.
 *
 * The scanner is deliberately small: it tracks strings so that a `//` inside
 * one is not read as a comment, and nothing else. It does not understand
 * regular-expression literals or JSX text, so it can mistake part of a line for
 * a comment or skip a comment that follows an apostrophe in JSX. Both
 * directions were measured across this tree when it was written -- 1369 files,
 * 804 path references, no misattributed one -- and both fail towards reading
 * less, not towards inventing a reference that is not there.
 */
export const extractCommentText = (source) => {
    const comments = [];
    let index = 0;
    let state = "code";
    let buffer = "";
    while (index < source.length) {
        const pair = source.slice(index, index + 2);
        if (state === "code") {
            if (pair === "//") {
                state = "line";
                buffer = "";
                index += 2;
                continue;
            }
            if (pair === "/*") {
                state = "block";
                buffer = "";
                index += 2;
                continue;
            }
            const quote = source[index];
            if (quote === '"' || quote === "'" || quote === "`") {
                index += 1;
                while (index < source.length && source[index] !== quote) {
                    if (source[index] === "\\") index += 1;
                    index += 1;
                }
                index += 1;
                continue;
            }
            index += 1;
            continue;
        }
        if (state === "line") {
            if (source[index] === "\n") {
                comments.push(buffer);
                state = "code";
            } else {
                buffer += source[index];
            }
            index += 1;
            continue;
        }
        if (pair === "*/") {
            comments.push(buffer);
            state = "code";
            index += 2;
            continue;
        }
        buffer += source[index];
        index += 1;
    }
    if (state !== "code") comments.push(buffer);
    return comments.join("\n");
};

export const sourceCommentReferences = (source) =>
    documentReferences(extractCommentText(source));

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

/** How a source comment names a path that is deliberately not there. */
export const historicalReferenceKey = (file, path) => `${file} -> ${path}`;

/**
 * Source comments that name a file which no longer exists, on purpose.
 *
 * A comment explaining why something was removed has to be able to say what was
 * removed. That is the same allowance `.github/audits/` gets in the document
 * sweep, except that a source file cannot be excluded wholesale -- the same
 * file usually also carries live pointers -- so the exemption is per sentence
 * and carries its reason here.
 *
 * The bar for an entry is that the comment itself already tells the reader the
 * path is gone. "See <the old root layout>" does not qualify however true it
 * once was; "<the old root layout> is gone" does.
 */
export const HISTORICAL_SOURCE_REFERENCES = {
    "lib/documentLanguage.ts -> app/layout.tsx": {
        reason:
            "VAL-004. The sentence is about what the deleted root layout used to " +
            "hard-code, and reads 'used to hard-code lang=\"en\"'. Repointing it at " +
            "app/(site)/layout.tsx would claim the current root still does.",
    },
    "app/[locale]/layout.tsx -> app/layout.tsx": {
        reason:
            "RECON-I18N-001. The sentence is 'app/layout.tsx is gone', immediately " +
            "followed by the path that replaced it. Naming only the replacement " +
            "would delete the explanation of why two roots exist.",
    },
    "scripts/security-regression-check.mjs -> app/layout.tsx": {
        reason:
            "RECON-I18N-001. Both comments state that there is no single root " +
            "layout any more, which is why the assertions below them read the " +
            "route-group roots instead of one file.",
    },
    "tests/e2e/ssr-root-language.spec.ts -> app/layout.tsx": {
        reason:
            "VAL-004. The regression this spec exists for is what the old root " +
            "layout did; the sentence names it in the past tense to say what the " +
            "spec is guarding against.",
    },
};

/**
 * @param {{
 *   references: Map<string, Set<string>>,
 *   exists: (path: string) => boolean,
 *   historical?: Record<string, { reason: string }>,
 * }} input
 * @returns {{ errors: string[] }}
 */
export function auditSourceCommentReferences({
    references,
    exists,
    historical = HISTORICAL_SOURCE_REFERENCES,
}) {
    const errors = [];
    const seen = new Set();
    for (const [path, sources] of references) {
        const present = exists(path);
        for (const file of sources) {
            const key = historicalReferenceKey(file, path);
            if (key in historical) {
                seen.add(key);
                if (present) {
                    errors.push(
                        `${key} is listed as a deliberate reference to a removed file, but ${path} exists again. ` +
                            `Re-read the comment: it explains an absence that is over.`
                    );
                }
                continue;
            }
            if (present) continue;
            errors.push(
                `${path} does not exist, and ${file} points a reader at it. ` +
                    `If the comment is describing something that was removed, register it as historical with the reason; ` +
                    `otherwise repoint it at the path that replaced it.`
            );
        }
    }
    for (const key of Object.keys(historical)) {
        if (seen.has(key)) continue;
        errors.push(
            `${key} is listed as historical but no comment makes that reference any more. Remove the entry.`
        );
    }
    return { errors };
}
