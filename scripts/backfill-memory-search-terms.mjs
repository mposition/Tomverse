// Fills MemoryItem.searchTerms for rows written before the retrieval v1
// tokenizer existed, and re-indexes rows whose retrievalVersion is behind.
//
// Why a backfill at all: `searchTerms` shipped as an empty array with a GIN
// index over it, and the write paths only started populating it in the B4
// slice. A row with no terms is invisible to lexical retrieval, and invisible
// is indistinguishable from "this user has no relevant memories" — so without
// this, memory injection would look like it worked while silently ignoring
// everything imported before the tokenizer landed.
//
// Safe to run repeatedly and safe to interrupt: it processes rows in id order
// in bounded batches, decides each row independently, and skips rows whose
// terms already match what the current tokenizer produces. Re-running after a
// crash resumes by simply finding the remaining stale rows. Defaults to a dry
// run.
//
// Usage:
//   node --import tsx scripts/backfill-memory-search-terms.mjs
//   node --import tsx scripts/backfill-memory-search-terms.mjs --apply
//   node --import tsx scripts/backfill-memory-search-terms.mjs --apply --batch=500
//
// Requires DATABASE_URL. Reads and writes only MemoryItem.searchTerms and
// MemoryItem.retrievalVersion. It never touches statements, status, evidence,
// approval state or any other column: re-indexing is not a review, and a row
// the user rejected stays rejected.

// The application's own client, not a bare `new PrismaClient()`: this project
// connects through a PrismaPg driver adapter, and a client constructed without
// one throws before it ever reaches a query.
import { prisma } from "../lib/prisma.ts";
import {
    MEMORY_RETRIEVAL_VERSION,
    memoryRetrievalTerms,
    memoryTermsAreCurrent,
} from "../lib/memoryRetrievalTerms.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const batchArg = args.find((argument) => argument.startsWith("--batch="));
const batchSize = Math.min(
    Math.max(Number(batchArg?.split("=")[1]) || 200, 1),
    1000
);

const summary = {
    scanned: 0,
    alreadyCurrent: 0,
    indexed: 0,
    emptied: 0,
};

async function main() {
    let cursor = null;
    for (;;) {
        const rows = await prisma.memoryItem.findMany({
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            take: batchSize,
            orderBy: { id: "asc" },
            select: {
                id: true,
                statement: true,
                searchTerms: true,
                retrievalVersion: true,
            },
        });
        if (rows.length === 0) break;
        cursor = rows[rows.length - 1].id;

        for (const row of rows) {
            summary.scanned += 1;
            if (memoryTermsAreCurrent(row, MEMORY_RETRIEVAL_VERSION)) {
                summary.alreadyCurrent += 1;
                continue;
            }
            const searchTerms = memoryRetrievalTerms(row.statement);
            // A statement that tokenizes to nothing is a real outcome, not a
            // failure — punctuation-only statements exist. Recording it as an
            // empty array at the current version stops the row from being
            // rescanned as work on every future run.
            if (searchTerms.length === 0) summary.emptied += 1;
            else summary.indexed += 1;

            if (apply) {
                await prisma.memoryItem.update({
                    where: { id: row.id },
                    data: {
                        searchTerms,
                        retrievalVersion: MEMORY_RETRIEVAL_VERSION,
                    },
                });
            }
        }
    }

    console.log(
        JSON.stringify(
            {
                event: "memory_search_terms_backfill",
                mode: apply ? "apply" : "dry_run",
                retrievalVersion: MEMORY_RETRIEVAL_VERSION,
                ...summary,
            },
            null,
            2
        )
    );
    if (!apply && summary.indexed + summary.emptied > 0) {
        console.log(
            `\n${summary.indexed + summary.emptied} row(s) would be re-indexed. Re-run with --apply.`
        );
    }
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
