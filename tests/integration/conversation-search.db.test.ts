import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { createResourceUnlockCookie } from "@/lib/conversationLock";
import { CONTINUATION_SEED_VERSION } from "@/lib/externalContinuationSeedCore";
import { getContinuationTimeline } from "@/lib/externalContinuationService";
import { searchConversationMessages } from "@/lib/conversationSearch";
import { isStatementTimeout } from "@/lib/conversationSearchResults";
import { readOnlySnapshotTransaction } from "@/lib/readOnlySnapshotTransaction";

/**
 * CONT-SEARCH-01: docs/policy/external-conversation-continuation.md §8.2.
 *
 * What only a database can settle about message search: which rows the
 * candidate SQL reaches, that a locked match cannot move an authorised one,
 * that the LIKE pattern is literal, and what PostgreSQL does when the
 * imported read runs out of time.
 */

const resetData = () =>
    prisma.$executeRawUnsafe(
        `TRUNCATE TABLE "ConversationContinuationBridge", "Message", "Conversation", ` +
            `"ExternalMessage", "ExternalConversation", "ExternalImport", "User" ` +
            `RESTART IDENTITY CASCADE`
    );

beforeEach(resetData);
after(async () => {
    await resetData();
    await prisma.$disconnect();
});

const createUser = () =>
    prisma.user.create({ data: { email: `search-${randomUUID()}@example.test` } });

const seedSnapshot = async (
    userId: string,
    contents: string[],
    options: { password?: string; finalized?: boolean; ordinalStep?: number } = {}
) => {
    const importRow = await prisma.externalImport.create({
        data: {
            userId,
            provider: "chatgpt",
            status: options.finalized === false ? "staging" : "completed",
            digestVersion: 1,
            parserVersion: "test",
        },
    });
    const snapshot = await prisma.externalConversation.create({
        data: {
            userId,
            importId: importRow.id,
            provider: "chatgpt",
            externalStableId: `stable-${randomUUID()}`,
            title: "Imported",
            conversationDigest: `digest-${randomUUID()}`,
            digestVersion: 1,
            messageCount: contents.length,
            contentBytes: BigInt(64 * contents.length),
            finalized: options.finalized ?? true,
            ...(options.password ? { password: options.password } : {}),
        },
    });
    const step = options.ordinalStep ?? 1;
    await prisma.externalMessage.createMany({
        data: contents.map((content, index) => ({
            userId,
            externalConversationId: snapshot.id,
            externalStableId: snapshot.externalStableId,
            role: index % 2 === 0 ? "user" : "assistant",
            content,
            contentDigest: `c-${index}-${snapshot.id}`,
            digestVersion: 1,
            ordinal: index * step,
        })),
    });
    const messages = await prisma.externalMessage.findMany({
        where: { externalConversationId: snapshot.id },
        orderBy: { ordinal: "asc" },
        select: { id: true, ordinal: true },
    });
    return { snapshot, messages };
};

const seedConversation = (
    userId: string,
    options: { password?: string; updatedAt?: Date; messages?: string[] } = {}
) =>
    prisma.conversation.create({
        data: {
            userId,
            title: "A conversation",
            productKey: "review",
            ...(options.password ? { password: options.password } : {}),
            ...(options.updatedAt ? { updatedAt: options.updatedAt } : {}),
            ...(options.messages
                ? {
                      messages: {
                          create: options.messages.map((content) => ({ role: "user", content })),
                      },
                  }
                : {}),
        },
    });

const bridge = (userId: string, conversationId: string, externalConversationId: string) =>
    prisma.conversationContinuationBridge.create({
        data: {
            userId,
            conversationId,
            externalConversationId,
            provider: "chatgpt",
            sourceImportedAt: new Date(),
            sourceConversationDigest: `d-${randomUUID()}`,
            sourceDigestVersion: 1,
            sourceMessageCount: 1,
            seedFromOrdinal: 0,
            seedToOrdinal: 0,
            seedMessageCount: 1,
            seedTruncatedMessageCount: 0,
            seedOmittedMessageCount: 0,
            contextSeedVersion: CONTINUATION_SEED_VERSION,
            idempotencyKey: randomUUID(),
        },
    });

