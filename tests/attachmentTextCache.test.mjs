import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    ATTACHMENT_TEXT_CACHE_CATEGORIES,
    ATTACHMENT_TEXT_CACHE_VERSION,
    attachmentTextCacheEnabled,
    parseCachedAttachmentEntries,
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

// Review r-20261118-074731-88c90f: every parser that holds a whole file is
// sized for the 50 MB limit, not the old 10 MB one.
test("legacy Office and PDF parsing are sized for the new file limit", async () => {
    const { DEFAULT_LEGACY_PARSE_LIMITS } = await import("../lib/legacyOffice/budget.ts");
    assert.equal(DEFAULT_LEGACY_PARSE_LIMITS.maxBytes, 2 * CHAT_MAX_ATTACHMENT_BYTES);
    assert.match(source("lib/mediaSecurity.ts"), /maxOldGenerationSizeMb: 512/);
    assert.match(source("lib/officeSecurity.ts"), /maxOldGenerationSizeMb: 512/);
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

test("what is stored is read back exactly, and anything else is a miss", () => {
    const entries = [{ kind: "PDF file", text: "line one\nline two" }, { kind: "file", text: "한국어" }];
    assert.deepEqual(parseCachedAttachmentEntries(JSON.parse(JSON.stringify(entries))), entries);
    assert.equal(parseCachedAttachmentEntries("not a list"), null);
    assert.equal(parseCachedAttachmentEntries([]), null);
    assert.equal(parseCachedAttachmentEntries([{ kind: 1, text: "x" }]), null);
    assert.equal(parseCachedAttachmentEntries(null), null);
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
    // Read and written by the attachment row's id.
    assert.ok(route.includes("await readAttachmentTextCache(resolved!.attachmentId!)"));
    assert.match(route, /await writeAttachmentTextCache\(\s*resolved!\.attachmentId!,/);
});

// Reviews r-20261118-061358-048fc2 and r-20261118-064254-d277bc: a cache must
// never outlive its attachment. It is a row cascaded from the attachment, so
// a deletion removes it in the same transaction, and a write for a row already
// gone fails on the foreign key -- no lock, sweep or window involved.
test("the cache is a row cascaded from its attachment", () => {
    const schema = source("prisma/schema.prisma");
    const model = schema.slice(schema.indexOf("model MessageAttachmentTextCache {"));
    assert.ok(
        model.slice(0, 1200).includes(
            "attachment   MessageAttachment @relation(fields: [attachmentId], references: [id], onDelete: Cascade)"
        )
    );
    const migration = source("prisma/migrations/20261118090000_message_attachment_text_cache/migration.sql");
    assert.ok(
        migration.includes(
            'FOREIGN KEY ("attachmentId") REFERENCES "MessageAttachment"("id") ON DELETE CASCADE'
        )
    );
    const cache = source("lib/attachmentTextCache.ts");
    assert.ok(cache.includes('INSERT INTO "MessageAttachmentTextCache"'));
    // Nothing of the cache lives in object storage any more.
    assert.ok(!cache.includes('from "@/lib/r2"'));
    assert.ok(!source("lib/messageAttachmentStorage.ts").includes("AttachmentTextCache"));
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
    // Review r-20261118-074731-88c90f: left out unread, but never a lost file
    // hidden as over budget -- storage is asked first.
    assert.match(route, /pastAttachmentBytes \+ resolved\.size > MAX_TOTAL_ATTACHMENT_SIZE &&\s*\(await probeR2Object\(attachment\.objectKey\)\)\.state !== "missing"/);
});

// Same review: a cache hit must not hide a file storage lost.
test("a cache hit still asks storage whether the original exists", () => {
    const route = source("app/api/chat/route.ts");
    const hit = route.slice(route.indexOf("const cached = await readAttachmentTextCache(resolved!.attachmentId!);"));
    assert.match(hit.slice(0, 900), /\(await probeR2Object\(attachment\.objectKey\)\)\.state === "missing"/);
    assert.match(hit.slice(0, 900), /if \(cached && !originalGone\) \{/);
});

test("the chat page, receipt recovery and stored previews follow the account limits", () => {
    const page = source("app/(site)/(application)/chat/ChatPageClient.tsx");
    assert.match(page, /maxAttachmentsPerMessage: CHAT_MAX_ATTACHMENTS_PER_MESSAGE,\s*maxAttachmentBytes: CHAT_MAX_ATTACHMENT_BYTES,\s*attachmentPersistence: "account"/);
    assert.match(source("lib/chatDraftMessageConsume.ts"), /attachmentUploadIds: z\.array\(opaqueId\)\.max\(CHAT_MAX_ATTACHMENTS_PER_MESSAGE\)/);
    assert.match(source("lib/messageAttachmentPreview.ts"), /MAX_PREVIEW_ATTACHMENT_BYTES = CHAT_MAX_ATTACHMENT_BYTES;/);
    // The mobile app reads the same constants.
    assert.match(source("apps/mobile/src/Composer.tsx"), /> CHAT_MAX_ATTACHMENTS_PER_MESSAGE\) \{ setError\(copy\.fileLimit\)/);
});

// Review r-20261118-081025-978715: a long conversation's earlier files never
// stop it from being continued.
test("past the conversation's file count the oldest earlier files are left out, not refused", () => {
    const route = source("app/api/chat/route.ts");
    assert.ok(!route.includes('"TOO_MANY_CONVERSATION_ATTACHMENTS"'));
    assert.ok(!route.includes('"TOO_MANY_ATTACHMENT_OBJECTS"'));
    assert.match(route, /let olderAttachmentsToOmit = Math\.max\(\s*0,[\s\S]{0,300}- MAX_CONVERSATION_ATTACHMENTS\s*\);/);
    assert.match(
        route,
        /if \(!isLatestMessage && olderAttachmentsToOmit > 0\) \{\s*olderAttachmentsToOmit -= 1;\s*textAttachments\.push\(\{\s*name: attachment\.name,\s*kind: PAST_ATTACHMENT_OMITTED_KIND,/
    );
    // A guest chat keeps its own small refusal.
    assert.ok(route.includes('"GUEST_TOO_MANY_CONVERSATION_ATTACHMENTS"'));
});

// Same review: every surface that counts or sizes a message's files agrees.
test("feedback, the composer and the mobile app follow the message limits", () => {
    assert.match(
        source("app/api/feedback/route.ts"),
        /attachmentCount: z\.number\(\)\.int\(\)\.min\(0\)\.max\(CHAT_MAX_ATTACHMENTS_PER_MESSAGE\)/
    );
    const composer = source("components/chat/ChatInput.tsx");
    assert.match(composer, /attachmentBytesTotal\(current\) \+ attachment\.size >\s*CHAT_MAX_TOTAL_ATTACHMENT_BYTES/);
    assert.match(composer, /CHAT_MAX_TOTAL_ATTACHMENT_BYTES - attachmentBytesTotal\(attachments\)/);
    for (const locale of ["en", "ko", "de", "es", "fr", "pt", "zh", "zhHant"]) {
        assert.match(source(`locales/${locale}.ts`), /attachmentTotalSizeError: "/, locale);
    }
    const mobile = source("apps/mobile/src/Composer.tsx");
    assert.match(mobile, /file\.size > CHAT_MAX_ATTACHMENT_BYTES/);
    assert.match(mobile, /> CHAT_MAX_TOTAL_ATTACHMENT_BYTES\) \{\s*setError\(mobileUploadCopy\[language\]\.sizeLimit\)/);
    // The native bridge gets one base64 string the WebView encoded, not a
    // byte array and a binary string built beside it.
    const upload = source("apps/mobile/src/nativeUpload.ts");
    assert.match(upload, /reader\.readAsDataURL\(file\)/);
    assert.ok(!upload.includes("btoa("));
    assert.ok(!upload.includes("arrayBuffer()"));
    assert.match(upload, /file\.size > CHAT_MAX_ATTACHMENT_BYTES/);
});
