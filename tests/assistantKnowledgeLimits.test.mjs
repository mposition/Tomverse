// Release C2: the file-type and quota contract, as §14.1 approved it.
//
// Two kinds of assertion here. The first pins the seven figures themselves,
// because they are a policy decision and a silent edit to one is the failure
// mode this file exists to catch. The second pins the refusals, because a
// limit nobody enforces is a paragraph.

import assert from "node:assert/strict";
import test from "node:test";

import {
    ASSISTANT_KNOWLEDGE_LIMITS,
    ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED,
    ASSISTANT_KNOWLEDGE_TYPES,
    ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE,
    KNOWLEDGE_SIGNATURE_SCAN_BYTES,
    knowledgeExtractedTextRefusal,
    knowledgeFileRefusal,
    knowledgeQuotaRefusal,
    knowledgeRemainingCapacity,
    knowledgeSignatureMatches,
} from "../lib/assistantKnowledgeLimits.ts";

const bytesOf = (...values) => Uint8Array.from(values);
const PDF_HEADER = bytesOf(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37);
const ZIP_HEADER = bytesOf(0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0);

const emptyUsage = {
    filesInProfile: 0,
    filesInAccount: 0,
    objectBytesInAccount: 0,
    extractedBytesInAccount: 0,
};

/* -------------------------------------------------- the approved figures */

test("the seven §14.1 figures are what was approved", () => {
    // Changing any of these is a policy change. The test is here so it cannot
    // happen as a side effect of tuning something else.
    assert.deepEqual(
        { ...ASSISTANT_KNOWLEDGE_LIMITS },
        {
            maxFileBytes: 32 * 1024 * 1024,
            maxExtractedCodePoints: 1_000_000,
            maxFilesPerProfile: 20,
            maxProfilesPerAccount: 20,
            maxFilesPerAccount: 100,
            maxObjectBytesPerAccount: 500 * 1024 * 1024,
            maxExtractedBytesPerAccount: 50 * 1024 * 1024,
        }
    );
});

test("the byte ceiling binds before the count ceiling, which is the intended order", () => {
    // §14.1 puts these deliberately out of line: 100 files at 32MiB is 3.2GiB,
    // far above the 500MiB account ceiling. If somebody "fixes" the
    // inconsistency by raising the byte figure, the count stops being the
    // quality limit it is meant to be.
    const { maxFilesPerAccount, maxFileBytes, maxObjectBytesPerAccount } =
        ASSISTANT_KNOWLEDGE_LIMITS;
    assert.ok(maxFilesPerAccount * maxFileBytes > maxObjectBytesPerAccount);
});

/* ------------------------------------------------------------ file types */

test("an image is not a knowledge file", () => {
    // The chat attachment allowlist accepts images because a model reads them
    // directly. A knowledge file has to become text to be chunked, so an image
    // here would upload, extract nothing, and sit in the list forever as a
    // file that is present and never retrieved.
    for (const mime of ["image/png", "image/jpeg", "image/webp"]) {
        assert.equal(mime in ASSISTANT_KNOWLEDGE_TYPES, false, `${mime} is listed`);
        const refusal = knowledgeFileRefusal({
            filename: "diagram.png",
            mime,
            bytes: 1_000,
        });
        assert.equal(refusal?.code, ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE);
    }
});

test("the extension and the media type have to agree, in both directions", () => {
    assert.equal(
        knowledgeFileRefusal({
            filename: "notes.pdf",
            mime: "application/pdf",
            bytes: 1_000,
            leadingBytes: PDF_HEADER,
        }),
        null
    );
    // A genuine PDF named .zip.
    assert.match(
        knowledgeFileRefusal({
            filename: "notes.zip",
            mime: "application/pdf",
            bytes: 1_000,
        }).detail,
        /\.zip file cannot carry application\/pdf/
    );
    // No extension at all.
    assert.match(
        knowledgeFileRefusal({
            filename: "notes",
            mime: "application/pdf",
            bytes: 1_000,
        }).detail,
        /no extension/
    );
});

test("bytes that do not begin like the declared type are refused", () => {
    // The declared media type is a claim by the uploader and the extension a
    // claim by the filename. Neither is evidence.
    const executableBytes = bytesOf(0x4d, 0x5a, 0x90, 0x00, 0, 0, 0, 0);
    assert.match(
        knowledgeFileRefusal({
            filename: "payload.pdf",
            mime: "application/pdf",
            bytes: 2_000,
            leadingBytes: executableBytes,
        }).detail,
        /does not begin like application\/pdf/
    );
    assert.equal(
        knowledgeFileRefusal({
            filename: "report.docx",
            mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            bytes: 2_000,
            leadingBytes: ZIP_HEADER,
        }),
        null
    );
});

test("a text type has no signature to check, and that is not a hole", () => {
    // Any byte sequence is a valid text file; the real check is that it
    // decodes as UTF-8, which happens during extraction. Asserting `true` here
    // records that the absence is deliberate.
    assert.equal(knowledgeSignatureMatches("text/plain", bytesOf(0xff, 0xfe)), true);
    assert.equal(knowledgeSignatureMatches("application/pdf", bytesOf(0xff, 0xfe)), false);
    assert.equal(KNOWLEDGE_SIGNATURE_SCAN_BYTES, 8);
});