type Grant = { type: "conversation" | "external_conversation"; userId: string; id: string; password: string };

const requestWith = (grants: Grant[] = []) =>
    new Request("https://tomverse.test/api/conversations/search", {
        headers: grants.length
            ? {
                  cookie: grants
                      .map((grant) =>
                          createResourceUnlockCookie(grant.type, grant.userId, grant.id, grant.password).split(";")[0]
                      )
                      .join("; "),
              }
            : {},
    });

const search = (userId: string, query: string, grants: Grant[] = [], sourceTimeoutMs?: number) =>
    searchConversationMessages({
        request: requestWith(grants),
        userId,
        query,
        displayTimeZone: "UTC",
        sourceTimeoutMs,
    });

test("a word only in a linked original is found under its continuation, and nothing unlinked is", async () => {
    const user = await createUser();
    const stranger = await createUser();
    const linked = await seedSnapshot(user.id, ["intro", "the zebrafish plan"]);
    await seedSnapshot(user.id, ["zebrafish in an unlinked import"]);
    await seedSnapshot(user.id, ["zebrafish still staging"], { finalized: false });
    const strangerSnapshot = await seedSnapshot(stranger.id, ["zebrafish of someone else"]);
    const continuation = await seedConversation(user.id);
    await bridge(user.id, continuation.id, linked.snapshot.id);
    const strangerConversation = await seedConversation(stranger.id);
    await bridge(stranger.id, strangerConversation.id, strangerSnapshot.snapshot.id);
    // A stranger's continuation of *this* account's snapshot must not become a target.
    const strangerOnMine = await seedConversation(stranger.id);
    await bridge(stranger.id, strangerOnMine.id, linked.snapshot.id);

    const answer = await search(user.id, "ZEBRAFISH");
    assert.equal(answer.sourceSearch, "ok");
    assert.equal(answer.results.length, 1);
    const [hit] = answer.results;
    assert.equal(hit.kind, "imported");
    assert.equal(hit.conversationId, continuation.id);
    assert.equal(hit.surface, "continuation");
    assert.ok(hit.kind === "imported" && hit.externalMessageId === linked.messages[1].id);
    assert.equal(hit.id, `imported:${linked.messages[1].id}:${continuation.id}`);
    assert.ok(hit.snippetHighlight);
    assert.equal(hit.snippet.slice(hit.snippetHighlight.start, hit.snippetHighlight.end), "zebrafish");
    assert.ok(!("modelId" in hit), "an original's label is not a Tomverse model id");
});

test("each lock hides its own half until its own grant is presented", async () => {
    const user = await createUser();
    const lockedSource = await seedSnapshot(user.id, ["walrus in a locked original"], { password: "source-hash" });
    const openSource = await seedSnapshot(user.id, ["walrus in an open original"]);
    const openContinuation = await seedConversation(user.id);
    await bridge(user.id, openContinuation.id, lockedSource.snapshot.id);
    const lockedContinuation = await seedConversation(user.id, {
        password: "conversation-hash",
        messages: ["walrus in a locked conversation"],
    });
    await bridge(user.id, lockedContinuation.id, openSource.snapshot.id);

    const none = await search(user.id, "walrus");
    assert.deepEqual(none.results, []);
    assert.equal(none.truncated, false);
    assert.equal(none.validUntil, null);

    const sourceGrant: Grant = { type: "external_conversation", userId: user.id, id: lockedSource.snapshot.id, password: "source-hash" };
    const conversationGrant: Grant = { type: "conversation", userId: user.id, id: lockedContinuation.id, password: "conversation-hash" };
    // A native grant does not open the source, and a source grant does not open the conversation.
    const crossed = await search(user.id, "walrus", [
        { ...sourceGrant, type: "conversation" },
        { ...conversationGrant, type: "external_conversation" },
    ]);
    assert.deepEqual(crossed.results, []);

    const both = await search(user.id, "walrus", [sourceGrant, conversationGrant]);
    // The answer quotes text two grants opened, so it may be shown only until
    // the first of them lapses (30 minutes from now, to the second).
    assert.ok(both.validUntil);
    const lapse = Date.parse(both.validUntil) - Date.now();
    assert.ok(lapse > 29 * 60_000 && lapse <= 30 * 60_000, String(lapse));
    assert.deepEqual(
        both.results.map((result) => `${result.kind}:${result.conversationId}`).sort(),
        [
            `imported:${lockedContinuation.id}`,
            `imported:${openContinuation.id}`,
            `native:${lockedContinuation.id}`,
        ].sort()
    );
});

