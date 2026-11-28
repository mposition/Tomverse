import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    base64SizeOf,
    describeImagePayloadLimit,
    messageReadingOrder,
    planImageOmissions,
} from "../lib/chatImageBudget.ts";
import { PAST_ATTACHMENT_OMITTED_KIND, PAST_IMAGE_OMITTED_TEXT } from "../lib/chatAttachmentLimits.ts";
import { ATTACHMENT_TEXT_CACHE_VERSION, AUDIO_TRANSCRIPT_VERSION_BAND } from "../lib/attachmentTextCache.ts";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const slot = (key, latest = false, base64Bytes = 0) => ({ key, latest, base64Bytes });

// An earlier image used the request's image allowance before the one being sent,
// and the one being sent was refused.
test("the oldest earlier images leave first, and the message being sent keeps its own", () => {
    const plan = planImageOmissions(
        [slot("0:0"), slot("0:1"), slot("2:0"), slot("4:0", true), slot("4:1", true)],
        { maxImages: 4 }
    );
    assert.deepEqual([...plan.omitted], ["0:0"]);

    const crowded = planImageOmissions(
        [slot("0:0"), slot("0:1"), slot("2:0"), slot("4:0", true), slot("4:1", true)],
        { maxImages: 2 }
    );
    assert.deepEqual([...crowded.omitted], ["0:0", "0:1", "2:0"]);
});

test("nothing is left out while the images fit; an overflow made by the new message alone is not hidden", () => {
    assert.equal(planImageOmissions([slot("0:0"), slot("1:0", true)], { maxImages: 2 }).omitted.size, 0);
    assert.equal(planImageOmissions([slot("0:0"), slot("1:0", true)], {}).omitted.size, 0);
    // The message's own images are never put on the omitted list; the route
    // refuses the turn for them with the model's own limit.
    const plan = planImageOmissions([slot("1:0", true), slot("1:1", true), slot("1:2", true)], { maxImages: 2 });
    assert.equal(plan.omitted.size, 0);
});

test("the byte allowance is spent newest first as well", () => {
    const MB = 1024 * 1024;
    const plan = planImageOmissions(
        [slot("0:0", false, 3 * MB), slot("1:0", false, 3 * MB), slot("2:0", true, 3 * MB)],
        { maxBase64ImagePayloadBytes: 7 * MB }
    );
    assert.deepEqual([...plan.omitted], ["0:0"]);
  });

test("a base64 size is estimated from the stored size, and the limit is named from the model's own setting", () => {
    assert.equal(base64SizeOf(3), 4);
    assert.equal(base64SizeOf(4), 8);
    assert.equal(base64SizeOf(0), 0);
    assert.equal(describeImagePayloadLimit(4 * 1024 * 1024), "4 MB");
    assert.equal(describeImagePayloadLimit(20 * 1024 * 1024), "20 MB");
    assert.equal(describeImagePayloadLimit(1.5 * 1024 * 1024), "1.5 MB");
});

test("a left-out image is named to the model, so it neither describes nor guesses at it", () => {
    assert.equal(PAST_ATTACHMENT_OMITTED_KIND, "earlier attachment, not included");
    assert.match(PAST_IMAGE_OMITTED_TEXT, /Do not describe/);
});

test("the route plans the image allowance before reading and never refuses a turn for an earlier image", () => {
    const route = source("app/api/chat/route.ts");
    assert.match(route, /const imagePlan = planImageOmissions\(/);
    assert.match(route, /leaveOut: imagePlan\.omitted\.has\(/);
    // The model's own limit is the message, not a fixed number.
    assert.ok(!route.includes("accepts up to 4 MB"));
    assert.match(route, /describeImagePayloadLimit\(\s*imageCapabilities\.maxBase64ImagePayloadBytes/);
    // An earlier image over the allowance is left out instead of throwing.
    const image = route.slice(route.indexOf('if (format.category === "image") {'));
    const beforeNormalize = image.slice(0, image.indexOf("let normalized: Buffer;"));
    assert.match(beforeNormalize, /if \(!isLatestMessage\) \{\s*if \(leaveOut\) return leaveOutEarlierImage\(\);/);
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

// Review r-20261128-050408-534dfc.
test("the message being sent is read first, then the earlier ones oldest first", () => {
    assert.deepEqual(messageReadingOrder(0), []);
    assert.deepEqual(messageReadingOrder(1), [0]);
    assert.deepEqual(messageReadingOrder(2), [1, 0]);
    assert.deepEqual(messageReadingOrder(5), [4, 0, 1, 2, 3]);
});

test("the route reads the message being sent before any earlier one, and sends them in conversation order", () => {
    const route = source("app/api/chat/route.ts");
    assert.match(route, /for \(const messageIndex of messageReadingOrder\(executionMessages\.length\)\) \{/);
    assert.match(route, /const builtMessages: ModelMessage\[\]\[\] = executionMessages\.map\(\(\) => \[\]\);/);
    assert.match(route, /for \(const built of builtMessages\) formattedMessages\.push\(\.\.\.built\);/);
    // Nothing in the loop writes straight to the conversation any more.
    const loop = route.slice(route.indexOf("for (const messageIndex of messageReadingOrder"), route.indexOf("for (const built of builtMessages)"));
    assert.ok(!loop.includes("formattedMessages.push"));
    // An earlier image is judged against totals the message being sent already holds: nothing is reserved for it.
    assert.ok(!route.includes("imagePlan.reserveCount") && !route.includes("imagePlan.reserveBase64Bytes"));
});

test("OCR sharing is keyed by the character budget, and a cut or short result is never stored as the file's text", () => {
    const route = source("app/api/chat/route.ts");
    assert.ok(route.includes('${pages?.join(",") ?? "all"}:${maxCharacters}`'));
    assert.ok(!route.includes("result.text.slice(0, maxCharacters)"));
    assert.match(route, /if \(ocrResult\.truncated\) textCacheBlocked = true;/);
    // Each page asked for is checked against the pages the provider answered.
    assert.match(route, /const answered = new Set\(scanned\?\.pageNumbers \?\? \[\]\);/);
    assert.match(route, /textlessPdfPages\.filter\(\(page\) => !answered\.has\(page\)\)/);
    assert.match(route, /describeUnreadPdfPages\(unread\)/);
    assert.match(route, /if \(unread\.length === 0 && !scanned\?\.truncated\) return "ok";/);
});

test("the PDF text worker reports only what the reader uses", () => {
    const worker = source("lib/mediaSecurity.ts");
    assert.ok(!worker.includes("scannedPages"));
});
