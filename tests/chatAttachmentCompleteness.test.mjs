import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    claimInConversationOrder,
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
    assert.match(branch, /\} else if \(textlessPdfPages\.length > 0 \|\| budgetUnreadPages\.length > 0/);
    // A model that reads PDFs gets the original beside the text, for the turn's own file...
    assert.match(branch, /isLatestMessage &&\s*!fromArchive &&\s*modelSupportsNativePdfInput\(modelConfig\)/);
    // ...otherwise the pages go through the same OCR path, and are named when they are not read.
    assert.match(branch, /runPdfOcr\(ocrRoom, textlessPdfPages\)/);
    // What is not read is named, and not stored as the file's text, by the one settle function.
    assert.ok(branch.includes("describeUnreadPdfPages(outcome)"));
    assert.match(branch, /if \(!outcome\.cacheable\) textCacheBlocked = true;/);
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
    // A wholly scanned file is judged against every page of the file.
    assert.match(route, /expectedPages: Array\.from\(\{ length: pdfPageCount \}/);
    assert.ok(route.includes("pdfPageCount = extraction.pageCount;"));
    // An earlier file's scanned text that did not fit its share still names the pages.
    assert.match(route, /settlePdfReading\(\{\s*unreadPages: textlessPdfPages,\s*partialPages: budgetPartialPage === null \? \[\] : \[budgetPartialPage\],\s*budgetUnreadPages,\s*pageCountUnknown: false,\s*ocrUnmatched: false,\s*cacheable: false,/);
    // The notice's room is set aside before the text is read: extraction, OCR and the gate use one budget function.
    assert.ok(route.includes("pdfTextCharacterBudget(remainingCharacters)"));
    assert.ok(route.includes("? pdfTextCharacterBudget(remainingCharacters) <= 0"));
    assert.match(route, /const ocrRoom = pdfTextCharacterBudget\(\s*CHAT_ATTACHMENT_PARSE_CHARACTERS - totalExtractedCharacters\s*\);/);
    // Pages the text pass never reached are named; they are not OCR'd or sent as the original.
    assert.match(route, /textlessPdfPages\.length > 0 \|\| budgetUnreadPages\.length > 0 \|\| budgetPartialPage !== null/);
    assert.match(route, /hasScans &&\s*isLatestMessage &&\s*!fromArchive &&\s*modelSupportsNativePdfInput/);
    assert.match(route, /hasScans &&\s*ocrRoom > 0 &&/);
});

test("the PDF text worker reports only what the reader uses", () => {
    const worker = source("lib/mediaSecurity.ts");
    assert.ok(!worker.includes("scannedPages"));
});

// Review r-20261128-052701-5bbed8: the messages are read newest first, but a stored
// answer's reasoning and tool context belongs to the n-th answer with that text.
test("two answers with the same text keep their own stored context, whatever order the messages are read in", () => {
    const queues = new Map([["Sure.", ["first-context", "second-context"]], ["Other.", ["other-context"]]]);
    // user, assistant "Sure.", user, assistant "Sure.", user, assistant "Other."
    const keys = [null, "Sure.", null, "Sure.", null, "Other."];
    const claimed = claimInConversationOrder(keys, queues);
    assert.equal(claimed.get(1), "first-context");
    assert.equal(claimed.get(3), "second-context");
    assert.equal(claimed.get(5), "other-context");
    assert.equal(claimed.size, 3);
    // An answer with no stored context gets none, and does not take another's.
    const lonely = claimInConversationOrder(["Sure.", "Sure."], new Map([["Sure.", ["only"]]]));
    assert.equal(lonely.get(0), "only");
    assert.equal(lonely.has(1), false);
});

test("the route claims stored context before the loop, and an answer reads its own", () => {
    const route = source("app/api/chat/route.ts");
    assert.ok(route.includes("const preservedContexts = claimInConversationOrder("));
    assert.ok(route.includes("const preserved = preservedContexts.get(messageIndex);"));
    assert.ok(!route.includes("providerContextQueues.get(content)?.shift()"));
    assert.ok(route.indexOf("const preservedContexts") < route.indexOf("for (const messageIndex of messageReadingOrder"));
});

test("every way a scanned PDF is read settles through one decision: the notice and the cache block", () => {
    const route = source("app/api/chat/route.ts");
    const pdf = route.slice(route.indexOf('if (format.category === "pdf") {'), route.indexOf('if (format.category === "iwork") {'));
    // The one place that turns an outcome into a notice and a cache block.
    assert.match(pdf, /const settlePdfReading = \(outcome: PdfReadingOutcome\) => \{\s*if \(!outcome\.cacheable\) textCacheBlocked = true;/);
    // The original sent beside the text layer is never stored as the file's text.
    assert.match(pdf, /originalSentToModel: true,\s*\}\)\s*\);\s*return "ok";/);
    // The wholly scanned file and the partly scanned one use the same function.
    assert.ok(pdf.includes("ocrOutcome = pdfReadingOutcome({"));
    assert.match(pdf, /const outcome = pdfReadingOutcome\(\{\s*expectedPages: textlessPdfPages,/);
    assert.ok(pdf.includes("added\n                                    ? ocrOutcome"));
    // No other place decides a cache block for a PDF.
    assert.equal((pdf.match(/textCacheBlocked = true/g) ?? []).length, 1);
    // And the cache write is still refused when a file part was sent.
    assert.ok(route.includes("fileParts.length === filePartsBefore"));
});

// Review r-20261128-054317-1a725b: the page notice, the text and the cache decision agree under every budget.
test("the page notice is not turned down by an earlier file's share, and is counted against it", () => {
    const route = source("app/api/chat/route.ts");
    const pdf = route.slice(route.indexOf('if (format.category === "pdf") {'), route.indexOf('if (format.category === "iwork") {'));
    const settle = pdf.slice(pdf.indexOf("const settlePdfReading"), pdf.indexOf("// Pages the text pass never reached"));
    // Pushed directly: not through addExtractedText, which would swap it for the general "not included" line.
    assert.ok(!settle.includes("addExtractedText("));
    assert.match(settle, /totalExtractedCharacters \+= notice\.length;/);
    assert.match(settle, /if \(!isLatestMessage\) pastAttachmentTokens \+= estimatePromptTokens\(notice\);/);
    assert.match(settle, /textAttachments\.push\(\{ name, kind: "PDF page notice", text: notice \}\);/);
});

test("a cached file is included whole or named once, never half and never twice", () => {
    const route = source("app/api/chat/route.ts");
    const hit = route.slice(route.indexOf("if (textCacheEligible && !isLatestMessage) {"), route.indexOf("// An earlier file the share cannot take"));
    assert.match(hit, /const cachedTokens = cached\.reduce\(/);
    assert.equal(hit.split("PAST_ATTACHMENT_OMITTED_KIND").length - 1, 1);
});

test("the page count comes from the validation when the text pass failed; unknown is named and not stored", () => {
    const route = source("app/api/chat/route.ts");
    assert.equal(route.split("pdfPageCount = (await validatePdfSafely(buffer)).pageCount;").length - 1, 2);
    assert.ok(route.includes("pageCountUnknown: pdfPageCount === 0,"));
});

// Review r-20261128-055301-8b701c.
test("an earlier file's OCR text left out for its share still names the pages and blocks the cache", () => {
    const route = source("app/api/chat/route.ts");
    assert.ok(!route.includes("if (added && ocrOutcome) settlePdfReading(ocrOutcome);"));
    assert.match(route, /if \(ocrOutcome\) \{[\s\S]{0,400}settlePdfReading\(\s*added\s*\? ocrOutcome\s*: \{[\s\S]{0,300}pageCountUnknown: pdfPageCount === 0,\s*ocrUnmatched: false,\s*cacheable: false,/);
    // Every settle input carries the whole outcome shape.
    for (const literal of route.match(/settlePdfReading\(\{[\s\S]*?cacheable: false,/g) ?? []) {
        assert.ok(literal.includes("pageCountUnknown:"), literal);
    }
});

test("only the request that starts the paid OCR call counts as having started paid work", () => {
    const route = source("app/api/chat/route.ts");
    const start = route.indexOf("const runPdfOcr = async (");
    const body = route.slice(start, route.indexOf("return call;", start));
    const shared = body.indexOf("if (shared) return shared;");
    const flag = body.indexOf("paidExternalWorkStarted = true;");
    assert.ok(shared > 0 && flag > shared, "the flag is set after the shared result is returned");
    assert.equal(body.split("paidExternalWorkStarted = true;").length - 1, 1);
});

test("an earlier image left out is counted against the earlier files' share like any line sent", () => {
    const route = source("app/api/chat/route.ts");
    const start = route.indexOf("const leaveOutEarlierImage = () => {");
    const body = route.slice(start, route.indexOf('return "ok" as const;', start));
    assert.ok(body.includes("totalExtractedCharacters += PAST_IMAGE_OMITTED_TEXT.length;"));
    assert.ok(body.includes("pastAttachmentTokens += estimatePromptTokens(PAST_IMAGE_OMITTED_TEXT);"));
});

test("an unmatched OCR result is named through the one settle path, which also keeps it out of the cache", () => {
    const route = source("app/api/chat/route.ts");
    assert.ok(route.includes("outcome.ocrUnmatched"));
    for (const literal of route.match(/settlePdfReading\(\{[\s\S]*?cacheable: false,/g) ?? []) {
        assert.ok(literal.includes("ocrUnmatched:"), literal);
    }
});
