import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/public/shares/[shareToken]/route";
import { SHARE_SNAPSHOT_VERSION } from "@/lib/shareSnapshot";

/**
 * The public shared-conversation endpoint, against a real database.
 *
 * This is the only unauthenticated route that serves a customer's own chat
 * transcript, and everything protecting it is a condition on one query: the
 * share is enabled, its expiry is in the future, and the stored snapshot still
 * parses. Each of those is a separate way to hand a private conversation to
 * someone holding a stale link, and none was driven end to end -- the snapshot
 * *shape* is pinned in tests/memoryReleaseContracts.test.mjs, but nothing
 * asked the route what it does with a revoked share or an expired one.
 *
 * The schema check earns its place here rather than in a unit test. Parsing is
 * what stops a snapshot that was widened -- by a future field, or by anything
 * written straight into the column -- from reaching a stranger's browser, and
 * proving that means asking the route, not the schema.
 *
 * No module mocks: a real Postgres is the whole fixture, which is why this
 * file runs in the shared batch rather than its own process.
 */

const resetData = () =>
    prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "Conversation", "ChatUsageBucket", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(resetData);

after(async () => {
    await resetData();
    await prisma.$disconnect();
});

let owner: { id: string };

const strongToken = () => randomBytes(24).toString("base64url");

const validSnapshot = () => ({
    version: SHARE_SNAPSHOT_VERSION,
    title: "Shared conversation",
    conversationCreatedAt: "2026-08-01T00:00:00.000Z",
    sharedAt: "2026-08-02T00:00:00.000Z",
    messages: [
        {
            id: "m-1",
            role: "assistant",
            content: "An answer that was shared.",
            modelId: "gpt-5-6-luna",
            createdAt: "2026-08-01T00:00:01.000Z",
        },
    ],
});

const seedShare = async (overrides: {
    shareToken: string;
    shareEnabled?: boolean;
    shareExpiresAt?: Date | null;
    shareSnapshot?: unknown;
}) => {
    owner = await prisma.user.create({
        data: { email: `sharer-${randomUUID()}@example.test` },
    });
    return prisma.conversation.create({
        data: {
            userId: owner.id,
            title: "A private conversation",
            shareToken: overrides.shareToken,
            shareEnabled: overrides.shareEnabled ?? true,
            shareExpiresAt:
                overrides.shareExpiresAt === undefined
                    ? new Date(Date.now() + 24 * 60 * 60 * 1000)
                    : overrides.shareExpiresAt,
            shareSnapshot:
                overrides.shareSnapshot === undefined
                    ? (validSnapshot() as object)
                    : (overrides.shareSnapshot as object),
        },
    });
};

const read = async (shareToken: string) => {
    const response = await GET(
        new Request(`https://tomverse.test/api/public/shares/${shareToken}`),
        { params: Promise.resolve({ shareToken }) }
    );
    return { response, body: await response.json() };
};

/** Every response, including refusals, has to carry these. */
const assertNoStore = (response: Response) => {
    assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0");
    assert.equal(response.headers.get("CDN-Cache-Control"), "no-store");
    assert.match(response.headers.get("X-Robots-Tag") || "", /noindex/);
};

test("a live share serves its snapshot and its expiry", async () => {
    const token = strongToken();
    await seedShare({ shareToken: token });

    const { response, body } = await read(token);
    assert.equal(response.status, 200);
    assert.equal(body.snapshot.title, "Shared conversation");
    assert.equal(body.snapshot.messages.length, 1);
    assert.ok(body.expiresAt, "the viewer is told when the link dies");
    // A CDN that cached this would keep serving it after the link expired.
    assertNoStore(response);
});

test("a revoked share is not found, however valid the token", async () => {
    // Revocation flips the flag; the token itself keeps working as a lookup
    // key, so this is the condition doing the work.
    const token = strongToken();
    await seedShare({ shareToken: token, shareEnabled: false });

    const { response, body } = await read(token);
    assert.equal(response.status, 404);
    assert.equal(body.snapshot, undefined);
    assertNoStore(response);
});

test("an expired share is not found", async () => {
    const token = strongToken();
    await seedShare({
        shareToken: token,
        shareExpiresAt: new Date(Date.now() - 1_000),
    });

    assert.equal((await read(token)).response.status, 404);
});

test("a share with no expiry at all is not found", async () => {
    // A null expiry is not "never expires": the query asks for a future
    // instant, and a row without one has no claim to be served.
    const token = strongToken();
    await seedShare({ shareToken: token, shareExpiresAt: null });

    assert.equal((await read(token)).response.status, 404);
});

test("a snapshot that no longer parses is refused, not partly rendered", async () => {
    // The §13.3 defence in its live form. A snapshot widened by anything --
    // a future field, or a write straight into the column -- must stop here
    // rather than reach a stranger's browser in whatever shape it has.
    const token = strongToken();
    await seedShare({
        shareToken: token,
        shareSnapshot: { version: SHARE_SNAPSHOT_VERSION, title: "No messages" },
    });

    const { response, body } = await read(token);
    assert.equal(response.status, 404);
    assert.equal(body.snapshot, undefined);
});

test("only the parsed snapshot is served, never the stored column", async () => {
    // Extra keys written into `shareSnapshot` are dropped by parsing. If the
    // route returned the column, a memory-shaped field added by any future
    // writer would be published to whoever holds the link.
    const token = strongToken();
    await seedShare({
        shareToken: token,
        shareSnapshot: {
            ...validSnapshot(),
            memoryContext: "What is known about the user: …",
            ownerEmail: "sharer@example.test",
        },
    });

    const { response, body } = await read(token);
    assert.equal(response.status, 200);
    const serialized = JSON.stringify(body);
    assert.ok(
        !serialized.includes("What is known about the user"),
        `the stored column must not be served verbatim: ${serialized}`
    );
    assert.ok(!serialized.includes("sharer@example.test"));
    assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "snapshot"]);
});

test("a weak token is refused before the database is asked anything", async () => {
    // `isStrongShareToken` runs first on purpose. The rate limiter is keyed on
    // the token, so accepting junk keys would let anyone fill that namespace,
    // and a short token is not a share link that was ever issued.
    for (const token of ["short", "not/base64url", "", "a".repeat(200)]) {
        const response = await GET(
            new Request(`https://tomverse.test/api/public/shares/${token}`),
            { params: Promise.resolve({ shareToken: token }) }
        );
        assert.equal(response.status, 404, `${token} must be refused`);
        assertNoStore(response);
    }
    assert.equal(
        await prisma.chatUsageBucket.count(),
        0,
        "a refused token consumes no rate-limit budget"
    );
});

test("an unknown but well-formed token is not found", async () => {
    assert.equal((await read(strongToken())).response.status, 404);
});