test("the answer expires with a grant it used even when that conversation returned nothing", async () => {
    const user = await createUser();
    await seedConversation(user.id, { messages: ["puffin in the open"] });
    // Unlocked by a grant, and holding no match: it still shaped the answer
    // (it was searched), so the answer may only be shown while that grant lasts.
    const lockedElsewhere = await seedConversation(user.id, {
        password: "hash",
        messages: ["nothing relevant here"],
    });

    const withoutGrant = await search(user.id, "puffin");
    assert.equal(withoutGrant.results.length, 1);
    assert.equal(withoutGrant.validUntil, null);

    const withGrant = await search(user.id, "puffin", [
        { type: "conversation", userId: user.id, id: lockedElsewhere.id, password: "hash" },
    ]);
    assert.deepEqual(
        withGrant.results.map((result) => result.snippet),
        withoutGrant.results.map((result) => result.snippet)
    );
    assert.ok(withGrant.validUntil, "a grant the search used decides how long its answer may be shown");
});

test("a mass of locked matches changes nothing about the authorised answer", async () => {
    const user = await createUser();
    const open = await seedConversation(user.id, {
        updatedAt: new Date("2026-09-01T00:00:00Z"),
        messages: ["otter one", "otter two"],
    });
    const openSource = await seedSnapshot(user.id, ["otter in the original"]);
    const openContinuation = await seedConversation(user.id, { updatedAt: new Date("2026-09-02T00:00:00Z") });
    await bridge(user.id, openContinuation.id, openSource.snapshot.id);

    const baseline = await search(user.id, "otter");

    const busy = Array.from({ length: 150 }, (_, index) => `otter locked ${index}`);
    for (let index = 0; index < 40; index += 1) {
        // Newer than everything authorised, so they would take every candidate slot if they could.
        await seedConversation(user.id, {
            password: "hash",
            updatedAt: new Date("2026-09-10T00:00:00Z"),
            messages: busy.slice(0, 6),
        });
    }
    const lockedSource = await seedSnapshot(user.id, busy, { password: "source-hash" });
    const lockedSourceContinuation = await seedConversation(user.id, { updatedAt: new Date("2026-09-11T00:00:00Z") });
    await bridge(user.id, lockedSourceContinuation.id, lockedSource.snapshot.id);

    const after = await search(user.id, "otter");
    assert.deepEqual(after, baseline);
    assert.equal(baseline.truncated, false);
    assert.ok(baseline.results.some((result) => result.conversationId === open.id));
});

test("the query is a literal substring, not a LIKE pattern", async () => {
    const user = await createUser();
    await seedConversation(user.id, { messages: ["100% done", "100 percent done", "a_b", "axb", "back\\slash"] });
    assert.deepEqual((await search(user.id, "0%")).results.map((r) => r.snippet), ["100% done"]);
    assert.deepEqual((await search(user.id, "a_b")).results.map((r) => r.snippet), ["a_b"]);
    assert.deepEqual((await search(user.id, "k\\s")).results.map((r) => r.snippet), ["back\\slash"]);
});

