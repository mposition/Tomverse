import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * §7, §7.1 — the snapshot lock driven through its real routes.
 *
 * `external-conversation-lock.db.test.ts` proves the service: what locking
 * does to memories, and that a grant opens the read. What it cannot prove is
 * the part a caller actually meets — that changing or removing a lock demands
 * the current password, that a wrong one is counted and eventually refused,
 * and that the cookie the route hands back is the one the reader accepts.
 * Those live in the route, so they are asserted here.
 *
 * Its own process under scripts/run-db-integration-tests.mjs: mock.module is
 * process-global and this file replaces next-auth for every module importing
 * it.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
    pathToFileURL(resolve(ROOT, relativePath)).href;

const PASSWORD = "first-password-1";
const NEXT_PASSWORD = "second-password-2";

let sessionOverride: unknown = null;
mock.module("next-auth", {
    namedExports: { getServerSession: async () => sessionOverride },
});

type LockRoute = {
    GET: (request: Request, context: unknown) => Promise<Response>;
    PUT: (request: Request, context: unknown) => Promise<Response>;
};
type VerifyRoute = {
    POST: (request: Request, context: unknown) => Promise<Response>;
};

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let lockRoute: LockRoute;
let verifyRoute: VerifyRoute;
let getExternalConversation: (typeof import("@/lib/externalImportService"))["getExternalConversation"];
let externalContentDigest: (typeof import("@/lib/externalImportDigest"))["externalContentDigest"];
let memoryRetrievalTerms: (typeof import("@/lib/memoryRetrievalTerms"))["memoryRetrievalTerms"];

before(async () => {
    ({ prisma } = (await import(
        mod("lib/prisma.ts")
    )) as typeof import("@/lib/prisma"));
    ({ externalContentDigest } = (await import(
        mod("lib/externalImportDigest.ts")
    )) as typeof import("@/lib/externalImportDigest"));
    ({ memoryRetrievalTerms } = (await import(
        mod("lib/memoryRetrievalTerms.ts")
    )) as typeof import("@/lib/memoryRetrievalTerms"));
    ({ getExternalConversation } = (await import(
        mod("lib/externalImportService.ts")
    )) as typeof import("@/lib/externalImportService"));
    lockRoute = (await import(
        mod("app/api/external-conversations/[conversationId]/lock/route.ts")
    )) as LockRoute;
    verifyRoute = (await import(
        mod(
            "app/api/external-conversations/[conversationId]/lock/verify/route.ts"
        )
    )) as VerifyRoute;
});

