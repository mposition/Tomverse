import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    ATTACHMENT_TEXT_CACHE_CATEGORIES,
    ATTACHMENT_TEXT_CACHE_VERSION,
    attachmentTextCacheEnabled,
    attachmentTextCacheKey,
    attachmentTextCacheKeys,
    parseCachedAttachmentText,
    serializeCachedAttachmentText,
} from "../lib/attachmentTextCache.ts";
import {
    CHAT_MAX_ATTACHMENTS_PER_MESSAGE,
    CHAT_MAX_ATTACHMENT_BYTES,
    CHAT_MAX_TOTAL_ATTACHMENT_BYTES,
} from "../lib/chatAttachmentLimits.ts";
import { chatArchiveLimits } from "../lib/chatArchiveLimits.ts";

/**
 * Operator decision 2026-11-18: account attachments go to 10 files of 50 MB
 * (100 MB a request), and an earlier message's extracted text is kept so the
 * next turn does not read and parse the file again.
 */

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("account attachment limits: 10 files, 50 MB each, 100 MB a request", () => {
    assert.equal(CHAT_MAX_ATTACHMENTS_PER_MESSAGE, 10);
    assert.equal(CHAT_MAX_ATTACHMENT_BYTES, 50 * 1024 * 1024);
    assert.equal(CHAT_MAX_TOTAL_ATTACHMENT_BYTES, 100 * 1024 * 1024);
    assert.ok(CHAT_MAX_TOTAL_ATTACHMENT_BYTES >= 2 * CHAT_MAX_ATTACHMENT_BYTES);
});

test("an account archive holds an attachment-sized entry; a guest's limits do not move", () => {
    const account = chatArchiveLimits("account");
    assert.equal(account.maxArchiveBytes, CHAT_MAX_ATTACHMENT_BYTES);
    assert.equal(account.maxEntryUncompressedBytes, CHAT_MAX_ATTACHMENT_BYTES);
    assert.equal(account.maxTotalUncompressedBytes, 4 * CHAT_MAX_ATTACHMENT_BYTES);
    assert.equal(account.maxCompressionRatio, 100);
    const guest = chatArchiveLimits("guest");
    assert.equal(guest.maxArchiveBytes, 5 * 1024 * 1024);
    assert.equal(guest.maxTotalUncompressedBytes, 20 * 1024 * 1024);
});

test("every surface that checks the account limits reads the shared constants", () => {
    for (const path of [
        "app/api/chat/route.ts",
        "app/api/chat/availability/route.ts",
        "app/api/chat/preflight/route.ts",
        "components/chat/ChatInput.tsx",
    ]) {
        const text = source(path);
        assert.match(text, /CHAT_MAX_ATTACHMENT_BYTES/, path);
        assert.doesNotMatch(text, /10 \* 1024 \* 1024/, path);
    }
    for (const path of [
        "app/api/conversations/[conversationId]/messages/route.ts",
        "lib/chatComposerDraftCore.ts",
        "lib/messageAttachmentResend.ts",
    ]) {
        assert.match(source(path), /\.max\(CHAT_MAX_ATTACHMENTS_PER_MESSAGE\)/, path);
    }
});

test("the cache sits next to the original, inside its account prefix", () => {
    const key = "attachments/acct-1/abc.pdf";
    assert.equal(attachmentTextCacheKey(key), `${key}.extracted-v${ATTACHMENT_TEXT_CACHE_VERSION}.json`);
    assert.ok(attachmentTextCacheKey(key).startsWith(key));
});

test("deletion covers every cache version up to the current one", () => {
    const key = "attachments/acct-1/abc.pdf";
    const keys = attachmentTextCacheKeys(key);
    assert.equal(keys.length, ATTACHMENT_TEXT_CACHE_VERSION);
    assert.equal(keys.at(-1), attachmentTextCacheKey(key));
    assert.equal(keys[0], `${key}.extracted-v1.json`);
    const cache = source("lib/attachmentTextCache.ts");
    assert.match(cache, /for \(const key of attachmentTextCacheKeys\(objectKey\)\)/);
});

test("too many attachments names the real limit", () => {
    assert.match(source("app/api/chat/route.ts"), /at most \$\{MAX_ATTACHMENTS\} attachments/);
});

test("a conversation holds well over three full messages of files", () => {
    const limit = Number(/const MAX_CONVERSATION_ATTACHMENTS = (\d+);/.exec(source("app/api/chat/route.ts"))?.[1]);
    assert.ok(limit >= CHAT_MAX_ATTACHMENTS_PER_MESSAGE * 10, `${limit}`);
});

test("no pricing language claims Max has higher file limits", () => {
    const pricing = source("components/marketing/PricingPageContent.tsx");
    for (const claim of ["更高的文件", "更高的檔案", "更高的附件", "plus élevées", "Höhere Datei", "Höhere Anhang", "superiores de", "maiores de"]) {
        assert.ok(!pricing.includes(claim), claim);
    }
});

