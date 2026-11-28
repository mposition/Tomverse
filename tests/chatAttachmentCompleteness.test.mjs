import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    describeImagePayloadLimit,
    messageReadingOrder,
    oldestAttachmentSlots,
} from "../lib/chatImageBudget.ts";
import { PAST_ATTACHMENT_OMITTED_KIND, PAST_IMAGE_OMITTED_TEXT } from "../lib/chatAttachmentLimits.ts";
import { ATTACHMENT_TEXT_CACHE_VERSION, AUDIO_TRANSCRIPT_VERSION_BAND } from "../lib/attachmentTextCache.ts";
import { pdfPagesNotRead } from "../lib/mediaSecurity.ts";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Review r-20261128-051641-d94ab6: the budget is spent in reading order, so the
// order decides who is left out. This is the route's loop in miniature: images
// are admitted while the model's limit lasts.
const admit = (messages, limit) => {
    const kept = [];
    let used = 0;
    for (const message of messageReadingOrder(messages.length)) {
        for (const image of messages[message]) {
            if (used < limit) {
                used += 1;
                kept.push(image);
            }
        }
    }
    return kept;
};

test("the message being sent is read first, then the earlier ones from the nearest back", () => {
    assert.deepEqual(messageReadingOrder(0), []);
    assert.deepEqual(messageReadingOrder(1), [0]);
    assert.deepEqual(messageReadingOrder(2), [1, 0]);
    assert.deepEqual(messageReadingOrder(5), [4, 3, 2, 1, 0]);
});

test("a model that takes one image keeps the newest, whatever the older ones came in", () => {
    // An old archive's image, a more recent direct image, nothing in the message being sent.
    assert.deepEqual(admit([["zip-image"], [], ["recent-direct"], []], 1), ["recent-direct"]);
    // The message being sent beats everything earlier, archive or not.
    assert.deepEqual(admit([["old"], ["newer"], ["sent"]], 2), ["sent", "newer"]);
    // Nothing is left out while the images fit.
    assert.deepEqual(admit([["a"], ["b"], ["c"]], 3).sort(), ["a", "b", "c"]);
});

test("the files a conversation's count leaves out are the oldest, decided in conversation order", () => {
    // Messages hold 2, 0, 3 and 2 files; the last message is the one being sent.
    assert.deepEqual([...oldestAttachmentSlots([2, 0, 3, 2], 3)], ["0:0", "0:1", "2:0"]);
    assert.deepEqual([...oldestAttachmentSlots([2, 0, 3, 2], 0)], []);
    // Never the message being sent, whatever the count.
    assert.deepEqual([...oldestAttachmentSlots([1, 2], 99)], ["0:0"]);
    assert.deepEqual([...oldestAttachmentSlots([], 5)], []);
});

test("the limit is named from the model's own setting", () => {
    assert.equal(describeImagePayloadLimit(4 * 1024 * 1024), "4 MB");
    assert.equal(describeImagePayloadLimit(20 * 1024 * 1024), "20 MB");
    assert.equal(describeImagePayloadLimit(1.5 * 1024 * 1024), "1.5 MB");
});

test("a left-out image is named to the model, so it neither describes nor guesses at it", () => {
    assert.equal(PAST_ATTACHMENT_OMITTED_KIND, "earlier attachment, not included");
    assert.match(PAST_IMAGE_OMITTED_TEXT, /Do not describe/);
});

test("pages the OCR was asked for and did not answer are the ones not read", () => {
    // A wholly scanned file of 3 pages answered with page 1 only.
    assert.deepEqual(pdfPagesNotRead([1, 2, 3], [1]), [2, 3]);
    assert.deepEqual(pdfPagesNotRead([1, 2, 3], [3, 1, 2]), []);
    // The text-less pages of a partly scanned file, one of them skipped.
    assert.deepEqual(pdfPagesNotRead([2, 4], [2]), [4]);
    // Pages nobody asked about are not reported, and an unknown page count reports nothing.
    assert.deepEqual(pdfPagesNotRead([2], [2, 9]), []);
    assert.deepEqual(pdfPagesNotRead([], [1]), []);
});

