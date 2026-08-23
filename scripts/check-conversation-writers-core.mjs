/**
 * Which files may create a Conversation row directly.
 *
 * Product boundary decision record v1.2, §6.
 *
 * ## Why a check and not just the constraints
 *
 * `20260822090000_conversation_product_key_expand` added three CHECKs and all
 * three pass `productKey IS NULL`, because the transition requires it. A
 * writer that forgets the column therefore produces a row every constraint
 * accepts, stored as NULL -- and the expand sequence's step 2, "every writer
 * names a productKey", becomes a claim with nothing behind it.
 *
 * The constraints stop wrong combinations. `lib/conversationCreation.ts` and
 * this check stop omissions, because the service takes `productKey` as a
 * required argument and this makes the service the only way in.
 *
 * ## Two failure modes
 *
 * Too narrow, and a fourth writer lands and writes NULLs nobody notices. Too
 * broad, and the check fails a test fixture or generated Prisma code with a
 * product-boundary error, which is how a gate gets switched off. So the
 * allowlist is explicit, each entry says why, and the false positives are
 * pinned in tests/conversationWriters.test.mjs as deliberately as the true
 * ones.
 *
 * ## What is deliberately not matched
 *
 * `conversation.createdAt` and `conversation.createMany`. The first is a
 * property read that happens to start with the same nine characters --
 * lib/guestImport.ts and app/api/admin/users/[userId]/route.ts were both
 * miscounted as writers in v1 of the decision record for exactly this reason,
 * and neither creates a conversation. The second does not exist in this
 * codebase and would need its own decision if it ever did, because it cannot
 * return the rows it wrote.
 */

/**
 * `x.conversation.create(` where the next character is not another identifier
 * character -- which is what separates `create(` from `createdAt` and
 * `createMany`.
 */
export const DIRECT_CREATE_PATTERN = /\bconversation\s*\.\s*create\s*\(/g;

/** `createdAt`, `createMany`, `createManyAndReturn` and anything else glued on. */
export const NON_WRITER_PATTERN = /\bconversation\s*\.\s*create[A-Za-z0-9_$]/g;

/**
 * Where a direct create is correct, and why.
 *
 * Prefixes, matched against the repository-relative path.
 */
export const WRITER_ALLOWLIST = [
    {
        prefix: "lib/conversationCreation.ts",
        reason:
            "The shared creation service itself. It is the one place the row is written, and it takes productKey as a required argument so a caller cannot omit it.",
    },
    {
        prefix: "prisma/generated/",
        reason:
            "Generated Prisma client and its doc comments. Regenerated output, not a call site.",
    },
    {
        prefix: "tests/",
        reason:
            "Test fixtures. A constraint test has to be able to write a row the service would refuse -- that is what it is testing -- and a fixture that had to go through the service could only ever prove the service agrees with itself.",
    },
    {
        prefix: "scripts/check-conversation-writers-core.mjs",
        reason: "This file. A check for a forbidden call has to name the call.",
    },
    {
        prefix: "scripts/check-conversation-writers.mjs",
        reason: "The runner, for the same reason as the core it calls.",
    },
];

export const allowlistEntryFor = (path) =>
    WRITER_ALLOWLIST.find((entry) => path === entry.prefix || path.startsWith(entry.prefix)) ??
    null;

export const findDirectConversationWriters = ({ sources }) => {
    const findings = [];
    for (const { path, text } of sources) {
        if (allowlistEntryFor(path)) continue;
        const lines = text.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            DIRECT_CREATE_PATTERN.lastIndex = 0;
            for (const match of line.matchAll(DIRECT_CREATE_PATTERN)) {
                findings.push({
                    path,
                    line: index + 1,
                    matched: match[0],
                    excerpt: line.trim().slice(0, 160),
                });
            }
        }
    }
    return findings;
};

export const describeFindings = (findings) =>
    [
        `${findings.length} direct conversation.create() call(s) outside the shared ` +
            "creation service.",
        "",
        ...findings.map(
            (finding) => `  ${finding.path}:${finding.line}  ${finding.excerpt}`
        ),
        "",
        "Route the write through createConversation(tx, { ..., productKey }) in",
        "lib/conversationCreation.ts. It takes a Prisma.TransactionClient and opens no",
        "transaction of its own, so it composes with the caller's.",
        "",
        "The three NOT VALID CHECKs all pass `productKey IS NULL`, so a direct create",
        "that omits the column is stored as a legal row. That is what this check is for.",
    ].join("\n");