test("what is written is read back exactly, and anything else is a miss", () => {
    const entries = [{ kind: "PDF file", text: "line one\nline two" }, { kind: "file", text: "한국어" }];
    assert.deepEqual(parseCachedAttachmentText(serializeCachedAttachmentText(entries)), entries);
    assert.equal(parseCachedAttachmentText("not json"), null);
    assert.equal(parseCachedAttachmentText(JSON.stringify({ version: 999, entries })), null);
    assert.equal(parseCachedAttachmentText(JSON.stringify({ version: ATTACHMENT_TEXT_CACHE_VERSION, entries: [] })), null);
    assert.equal(
        parseCachedAttachmentText(JSON.stringify({ version: ATTACHMENT_TEXT_CACHE_VERSION, entries: [{ kind: 1, text: "x" }] })),
        null
    );
});

test("only model-independent extractors are cached", () => {
    assert.deepEqual([...ATTACHMENT_TEXT_CACHE_CATEGORIES].sort(), ["legacy-office", "office", "pdf", "text"]);
    for (const category of ["image", "archive", "iwork"]) {
        assert.equal(ATTACHMENT_TEXT_CACHE_CATEGORIES.has(category), false, category);
    }
});

test("on by default, off with CHAT_ATTACHMENT_TEXT_CACHE=0", () => {
    assert.equal(attachmentTextCacheEnabled({}), true);
    assert.equal(attachmentTextCacheEnabled({ CHAT_ATTACHMENT_TEXT_CACHE: "0" }), false);
});