test("an empty or oversized file is refused before anything is stored", () => {
    for (const bytes of [0, -1, 1.5]) {
        assert.match(
            knowledgeFileRefusal({ filename: "a.txt", mime: "text/plain", bytes })
                .detail,
            /empty/
        );
    }
    assert.match(
        knowledgeFileRefusal({
            filename: "a.txt",
            mime: "text/plain",
            bytes: ASSISTANT_KNOWLEDGE_LIMITS.maxFileBytes + 1,
        }).detail,
        /larger than/
    );
});

/* ----------------------------------------------------------------- quota */

test("a fresh account can upload", () => {
    assert.equal(
        knowledgeQuotaRefusal({ usage: emptyUsage, incomingBytes: 1_000 }),
        null
    );
});

test("each ceiling refuses with a reason the owner can act on", () => {
    const cases = [
        [{ filesInProfile: ASSISTANT_KNOWLEDGE_LIMITS.maxFilesPerProfile }, /this profile/],
        [{ filesInAccount: ASSISTANT_KNOWLEDGE_LIMITS.maxFilesPerAccount }, /this account already holds/],
        [
            { objectBytesInAccount: ASSISTANT_KNOWLEDGE_LIMITS.maxObjectBytesPerAccount },
            /stored bytes/,
        ],
        [
            {
                extractedBytesInAccount:
                    ASSISTANT_KNOWLEDGE_LIMITS.maxExtractedBytesPerAccount,
            },
            /extracted text/,
        ],
    ];
    for (const [overrides, pattern] of cases) {
        const refusal = knowledgeQuotaRefusal({
            usage: { ...emptyUsage, ...overrides },
            incomingBytes: 1_000,
        });
        assert.equal(refusal?.code, ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED);
        assert.match(refusal.detail, pattern);
    }
});

test("the count ceiling is reported before the byte ceiling", () => {
    // Deleting a file fixes a count. There is nothing an owner can do about a
    // byte total except delete files too, so the actionable one goes first.
    const refusal = knowledgeQuotaRefusal({
        usage: {
            filesInProfile: ASSISTANT_KNOWLEDGE_LIMITS.maxFilesPerProfile,
            filesInAccount: ASSISTANT_KNOWLEDGE_LIMITS.maxFilesPerAccount,
            objectBytesInAccount: ASSISTANT_KNOWLEDGE_LIMITS.maxObjectBytesPerAccount,
            extractedBytesInAccount:
                ASSISTANT_KNOWLEDGE_LIMITS.maxExtractedBytesPerAccount,
        },
        incomingBytes: 1,
    });
    assert.match(refusal.detail, /this profile/);
});

test("the account byte ceiling counts the incoming file, not just what is stored", () => {
    // Checking only what is already stored lets one 32MiB upload land on an
    // account that was one byte under.
    const usage = {
        ...emptyUsage,
        objectBytesInAccount:
            ASSISTANT_KNOWLEDGE_LIMITS.maxObjectBytesPerAccount - 100,
    };
    assert.equal(knowledgeQuotaRefusal({ usage, incomingBytes: 100 }), null);
    assert.equal(
        knowledgeQuotaRefusal({ usage, incomingBytes: 101 })?.code,
        ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED
    );
});

/* ------------------------------------------------ after extraction */

test("a document with more text than the ceiling is refused, not truncated", () => {
    // A knowledge file the owner believes is complete and is not is worse than
    // one that would not upload.
    const refusal = knowledgeExtractedTextRefusal({
        extractedBytesInAccount: 0,
        incomingExtractedBytes: 1_000,
        extractedCodePoints: ASSISTANT_KNOWLEDGE_LIMITS.maxExtractedCodePoints + 1,
    });
    assert.equal(refusal?.code, ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE);
    assert.match(refusal.detail, /characters of text/);
});

test("extracted text is charged against the account after it is read", () => {
    // The upload pre-check cannot know how much text a PDF holds, so the same
    // ceiling is applied again with the number nobody had before.
    assert.equal(
        knowledgeExtractedTextRefusal({
            extractedBytesInAccount:
                ASSISTANT_KNOWLEDGE_LIMITS.maxExtractedBytesPerAccount - 10,
            incomingExtractedBytes: 10,
            extractedCodePoints: 100,
        }),
        null
    );
    assert.equal(
        knowledgeExtractedTextRefusal({
            extractedBytesInAccount:
                ASSISTANT_KNOWLEDGE_LIMITS.maxExtractedBytesPerAccount - 10,
            incomingExtractedBytes: 11,
            extractedCodePoints: 100,
        })?.code,
        ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED
    );
});

/* -------------------------------------------------------------- capacity */

test("remaining capacity never reads as negative", () => {
    // The figure is shown to a user before they pick a file. An account over a
    // ceiling -- which a lowered limit produces -- must read as zero left, not
    // as a negative allowance.
    const capacity = knowledgeRemainingCapacity({
        filesInProfile: ASSISTANT_KNOWLEDGE_LIMITS.maxFilesPerProfile + 5,
        filesInAccount: 0,
        objectBytesInAccount:
            ASSISTANT_KNOWLEDGE_LIMITS.maxObjectBytesPerAccount + 1_000,
        extractedBytesInAccount: 0,
    });
    assert.equal(capacity.filesInProfile, 0);
    assert.equal(capacity.objectBytes, 0);
    assert.equal(capacity.filesInAccount, ASSISTANT_KNOWLEDGE_LIMITS.maxFilesPerAccount);
});
