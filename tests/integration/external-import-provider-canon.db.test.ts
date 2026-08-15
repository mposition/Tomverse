import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
    EXTERNAL_IMPORT_PROVIDERS,
    isExternalImportProvider,
} from "@/lib/externalImportProviders";
import { EXTERNAL_IMPORT_ADAPTERS } from "@/lib/externalImportAdapters";
import { EXTERNAL_IMPORT_DIGEST_VERSION } from "@/lib/externalImportDigest";

/**
 * The provider set, held together across the boundary it was written on both
 * sides of.
 *
 * docs/policy/external-import-gemini-a2.md §3.
 *
 * Gemini was added to the adapter union and to nothing else. The browser
 * parsed a Takeout export, the wizard posted `provider: "gemini"`, and the
 * create route's schema refused it -- with the database's CHECK constraints
 * waiting behind that with the same answer. No type could catch it: the value
 * crosses as JSON, and SQL cannot import TypeScript at all.
 *
 * So the set has one authority, and this file is what makes the copies that
 * cannot import it agree with it. The database half needs a real PostgreSQL,
 * which is why these live here rather than in a unit test.
 *
 * No module mocks, so this runs in the shared batch.
 */

const resetData = () =>
    prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "ExternalConversation", "ExternalImport", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(resetData);

after(async () => {
    await resetData();
    await prisma.$disconnect();
});

/** The values a CHECK constraint actually admits, read from the catalogue. */
const checkedProviders = async (constraint: string): Promise<string[]> => {
    const [row] = await prisma.$queryRawUnsafe<{ definition: string }[]>(
        `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint WHERE conname = $1`,
        constraint
    );
    assert.ok(row, `${constraint} must exist`);
    // CHECK (provider = ANY (ARRAY['chatgpt'::text, ...])) or an IN list,
    // depending on how PostgreSQL chose to print it. Either way the quoted
    // literals are the set.
    return [...row.definition.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
};

const seedUser = () =>
    prisma.user.create({ data: { email: `importer-${randomUUID()}@example.test` } });

test("every registered adapter names a canonical provider, and every canonical provider has one", () => {
    const registered = EXTERNAL_IMPORT_ADAPTERS.map((a) => a.provider).sort();
    assert.deepEqual(registered, [...EXTERNAL_IMPORT_PROVIDERS].sort());
});

test("the guard admits exactly the canonical set", () => {
    for (const provider of EXTERNAL_IMPORT_PROVIDERS) {
        assert.equal(isExternalImportProvider(provider), true);
    }
    for (const other of ["", "GEMINI", "gemini ", "copilot", null, 7]) {
        assert.equal(isExternalImportProvider(other), false, `${String(other)} is not one`);
    }
});

test("both CHECK constraints admit exactly the canonical set", async () => {
    // The copy SQL keeps because it cannot import the canon. If a provider is
    // added to the list and not to a migration, an import for it parses in the
    // browser and then cannot be written -- which is what happened.
    const expected = [...EXTERNAL_IMPORT_PROVIDERS].sort();
    assert.deepEqual(await checkedProviders("ExternalImport_provider_check"), expected);
    assert.deepEqual(await checkedProviders("ExternalConversation_provider_check"), expected);
});

test("a row can be written for every canonical provider", async () => {
    const user = await seedUser();
    for (const provider of EXTERNAL_IMPORT_PROVIDERS) {
        const record = await prisma.externalImport.create({
            data: {
                userId: user.id,
                provider,
                parserVersion: "v3",
                digestVersion: EXTERNAL_IMPORT_DIGEST_VERSION,
                status: "staging",
            },
        });
        assert.equal(record.provider, provider);
        await prisma.externalConversation.create({
            data: {
                userId: user.id,
                importId: record.id,
                provider,
                // The raw provider-side ID is never stored; the row keeps a
                // digest of it (§4.2).
                externalStableId: `stable-${provider}`,
                conversationDigest: `digest-${provider}`,
                digestVersion: EXTERNAL_IMPORT_DIGEST_VERSION,
                title: "t",
                messageCount: 0,
                contentBytes: 0,
            },
        });
    }
});

test("a provider outside the set is refused by the database, not merely by the schema", async () => {
    // The last line of defence: even a caller that bypassed the request schema
    // cannot write a provider nobody has a parser for.
    const user = await seedUser();
    await assert.rejects(
        prisma.$executeRawUnsafe(
            `INSERT INTO "ExternalImport"
               ("id","userId","provider","parserVersion","digestVersion","status","createdAt","updatedAt")
             VALUES ($1,$2,'copilot','v3',1,'staging',NOW(),NOW())`,
            randomUUID(),
            user.id
        ),
        /ExternalImport_provider_check|violates check constraint/
    );
});