test("one original shown under two continuations is two distinct results", async () => {
    const user = await createUser();
    const source = await seedSnapshot(user.id, ["pelican"]);
    const first = await seedConversation(user.id, { updatedAt: new Date("2026-09-01T00:00:00Z") });
    const second = await seedConversation(user.id, { updatedAt: new Date("2026-09-02T00:00:00Z") });
    await bridge(user.id, first.id, source.snapshot.id);
    await bridge(user.id, second.id, source.snapshot.id);

    const answer = await search(user.id, "pelican");
    assert.deepEqual(answer.results.map((r) => r.conversationId), [second.id, first.id]);
    assert.equal(new Set(answer.results.map((r) => r.id)).size, 2);
});

test("a conversation shows at most five hits and the answer says there are more", async () => {
    const user = await createUser();
    await seedConversation(user.id, { messages: Array.from({ length: 8 }, (_, i) => `heron ${i}`) });
    const answer = await search(user.id, "heron");
    assert.equal(answer.results.length, 5);
    assert.equal(answer.truncated, true);
});

test("an exhausted source budget drops every imported hit and keeps the native ones", async () => {
    const user = await createUser();
    const source = await seedSnapshot(user.id, ["badger original"]);
    const continuation = await seedConversation(user.id, { messages: ["badger native"] });
    await bridge(user.id, continuation.id, source.snapshot.id);

    const answer = await search(user.id, "badger", [], 0);
    assert.equal(answer.sourceSearch, "timed_out");
    assert.deepEqual(answer.results.map((r) => r.kind), ["native"]);
    // The transaction survived the rolled-back savepoint: names were read after it.
    assert.equal(answer.results[0].surface, "continuation");
});