test("the route caches only an account's earlier, bound file, and never the turn's own", () => {
    const route = source("app/api/chat/route.ts");
    const start = route.indexOf("const textCacheEligible =");
    assert.ok(start > 0);
    const eligibility = route.slice(start, route.indexOf(";", start));
    for (const condition of [
        "!isLatestMessage",
        "!isGuestObject",
        "Boolean(resolved?.attachmentId)",
        "ATTACHMENT_TEXT_CACHE_CATEGORIES.has(format.category)",
        "attachmentTextCacheEnabled()",
    ]) {
        assert.ok(eligibility.includes(condition), condition);
    }
    // A cache hit answers to the same past-file share and parse budget.
    const hit = route.slice(start, route.indexOf("let attachmentBuffer: Buffer;", start));
    assert.match(hit, /pastAttachmentTokens \+ tokens > pastAttachmentTokenBudget/);
    assert.match(hit, /CHAT_ATTACHMENT_PARSE_CHARACTERS/);
    // A cut or mixed extraction is never stored.
    assert.match(route, /fileParts\.length === filePartsBefore/);
    assert.match(route, /producedCharacters \+ 64 < parseRoomBefore/);
    // The route writes only through the row-holding writer, never directly.
    assert.match(route, /await writeBoundAttachmentTextCache\(\{\s*attachmentId: resolved!\.attachmentId!,/);
    assert.doesNotMatch(route, /writeAttachmentTextCache\(/);
});

// Review r-20261118-061358-048fc2: a cache must never outlive its attachment,
// durably -- not within a window. The write holds the row, so a deletion is
// ordered before it (nothing written) or after it (drained with the file).
test("the cache is written only while its attachment row is held", () => {
    const cache = source("lib/attachmentTextCache.ts");
    const writer = cache.slice(cache.indexOf("export const writeBoundAttachmentTextCache"));
    assert.match(writer, /prisma\.\$transaction\(/);
    assert.match(writer, /FROM "MessageAttachment"\s*WHERE "id" = \$\{input\.attachmentId\} AND "objectKey" = \$\{input\.objectKey\}\s*FOR KEY SHARE/);
    const lock = writer.indexOf("FOR KEY SHARE");
    const gone = writer.indexOf("if (rows.length === 0) return false;");
    const write = writer.indexOf("await writeAttachmentTextCache(input.objectKey, input.entries, {");
    assert.ok(lock > 0 && gone > lock && write > gone, "lock, then check, then write -- inside one transaction");
    // No time window to fall out of any more.
    assert.doesNotMatch(source("lib/messageAttachmentStorage.ts"), /sweepLateAttachmentTextCaches|LATE_TEXT_CACHE/);
});

// Review r-20261118-064254-d277bc, blocker: a PUT still running when the lock
// times out could land after the deletion it was ordered against.
test("the PUT ends well inside the lock, and an unknown outcome is taken back out", async () => {
    const { ATTACHMENT_TEXT_CACHE_PUT_TIMEOUT_MS, ATTACHMENT_TEXT_CACHE_LOCK_TIMEOUT_MS } = await import("../lib/attachmentTextCache.ts");
    assert.ok(ATTACHMENT_TEXT_CACHE_PUT_TIMEOUT_MS * 3 <= ATTACHMENT_TEXT_CACHE_LOCK_TIMEOUT_MS);
    const cache = source("lib/attachmentTextCache.ts");
    const writer = cache.slice(cache.indexOf("export const writeBoundAttachmentTextCache"));
    assert.match(writer, /abortSignal: AbortSignal\.timeout\(ATTACHMENT_TEXT_CACHE_PUT_TIMEOUT_MS\)/);
    assert.match(writer, /\{ timeout: ATTACHMENT_TEXT_CACHE_LOCK_TIMEOUT_MS \}/);
    // A failed PUT is deleted while the lock is still held...
    const put = writer.indexOf("await writeAttachmentTextCache(");
    const inLockDelete = writer.indexOf("await deleteAttachmentTextCache(input.objectKey)", put);
    const alive = writer.indexOf("await tx.$queryRaw`SELECT 1`");
    assert.ok(put > 0 && inLockDelete > put && alive > inLockDelete);
    // ...and a transaction that did not survive the PUT deletes it after.
    assert.match(writer.slice(alive), /\)\.catch\(async \(error\) => \{\s*await deleteAttachmentTextCache\(input\.objectKey\)/);
    assert.match(source("lib/r2.ts"), /options\?\.abortSignal \? \{ abortSignal: options\.abortSignal \} : \{\}/);
});

// Same review: earlier files must never stop a new message from being sent.
test("earlier files have their own byte share and are left out past it", () => {
    const route = source("app/api/chat/route.ts");
    assert.match(route, /let pastAttachmentBytes = 0;/);
    // The turn's own files still answer 413 past the request total...
    assert.match(route, /if \(isLatestMessage\) \{\s*totalAttachmentBytes \+= attachmentBytes;\s*if \(totalAttachmentBytes > MAX_TOTAL_ATTACHMENT_SIZE\) \{\s*throw new ChatAccessError\(\s*413,/);
    // ...earlier ones are named to the model and left out, read or not.
    assert.match(route, /pastAttachmentBytes \+= attachmentBytes;\s*if \(pastAttachmentBytes > MAX_TOTAL_ATTACHMENT_SIZE\) \{\s*textAttachments\.push\(\{[\s\S]{0,160}PAST_ATTACHMENT_OMITTED_KIND/);
    assert.match(route, /!isLatestMessage &&\s*typeof resolved\?\.size === "number" &&\s*pastAttachmentBytes \+ resolved\.size > MAX_TOTAL_ATTACHMENT_SIZE/);
});

test("reading the cache never deletes it", () => {
    const cache = source("lib/attachmentTextCache.ts");
    assert.match(cache, /readOwnR2ObjectBytes\(attachmentTextCacheKey\(objectKey\)/);
    assert.doesNotMatch(cache, /readR2Object\(/);
});

// Same review: a cache hit must not hide a file storage lost.
test("a cache hit still asks storage whether the original exists", () => {
    const route = source("app/api/chat/route.ts");
    const hit = route.slice(route.indexOf("const cached = await readAttachmentTextCache(attachment.objectKey);"));
    assert.match(hit.slice(0, 900), /\(await probeR2Object\(attachment\.objectKey\)\)\.state === "missing"/);
    assert.match(hit.slice(0, 900), /if \(cached && !originalGone\) \{/);
});

test("the chat page, receipt recovery and stored previews follow the account limits", () => {
    const page = source("app/(site)/(application)/chat/ChatPageClient.tsx");
    assert.match(page, /maxAttachmentsPerMessage: CHAT_MAX_ATTACHMENTS_PER_MESSAGE,\s*maxAttachmentBytes: CHAT_MAX_ATTACHMENT_BYTES,\s*attachmentPersistence: "account"/);
    assert.match(source("lib/chatDraftMessageConsume.ts"), /attachmentUploadIds: z\.array\(opaqueId\)\.max\(CHAT_MAX_ATTACHMENTS_PER_MESSAGE\)/);
    assert.match(source("lib/messageAttachmentPreview.ts"), /MAX_PREVIEW_ATTACHMENT_BYTES = CHAT_MAX_ATTACHMENT_BYTES;/);
    // The mobile app cannot import the constant; its own checks are kept equal.
    assert.match(source("apps/mobile/src/Composer.tsx"), new RegExp(`> ${CHAT_MAX_ATTACHMENTS_PER_MESSAGE}\\) \\{ setError\\(copy\\.fileLimit\\)`));
});

test("deleting an attachment deletes its cached text with it", () => {
    const storage = source("lib/messageAttachmentStorage.ts");
    const drain = storage.slice(storage.indexOf("export const drainMessageAttachmentCleanupQueue"));
    const original = drain.indexOf("await deleteR2Object(item.objectKey)");
    const cached = drain.indexOf("await deleteAttachmentTextCache(item.objectKey)");
    const completed = drain.indexOf("completedAt: now");
    assert.ok(original > 0 && cached > original && completed > cached, "both deleted before the row completes");
});
