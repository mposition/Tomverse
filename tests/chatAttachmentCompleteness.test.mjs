import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    base64SizeOf,
    describeImagePayloadLimit,
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
    assert.equal(plan.reserveCount, 2);

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
    assert.equal(plan.reserveCount, 3);
});

test("the byte allowance is spent newest first as well", () => {
    const MB = 1024 * 1024;
    const plan = planImageOmissions(
        [slot("0:0", false, 3 * MB), slot("1:0", false, 3 * MB), slot("2:0", true, 3 * MB)],
        { maxBase64ImagePayloadBytes: 7 * MB }
    );
    assert.deepEqual([...plan.omitted], ["0:0"]);
    assert.equal(plan.reserveBase64Bytes, 3 * MB);
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
    assert.match(image.slice(0, 4000), /imagePlan\.reserveBase64Bytes/);
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
    assert.match(branch, /describeUnreadPdfPages\(textlessPdfPages\)/);
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