test("PostgreSQL's statement timeout is recognised in the shape the adapter raises it", async () => {
    await assert.rejects(
        prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT set_config('statement_timeout', '10ms', true)`;
            await tx.$queryRaw`SELECT pg_sleep(0.5)`;
        }),
        (error) => isStatementTimeout(error)
    );
});

test("rolling back to the savepoint restores the statement timeout for later reads", async () => {
    // The sequence lib/conversationSearch.ts uses after a successful imported
    // read. RELEASE alone would keep the lowered timeout for what follows.
    await readOnlySnapshotTransaction(
        async (tx) => {
            await tx.$executeRaw`SAVEPOINT conversation_search_source`;
            await tx.$queryRaw`SELECT set_config('statement_timeout', '20ms', true)`;
            await tx.$executeRaw`ROLLBACK TO SAVEPOINT conversation_search_source`;
            await tx.$executeRaw`RELEASE SAVEPOINT conversation_search_source`;
            await tx.$queryRaw`SELECT pg_sleep(0.2)`;
        },
        { timeout: 5_000, maxWait: 5_000 }
    );
});

test("a bridge whose rows belong to another account names nothing and opens nothing", async () => {
    const user = await createUser();
    const stranger = await createUser();
    const strangerSource = await seedSnapshot(stranger.id, ["secret stranger title body"]);
    await prisma.externalConversation.update({
        where: { id: strangerSource.snapshot.id },
        data: { title: "Stranger's private title" },
    });
    // Malformed on purpose: this account's conversation, bridged to someone
    // else's snapshot. Nothing in the schema forbids the row.
    const mine = await seedConversation(user.id, { messages: ["kestrel in my own turn"] });
    await bridge(user.id, mine.id, strangerSource.snapshot.id);

    const answer = await search(user.id, "kestrel");
    assert.deepEqual(answer.results, []);
    assert.ok(!JSON.stringify(answer).includes("Stranger"));
});

test("malformed conversations cannot take the candidate slots an authorised hit needs", async () => {
    const user = await createUser();
    const stranger = await createUser();
    const strangerSource = await seedSnapshot(stranger.id, ["unrelated"]);
    const healthy = await seedConversation(user.id, {
        updatedAt: new Date("2026-09-01T00:00:00Z"),
        messages: ["sandpiper healthy"],
    });
    const baseline = await search(user.id, "sandpiper");
    assert.deepEqual(baseline.results.map((r) => r.conversationId), [healthy.id]);

    // 31 newer conversations, each full of matches and each bridged to
    // another account's snapshot: without the join they would fill all 186
    // candidate rows ahead of the healthy one.
    for (let index = 0; index < 31; index += 1) {
        const malformed = await seedConversation(user.id, {
            updatedAt: new Date("2026-09-10T00:00:00Z"),
            messages: Array.from({ length: 6 }, (_, i) => `sandpiper malformed ${index}-${i}`),
        });
        await bridge(user.id, malformed.id, strangerSource.snapshot.id);
    }

    assert.deepEqual(await search(user.id, "sandpiper"), baseline);
});

test("seven hits with one timestamp keep the five the ranking would keep", async () => {
    const user = await createUser();
    const conversation = await seedConversation(user.id);
    const at = new Date("2026-09-01T00:00:00.000Z");
    const ids = Array.from({ length: 7 }, (_, i) => `cmsg${String(i).padStart(2, "0")}`);
    await prisma.message.createMany({
        data: ids.map((id) => ({ id, conversationId: conversation.id, role: "user", content: `plover ${id}`, createdAt: at })),
    });
    const answer = await search(user.id, "plover");
    assert.deepEqual(answer.results.map((r) => r.id), [...ids].sort().reverse().slice(0, 5));
    assert.equal(answer.truncated, true);
});

test("the snapshot helper refuses writes", async () => {
    await assert.rejects(
        readOnlySnapshotTransaction(
            (tx) => tx.$executeRaw`INSERT INTO "User" (id, email) VALUES (${randomUUID()}, ${`ro-${randomUUID()}@example.test`})`,
            { timeout: 5_000, maxWait: 5_000 }
        ),
        (error) => /read-only|25006/i.test(String((error as Error)?.message ?? error) + JSON.stringify(error))
    );
});

test("around centres the page on an imported message inside the bridged snapshot only", async () => {
    const user = await createUser();
    const source = await seedSnapshot(
        user.id,
        Array.from({ length: 300 }, (_, i) => `turn ${i}`),
        { ordinalStep: 3 }
    );
    const other = await seedSnapshot(user.id, ["elsewhere"]);
    const continuation = await seedConversation(user.id);
    await bridge(user.id, continuation.id, source.snapshot.id);
    const request = requestWith();

    const target = source.messages[120];
    const centred = await getContinuationTimeline(user.id, continuation.id, {
        request,
        aroundMessageId: target.id,
        limit: 100,
    });
    assert.ok(centred && centred.source.status === "available");
    assert.deepEqual(centred.focus, { found: true });
    assert.equal(centred.source.offset, 70);
    assert.ok(centred.source.messages.some((message) => message.id === target.id));

    const nearEnd = await getContinuationTimeline(user.id, continuation.id, {
        request,
        aroundMessageId: source.messages[298].id,
        limit: 100,
    });
    assert.ok(nearEnd && nearEnd.source.status === "available");
    assert.equal(nearEnd.source.offset, 200);

    const foreign = await getContinuationTimeline(user.id, continuation.id, {
        request,
        aroundMessageId: other.messages[0].id,
        limit: 100,
    });
    assert.ok(foreign && foreign.source.status === "available");
    assert.deepEqual(foreign.focus, { found: false });
    assert.equal(foreign.source.offset, 200, "an id outside the snapshot opens at the end");

    await prisma.externalConversation.update({
        where: { id: source.snapshot.id },
        data: { password: "hash" },
    });
    const locked = await getContinuationTimeline(user.id, continuation.id, {
        request,
        aroundMessageId: target.id,
        limit: 100,
    });
    assert.ok(locked);
    assert.equal(locked.source.status, "locked");
    assert.equal(locked.focus, undefined, "a locked source does not say whether the id was there");
});