const resetData = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MemoryEvidence",
      "MemoryItem",
      "ExternalMessage",
      "ExternalConversation",
      "ExternalImport",
      "ChatUsageBucket"
    RESTART IDENTITY CASCADE
  `);
};

/** One account with one finalized snapshot, one message and one memory. */
const seedAccount = async () => {
    const user = await prisma.user.create({
        data: { email: `lock-route-${randomUUID()}@example.test` },
    });
    const importRow = await prisma.externalImport.create({
        data: {
            userId: user.id,
            provider: "chatgpt",
            status: "completed",
            parserVersion: "test-1",
            digestVersion: 1,
        },
    });
    const conversation = await prisma.externalConversation.create({
        data: {
            userId: user.id,
            importId: importRow.id,
            provider: "chatgpt",
            externalStableId: randomUUID().replaceAll("-", ""),
            title: "lock route fixture",
            conversationDigest: randomUUID().replaceAll("-", "").repeat(2),
            digestVersion: 1,
            messageCount: 1,
            contentBytes: BigInt(10),
            finalized: true,
        },
    });
    const content = `message ${conversation.id}`;
    const message = await prisma.externalMessage.create({
        data: {
            userId: user.id,
            externalConversationId: conversation.id,
            externalStableId: randomUUID().replaceAll("-", ""),
            role: "user",
            content,
            contentDigest: externalContentDigest(content),
            digestVersion: 1,
            ordinal: 0,
        },
    });
    const statement = "사용자는 커피를 좋아한다";
    const memory = await prisma.memoryItem.create({
        data: {
            userId: user.id,
            kind: "preference",
            statement,
            status: "active",
            confidence: 0.9,
            approvedAt: new Date("2026-08-01T00:00:00.000Z"),
            searchTerms: memoryRetrievalTerms(statement),
            retrievalVersion: 1,
        },
    });
    await prisma.memoryEvidence.create({
        data: {
            memoryItemId: memory.id,
            userId: user.id,
            sourceType: "external_message",
            externalMessageId: message.id,
            evidenceDigest: externalContentDigest(`${memory.id}:${message.id}`),
        },
    });
    sessionOverride = { user: { id: user.id, email: user.email } };
    return { user, conversation, memory };
};

const context = (conversationId: string) => ({
    params: Promise.resolve({ conversationId }),
});

const jsonRequest = (body: unknown, cookie = "") =>
    new Request("https://tomverse.test/api/external-conversations/x/lock", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
    });

/** The Set-Cookie value a route handed back, reduced to `name=value`. */
const grantFrom = (response: Response) => {
    const header = response.headers.get("set-cookie");
    return header ? header.split(";")[0] : null;
};

const statusOf = async (memoryId: string) =>
    (
        await prisma.memoryItem.findUnique({
            where: { id: memoryId },
            select: { status: true },
        })
    )?.status ?? null;

const lockedFor = async (conversationId: string) =>
    (
        await prisma.externalConversation.findUnique({
            where: { id: conversationId },
            select: { password: true },
        })
    )?.password != null;

beforeEach(async () => {
    sessionOverride = null;
    await resetData();
});

after(async () => {
    await resetData();
    await prisma.$disconnect();
});

/* --------------------------------------------------------------- setting it */

test("setting a lock stores it, suspends the memory and returns a usable grant", async () => {
    const { conversation, memory, user } = await seedAccount();

    const response = await lockRoute.PUT(
        jsonRequest({ password: PASSWORD }),
        context(conversation.id)
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        conversationId: conversation.id,
        locked: true,
        memoriesSuspended: 1,
        memoriesRestored: 0,
        memoriesExpired: 0,
    });
    assert.equal(await statusOf(memory.id), "suspended_by_source_lock");

    // The grant is issued here rather than making the owner retype the
    // password they just chose, so it has to actually open the read.
    const cookie = grantFrom(response);
    assert.ok(cookie);
    assert.ok(cookie.startsWith("tomverse_unlock_external_conversation_"));
    const view = await getExternalConversation(user.id, conversation.id, {
        request: new Request("https://tomverse.test/", {
            headers: { cookie },
        }),
    });
    assert.equal(view.locked, true);
    assert.equal(view.messages.length, 1);
});

test("setting a lock does not ask for a password that does not exist yet", async () => {
    const { conversation } = await seedAccount();
    const response = await lockRoute.PUT(
        // No currentPassword: there is nothing to prove.
        jsonRequest({ password: PASSWORD }),
        context(conversation.id)
    );
    assert.equal(response.status, 200);
});

test("a signed-out caller cannot lock anything", async () => {
    const { conversation } = await seedAccount();
    sessionOverride = null;
    const response = await lockRoute.PUT(
        jsonRequest({ password: PASSWORD }),
        context(conversation.id)
    );
    assert.equal(response.status, 401);
    assert.equal(await lockedFor(conversation.id), false);
});

test("a non-owner gets the same 404 every snapshot surface gives", async () => {
    const { conversation } = await seedAccount();
    const stranger = await prisma.user.create({
        data: { email: `stranger-${randomUUID()}@example.test` },
    });
    sessionOverride = { user: { id: stranger.id, email: stranger.email } };

    const response = await lockRoute.PUT(
        jsonRequest({ password: PASSWORD }),
        context(conversation.id)
    );
    assert.equal(response.status, 404);
    assert.equal(await lockedFor(conversation.id), false);
});

test("a password shorter than the minimum is refused before anything is stored", async () => {
    const { conversation } = await seedAccount();
    const response = await lockRoute.PUT(
        jsonRequest({ password: "short" }),
        context(conversation.id)
    );
    assert.equal(response.status >= 400, true);
    assert.equal(await lockedFor(conversation.id), false);
});

/* -------------------------------------------------------------- changing it */

test("changing a lock without the current password is refused", async () => {
    const { conversation } = await seedAccount();
    await lockRoute.PUT(
        jsonRequest({ password: PASSWORD }),
        context(conversation.id)
    );

    const response = await lockRoute.PUT(
        jsonRequest({ password: NEXT_PASSWORD }),
        context(conversation.id)
    );
    assert.equal(response.status, 403);

    // The old password still works, i.e. nothing was written.
    const verify = await verifyRoute.POST(
        jsonRequest({ password: PASSWORD }),
        context(conversation.id)
    );
    assert.equal(verify.status, 200);
});

test("a change with no password at all does not spend an attempt", async () => {
    // A client that forgets the field has guessed nothing, so it must not cost
    // the owner one of their five tries — otherwise a broken form could lock
    // someone out of their own snapshot for fifteen minutes.
    const { conversation } = await seedAccount();
    await lockRoute.PUT(
        jsonRequest({ password: PASSWORD }),
        context(conversation.id)
    );
    for (let attempt = 0; attempt < 6; attempt += 1) {
        const refused = await lockRoute.PUT(
            jsonRequest({ password: NEXT_PASSWORD }),
            context(conversation.id)
        );
        assert.equal(refused.status, 403);
    }

    const verify = await verifyRoute.POST(
        jsonRequest({ password: PASSWORD }),
        context(conversation.id)
    );
    assert.equal(verify.status, 200, "the budget was never touched");
});

test("changing a lock with the current password issues a grant for the new one", async () => {
    const { conversation } = await seedAccount();
    await lockRoute.PUT(
        jsonRequest({ password: PASSWORD }),
        context(conversation.id)
    );

    const response = await lockRoute.PUT(
        jsonRequest({
            password: NEXT_PASSWORD,
            currentPassword: PASSWORD,
        }),
        context(conversation.id)
    );
    assert.equal(response.status, 200);

    const stale = await verifyRoute.POST(
        jsonRequest({ password: PASSWORD }),
        context(conversation.id)
    );
    assert.equal(stale.status, 403, "the replaced password is dead");

    const fresh = await verifyRoute.POST(
        jsonRequest({ password: NEXT_PASSWORD }),
        context(conversation.id)
    );
    assert.equal(fresh.status, 200);
});

/* --------------------------------------------------------------- removing it */

test("removing a lock without the current password is refused", async () => {
    const { conversation, memory } = await seedAccount();
    await lockRoute.PUT(
        jsonRequest({ password: PASSWORD }),
        context(conversation.id)
    );

    const response = await lockRoute.PUT(
        jsonRequest({ password: null }),
        context(conversation.id)
    );
    assert.equal(response.status, 403);
    assert.equal(await lockedFor(conversation.id), true);
    assert.equal(
        await statusOf(memory.id),
        "suspended_by_source_lock",
        "a refused removal must not restore the memory either"
    );
});

test("removing a lock restores the memory and clears the grant", async () => {
    const { conversation, memory } = await seedAccount();
    await lockRoute.PUT(
        jsonRequest({ password: PASSWORD }),
        context(conversation.id)
    );

    const response = await lockRoute.PUT(
        jsonRequest({ password: null, currentPassword: PASSWORD }),
        context(conversation.id)
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { memoriesRestored: number };
    assert.equal(body.memoriesRestored, 1);
    assert.equal(await statusOf(memory.id), "active");
    assert.equal(await lockedFor(conversation.id), false);

    // Cleared rather than left to expire: a stale grant would silently open a
    // snapshot re-locked with a different password inside the TTL.
    const cookie = grantFrom(response);
    assert.ok(cookie?.endsWith("="), `expected a cleared cookie, got ${cookie}`);
});

test("removing a lock that is not set is a no-op, not an error", async () => {
    const { conversation } = await seedAccount();
    const response = await lockRoute.PUT(
        jsonRequest({ password: null }),
        context(conversation.id)
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        locked: false,
        memoriesSuspended: 0,
        memoriesRestored: 0,
        memoriesExpired: 0,
    });
});

/* -------------------------------------------------------------- verifying it */

test("the right password returns a grant that opens the read", async () => {
    const { conversation, user } = await seedAccount();
    await lockRoute.PUT(
        jsonRequest({ password: PASSWORD }),
        context(conversation.id)
    );

    const response = await verifyRoute.POST(
        jsonRequest({ password: PASSWORD }),
        context(conversation.id)
    );
    assert.equal(response.status, 200);
    const cookie = grantFrom(response);
    assert.ok(cookie);
    const view = await getExternalConversation(user.id, conversation.id, {
        request: new Request("https://tomverse.test/", {
            headers: { cookie },
        }),
    });
    assert.equal(view.messages.length, 1);
});

test("the wrong password is refused and hands back nothing", async () => {
    const { conversation } = await seedAccount();
    await lockRoute.PUT(
        jsonRequest({ password: PASSWORD }),
        context(conversation.id)
    );

    const response = await verifyRoute.POST(
        jsonRequest({ password: "not-the-password" }),
        context(conversation.id)
    );
    assert.equal(response.status, 403);
    assert.equal(grantFrom(response), null);
});

test("verifying an unlocked snapshot is a 400, not a grant", async () => {
    const { conversation } = await seedAccount();
    const response = await verifyRoute.POST(
        jsonRequest({ password: PASSWORD }),
        context(conversation.id)
    );
    assert.equal(response.status, 400);
    assert.equal(grantFrom(response), null);
});

test("repeated wrong passwords stop being answered", async () => {
    // The whole point of a short password is that guessing has to be
    // expensive. Five attempts per fifteen minutes, then refusal.
    const { conversation } = await seedAccount();
    await lockRoute.PUT(
        jsonRequest({ password: PASSWORD }),
        context(conversation.id)
    );

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await verifyRoute.POST(
            jsonRequest({ password: `wrong-${attempt}` }),
            context(conversation.id)
        );
        statuses.push(response.status);
    }
    assert.deepEqual(statuses.slice(0, 5), [403, 403, 403, 403, 403]);
    assert.equal(statuses[5], 429);

    // And the limiter does not open for the right password either, or the
    // limit would only slow down an attacker who never guesses correctly.
    const correct = await verifyRoute.POST(
        jsonRequest({ password: PASSWORD }),
        context(conversation.id)
    );
    assert.equal(correct.status, 429);
});

test("a successful unlock clears the attempts it took to get there", async () => {
    const { conversation } = await seedAccount();
    await lockRoute.PUT(
        jsonRequest({ password: PASSWORD }),
        context(conversation.id)
    );

    for (let attempt = 0; attempt < 4; attempt += 1) {
        await verifyRoute.POST(
            jsonRequest({ password: `wrong-${attempt}` }),
            context(conversation.id)
        );
    }
    const success = await verifyRoute.POST(
        jsonRequest({ password: PASSWORD }),
        context(conversation.id)
    );
    assert.equal(success.status, 200);

    // A typo before remembering the password must not leave the owner one
    // mistake away from being locked out for fifteen minutes.
    const after = await verifyRoute.POST(
        jsonRequest({ password: "wrong-again" }),
        context(conversation.id)
    );
    assert.equal(after.status, 403);
});

/* ----------------------------------------------------------------- preview */

test("the preview says what locking would cost, and locks nothing", async () => {
    const { conversation } = await seedAccount();
    const response = await lockRoute.GET(
        new Request("https://tomverse.test/"),
        context(conversation.id)
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        locked: false,
        memoryImpact: { blockedCount: 1, backedCount: 0 },
    });
    assert.equal(await lockedFor(conversation.id), false);
});

test("the preview tells a non-owner nothing but 404", async () => {
    const { conversation } = await seedAccount();
    const stranger = await prisma.user.create({
        data: { email: `stranger-${randomUUID()}@example.test` },
    });
    sessionOverride = { user: { id: stranger.id, email: stranger.email } };

    const response = await lockRoute.GET(
        new Request("https://tomverse.test/"),
        context(conversation.id)
    );
    assert.equal(response.status, 404);
});
