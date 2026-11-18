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
    // Written, then the row is checked: deleted meanwhile means taken back out.
    const write = route.slice(route.indexOf("await writeAttachmentTextCache("));
    const recheck = write.indexOf("prisma.messageAttachment.findUnique");
    const takeBack = write.indexOf("await deleteAttachmentTextCache(cacheObjectKey)");
    assert.ok(recheck > 0 && takeBack > recheck);
});

// Review r-20261118-045547-8baacd: a cache written after the drain, or whose
// own re-check failed or never ran, must still be deleted -- durably.
test("every drain deletes the cached text of recently completed tombstones again", () => {
    const storage = source("lib/messageAttachmentStorage.ts");
    const sweep = storage.slice(storage.indexOf("const sweepLateAttachmentTextCaches"));
    assert.match(sweep, /const since = new Date\(now\.getTime\(\) - LATE_TEXT_CACHE_SWEEP_WINDOW_MS\)/);
    assert.match(sweep, /completedAt: \{ not: null, gte: since \}/);
    assert.match(sweep, /await deleteAttachmentTextCache\(item\.objectKey\)/);
    // Every completion in the window, page by page -- never only the newest N.
    assert.match(sweep, /cursor: \{ id: cursor \}, skip: 1/);
    assert.match(sweep, /if \(page\.length < take \|\| !last\) return deleted;/);
    assert.match(storage, /export const LATE_TEXT_CACHE_SWEEP_WINDOW_MS = 24 \* 60 \* 60 \* 1000;/);
    const drain = storage.slice(storage.indexOf("export const drainMessageAttachmentCleanupQueue"));
    assert.match(drain, /await sweepLateAttachmentTextCaches\(now, limit\)/);
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
