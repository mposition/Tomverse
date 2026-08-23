import { strict as assert } from "node:assert";
import test from "node:test";

import {
    allowlistEntryFor,
    describeFindings,
    findDirectConversationWriters,
    NON_WRITER_PATTERN,
    WRITER_ALLOWLIST,
} from "../scripts/check-conversation-writers-core.mjs";

/**
 * The check exists because the three NOT VALID CHECKs all pass
 * `productKey IS NULL`, so a writer that omits the column produces a legal
 * row. Two failure modes, and both are worse than no check: too narrow and a
 * fourth writer lands unnoticed; too broad and somebody switches it off. So
 * the false positives are pinned as deliberately as the true ones.
 */

const find = (sources) => findDirectConversationWriters({ sources });

/* ----------------------------------------------------- true positives */

test("a new direct create in production code is a finding", () => {
    const findings = find([
        {
            path: "app/api/something/route.ts",
            text: "const row = await tx.conversation.create({ data: { userId, title } });",
        },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].path, "app/api/something/route.ts");
    assert.equal(findings[0].line, 1);
});

test("a direct create in lib is a finding", () => {
    const findings = find([
        { path: "lib/somethingService.ts", text: "await prisma.conversation.create({" },
    ]);
    assert.equal(findings.length, 1);
});

test("whitespace around the member access does not hide it", () => {
    const findings = find([
        { path: "lib/x.ts", text: "await tx . conversation . create ( { data } )" },
    ]);
    assert.equal(findings.length, 1);
});

test("every occurrence is reported, not just the first per file", () => {
    const findings = find([
        {
            path: "lib/x.ts",
            text: ["tx.conversation.create({", "", "tx.conversation.create({"].join("\n"),
        },
    ]);
    assert.deepEqual(
        findings.map((finding) => finding.line),
        [1, 3]
    );
});

/* ---------------------------------------------------- false positives */

test("conversation.createdAt is a property read, not a writer", () => {
    // v1 of the decision record counted lib/guestImport.ts and
    // app/api/admin/users/[userId]/route.ts as writers on exactly this
    // mistake. Neither creates a conversation.
    const findings = find([
        {
            path: "lib/guestImport.ts",
            text: "createdAt: conversation.createdAt || new Date().toISOString(),",
        },
        {
            path: "app/api/admin/users/[userId]/route.ts",
            text: "createdAt: conversation.createdAt.toISOString(),",
        },
    ]);
    assert.deepEqual(findings, []);
    assert.match("conversation.createdAt", NON_WRITER_PATTERN);
});

test("conversation.createMany is not matched by the create pattern", () => {
    const findings = find([
        { path: "lib/x.ts", text: "await tx.conversation.createMany({ data: rows });" },
        { path: "lib/y.ts", text: "await tx.conversation.createManyAndReturn({ data });" },
    ]);
    assert.deepEqual(findings, []);
});

test("another model's create is not this check's business", () => {
    const findings = find([
        { path: "lib/x.ts", text: "await tx.message.create({ data });" },
        { path: "lib/y.ts", text: "await tx.externalConversation.create({ data });" },
    ]);
    assert.deepEqual(findings, []);
});

test("the shared service reads as a caller, not a writer", () => {
    const findings = find([
        {
            path: "app/api/conversations/route.ts",
            text: "return createConversation(tx, { userId, title, productKey });",
        },
    ]);
    assert.deepEqual(findings, []);
});

/* -------------------------------------------------------- allowlisting */

test("the shared creation service may write directly", () => {
    const findings = find([
        { path: "lib/conversationCreation.ts", text: "tx.conversation.create({ data })" },
    ]);
    assert.deepEqual(findings, []);
});

test("test fixtures may write directly", () => {
    // A constraint test has to write a row the service would refuse; that is
    // what it is testing.
    const findings = find([
        {
            path: "tests/integration/conversation-product-key.db.test.ts",
            text: "prisma.conversation.create({ data: { userId, productKey: 'code' } })",
        },
    ]);
    assert.deepEqual(findings, []);
});

test("generated Prisma code may name the call", () => {
    const findings = find([
        {
            path: "prisma/generated/prisma/models/Conversation.ts",
            text: "* const Conversation = await prisma.conversation.create({",
        },
    ]);
    assert.deepEqual(findings, []);
});

test("a sibling of an allowlisted file is still checked", () => {
    const findings = find([
        { path: "lib/conversationCreateHandler.ts", text: "tx.conversation.create({" },
    ]);
    assert.equal(findings.length, 1);
});

test("every allowlist entry states a reason", () => {
    for (const entry of WRITER_ALLOWLIST) {
        assert.ok(entry.prefix.length > 0);
        assert.ok(
            typeof entry.reason === "string" && entry.reason.length > 20,
            `${entry.prefix} states why it may write directly`
        );
    }
});

test("allowlistEntryFor names which entry excused a path", () => {
    assert.equal(allowlistEntryFor("tests/integration/x.db.test.ts")?.prefix, "tests/");
    assert.equal(allowlistEntryFor("app/api/conversations/route.ts"), null);
});

/* ------------------------------------------------------------ reporting */

test("the report names the service and says why the constraints are not enough", () => {
    const message = describeFindings(
        find([{ path: "lib/x.ts", text: "tx.conversation.create({" }])
    );
    assert.match(message, /lib\/x\.ts:1/);
    assert.match(message, /createConversation/);
    assert.match(message, /TransactionClient/);
    // The failure has to say what the CHECKs do not cover, or the next reader
    // concludes the database already handles it.
    assert.match(message, /productKey IS NULL/);
});