test("the route never refuses a turn for an earlier image, and names the limit from the model", () => {
    const route = source("app/api/chat/route.ts");
    assert.ok(!route.includes("accepts up to 4 MB"));
    assert.match(route, /describeImagePayloadLimit\(\s*imageCapabilities\.maxBase64ImagePayloadBytes/);
    // An earlier image over the allowance is left out instead of throwing; the
    // message being sent and the messages after it have already taken their share.
    const image = route.slice(route.indexOf('if (format.category === "image") {'));
    const beforeNormalize = image.slice(0, image.indexOf("let normalized: Buffer;"));
    assert.match(beforeNormalize, /if \(!isLatestMessage\) \{[\s\S]*totalImageCount \+ 1 > imageCapabilities\.maxImages/);
    // No plan from sizes guessed beforehand: the reading order does it.
    assert.ok(!route.includes("planImageOmissions") && !route.includes("imagePlan"));
});

test("the text cache version moved with the line-preserving PDF extraction, below the audio band", () => {
    assert.ok(ATTACHMENT_TEXT_CACHE_VERSION >= 2);
    assert.ok(ATTACHMENT_TEXT_CACHE_VERSION < AUDIO_TRANSCRIPT_VERSION_BAND);
});

// A PDF with text on some pages and none on others used to be read as if the
// text were the whole file.
test("a PDF with some text-less pages is not read as complete", () => {
    const route = source("app/api/chat/route.ts");
    const pdf = route.slice(route.indexOf('if (format.category === "pdf") {'));
    const branch = pdf.slice(0, pdf.indexOf('if (format.category === "iwork") {'));
    assert.match(branch, /extractPdfTextWithPagesSafely\(/);
    assert.match(branch, /\} else if \(textlessPdfPages\.length > 0\) \{/);
    // A model that reads PDFs gets the original beside the text, for the turn's own file...
    assert.match(branch, /isLatestMessage &&\s*!fromArchive &&\s*modelSupportsNativePdfInput\(modelConfig\)/);
    // ...otherwise the pages go through the same OCR path, and are named when they are not read.
    assert.match(branch, /runPdfOcr\(ocrRoom, textlessPdfPages\)/);
    assert.match(branch, /describeUnreadPdfPages\(unread\)/);
    // The notice is not stored as the file's text.
    assert.match(branch, /textCacheBlocked = true;/);
    // The original is part of the estimate: native file parts are priced with the flat allowance.
    assert.match(route, /estimateNativeAttachmentTokens\(\s*fileParts\.length - imageInputTokenEstimates\.length/);
});

test("OCR runs under the archive allowance and the usage ledger, and is shared by panels of one account", () => {
    const route = source("app/api/chat/route.ts");
    const pdf = route.slice(route.indexOf('if (format.category === "pdf") {'));
    const branch = pdf.slice(0, pdf.indexOf('if (format.category === "iwork") {'));
    assert.match(branch, /fromArchive \? archiveOcrBudget > archiveOcrUsed : true/);
    assert.match(branch, /recordInternalProviderUsage\(/);
    // Keyed by the account and the file's content: never across accounts.
    assert.match(branch, /access\.userId\s*\? `\$\{access\.userId\}:\$\{createHash\("sha256"\)/);
    assert.match(route, /const pdfOcrInFlight = new Map</);
});

test("the route reads the message being sent before any earlier one, and sends them in conversation order", () => {
    const route = source("app/api/chat/route.ts");
    assert.match(route, /for \(const messageIndex of messageReadingOrder\(executionMessages\.length\)\) \{/);
    assert.match(route, /const builtMessages: ModelMessage\[\]\[\] = executionMessages\.map\(\(\) => \[\]\);/);
    assert.match(route, /for \(const built of builtMessages\) formattedMessages\.push\(\.\.\.built\);/);
    // Nothing in the loop writes straight to the conversation any more.
    const loop = route.slice(route.indexOf("for (const messageIndex of messageReadingOrder"), route.indexOf("for (const built of builtMessages)"));
    assert.ok(!loop.includes("formattedMessages.push"));
    // The count's omissions are decided by position, not by a counter the loop would spend newest first.
    assert.ok(!route.includes("olderAttachmentsToOmit -= 1"));
});

test("OCR sharing is keyed by the character budget, and a cut or short result is never stored as the file's text", () => {
    const route = source("app/api/chat/route.ts");
    assert.ok(route.includes('${pages?.join(",") ?? "all"}:${maxCharacters}`'));
    assert.ok(!route.includes("result.text.slice(0, maxCharacters)"));
    assert.match(route, /if \(ocrResult\.truncated\) textCacheBlocked = true;/);
    // Each page asked for is checked against the pages the provider answered.
    assert.match(route, /const unread = pdfPagesNotRead\(\s*textlessPdfPages,\s*scanned\?\.pageNumbers \?\? \[\]\s*\);/);
    assert.match(route, /describeUnreadPdfPages\(unread\)/);
    assert.match(route, /if \(unread\.length === 0 && !scanned\?\.truncated\) return "ok";/);
});

// Review r-20261128-051641-d94ab6: a wholly scanned file is judged by the same rule.
test("a wholly scanned PDF's OCR is checked page by page by the same function, and a gap is named and not stored", () => {
    const route = source("app/api/chat/route.ts");
    assert.match(route, /ocrUnreadPages = pdfPagesNotRead\(\s*Array\.from\(\{ length: pdfPageCount \}/);
    assert.match(route, /pdfPageCount = extraction\.pageCount;/);
    const tail = route.slice(route.indexOf("if (added && ocrUnreadPages.length > 0) {"));
    assert.match(tail.slice(0, 400), /textCacheBlocked = true;[\s\S]*describeUnreadPdfPages\(ocrUnreadPages\)/);
    // An earlier file's scanned text that did not fit its share still names the pages.
    assert.match(route, /kind: "PDF page notice",\s*text: describeUnreadPdfPages\(textlessPdfPages\)/);
});

test("the PDF text worker reports only what the reader uses", () => {
    const worker = source("lib/mediaSecurity.ts");
    assert.ok(!worker.includes("scannedPages"));
});
