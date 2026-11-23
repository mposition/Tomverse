import assert from "node:assert/strict";
import test from "node:test";

import {
    REVIEW_FILE_HANDOFF_PARAM,
    REVIEW_PREFILL_MAX_CHARS,
    beginReviewFileHandoff,
    chatReviewHandoffFor,
    clearReviewFileHandoffs,
    isReattachableDocument,
    reviewPrefillHref,
    reviewSeedFromChat,
    takeReviewFileHandoff,
} from "../lib/chatReviewHandoff.ts";

const turns = [
    { id: "u1", role: "user", content: "Plan a 3-day trip to Tokyo" },
    { id: "a1", role: "assistant", content: "Day 1 ..." },
    { id: "u2", role: "user", content: "Make it cheaper" },
    { id: "a2", role: "assistant", content: "Budget plan ..." },
    { id: "u3", role: "user", content: "And for families?" },
    { id: "a3", role: "assistant", content: "Family plan ..." },
];

test("the first answer opens Review with its question alone", () => {
    assert.equal(reviewSeedFromChat(turns, "a1", "Earlier:"), "Plan a 3-day trip to Tokyo");
});

test("a follow-up carries up to two earlier questions, never earlier answers", () => {
    const seed = reviewSeedFromChat(turns, "a3", "Earlier:");
    assert.equal(seed, "Earlier:\n- Plan a 3-day trip to Tokyo\n- Make it cheaper\n\nAnd for families?");
    assert.doesNotMatch(seed, /Day 1|Budget plan|Family plan/);
});

test("the answer's own question is used, not a later one", () => {
    assert.equal(reviewSeedFromChat(turns, "a2", "Earlier:"), "Earlier:\n- Plan a 3-day trip to Tokyo\n\nMake it cheaper");
});

test("imported original messages are not questions this conversation asked", () => {
    const seed = reviewSeedFromChat(
        [{ id: "x", role: "user", content: "Imported question", imported: { provider: "chatgpt" } }, ...turns.slice(0, 2)],
        "a1",
        "Earlier:"
    );
    assert.equal(seed, "Plan a 3-day trip to Tokyo");
});

test("no question, an unknown id or a user message gives no seed", () => {
    assert.equal(reviewSeedFromChat([{ id: "a", role: "assistant", content: "hi" }], "a", "Earlier:"), null);
    assert.equal(reviewSeedFromChat(turns, "missing", "Earlier:"), null);
    assert.equal(reviewSeedFromChat(turns, "u1", "Earlier:"), null);
});

test("the question always fits; context gives way first", () => {
    const long = "q".repeat(REVIEW_PREFILL_MAX_CHARS - 10);
    const seed = reviewSeedFromChat(
        [{ id: "u0", role: "user", content: "earlier question" }, { id: "a0", role: "assistant", content: "x" },
            { id: "u1", role: "user", content: long }, { id: "a1", role: "assistant", content: "y" }],
        "a1",
        "Earlier:"
    );
    assert.equal(seed, long);
    assert.ok(reviewSeedFromChat([{ id: "u", role: "user", content: "z".repeat(5000) }, { id: "a", role: "assistant", content: "" }], "a", "E").length <= REVIEW_PREFILL_MAX_CHARS);
});

test("the href is the existing Review prefill, clipped to what it reads", () => {
    assert.equal(reviewPrefillHref("a b&c"), "/review?prompt=a%20b%26c");
    const href = reviewPrefillHref("가".repeat(5000));
    assert.equal(decodeURIComponent(href.split("prompt=")[1]).length, REVIEW_PREFILL_MAX_CHARS);
});

// Two fictional quotes with the same file name and question: A says the
// cancellation fee is 10%, B says 30%. Nothing about either file reaches the
// handoff -- only "this turn had one available PDF".
const QUESTION = "What is the cancellation fee?";
const quoteA = { id: "att-a", attachmentId: "att-a", name: "quote.pdf", mediaType: "application/pdf", size: 1200, kind: "file" };
const quoteB = { id: "att-b", attachmentId: "att-b", name: "quote.pdf", mediaType: "application/pdf", size: 1300, kind: "file" };
const pdfTurns = [
    { id: "u1", role: "user", content: QUESTION, attachments: [quoteA] },
    { id: "a1", role: "assistant", content: "10% of the remaining term." },
    { id: "u2", role: "user", content: QUESTION, attachments: [quoteB] },
    { id: "a2", role: "assistant", content: "30% of the remaining term." },
    { id: "u3", role: "user", content: "Summarise the warranty" },
    { id: "a3", role: "assistant", content: "Two years." },
    { id: "u4", role: "user", content: "", attachments: [quoteA] },
    { id: "a4", role: "assistant", content: "This is a quote." },
];

test("a question sent with one available PDF asks for the file again", () => {
    assert.deepEqual(chatReviewHandoffFor(pdfTurns, "a1", "Earlier:"), { kind: "seed", seed: QUESTION, reattachFile: true });
});

test("an earlier answer is judged by its own turn, not the latest one", () => {
    const own = chatReviewHandoffFor(pdfTurns, "a2", "Earlier:");
    assert.equal(own.kind, "seed");
    assert.equal(own.reattachFile, true);
    assert.equal(own.seed, `Earlier:\n- ${QUESTION}\n\n${QUESTION}`);
    // A later text-only question does not inherit the earlier turn's PDF.
    assert.equal(chatReviewHandoffFor(pdfTurns, "a3", "Earlier:").reattachFile, false);
});

test("the same question with quote A or quote B carries no file detail at all", () => {
    const a = chatReviewHandoffFor(pdfTurns.slice(0, 2), "a1", "Earlier:");
    const b = chatReviewHandoffFor([pdfTurns[2], pdfTurns[3]], "a2", "Earlier:");
    assert.deepEqual(a, b);
    const serialised = JSON.stringify(a) + reviewPrefillHref(a.seed, "token");
    for (const leaked of ["quote.pdf", "att-a", "att-b", "application/pdf", "1200"]) {
        assert.equal(serialised.includes(leaked), false, leaked);
    }
});

test("a file-only turn has no question and never borrows an earlier one", () => {
    assert.deepEqual(chatReviewHandoffFor(pdfTurns, "a4", "Earlier:"), { kind: "no-question" });
    // The older helper (native app) still skips it; the web path does not.
    assert.equal(reviewSeedFromChat(pdfTurns, "a4", "Earlier:").endsWith("Summarise the warranty"), true);
});

const oneTurn = (attachments) => chatReviewHandoffFor([{ id: "u", role: "user", content: QUESTION, attachments }, { id: "a", role: "assistant", content: "x" }], "a", "E");
const OOXML = "application/vnd.openxmlformats-officedocument";

test("one readable document of any office kind asks for the file again", () => {
    for (const [name, mediaType] of [
        ["quote.pdf", "application/pdf"],
        ["QUOTE.PDF", "application/octet-stream"],
        ["quote.docx", `${OOXML}.wordprocessingml.document`],
        ["prices.xlsx", `${OOXML}.spreadsheetml.sheet`],
        ["pitch.pptx", `${OOXML}.presentationml.presentation`],
        ["quote.odt", "application/vnd.oasis.opendocument.text"],
        ["quote.doc", "application/msword"],
        ["prices.xls", "application/vnd.ms-excel"],
        ["pitch.ppt", "application/vnd.ms-powerpoint"],
        ["견적서.hwp", "application/x-hwp"],
        ["견적서.hwpx", "application/hwp+zip"],
        ["quote.rtf", "application/rtf"],
    ]) {
        assert.equal(oneTurn([{ name, mediaType }]).reattachFile, true, name);
    }
});

test("text-only, several files, unread or non-document files and an unavailable file keep the plain text handoff", () => {
    assert.equal(oneTurn(undefined).reattachFile, false);
    assert.equal(oneTurn([]).reattachFile, false);
    assert.equal(oneTurn([quoteA, quoteB]).reattachFile, false);
    assert.equal(oneTurn([quoteA, { name: "prices.xlsx", mediaType: `${OOXML}.spreadsheetml.sheet` }]).reattachFile, false);
    // iWork is stored unread: picking it again would compare nothing.
    assert.equal(oneTurn([{ name: "quote.pages", mediaType: "application/vnd.apple.pages" }]).reattachFile, false);
    assert.equal(oneTurn([{ name: "prices.numbers", mediaType: "application/vnd.apple.numbers" }]).reattachFile, false);
    assert.equal(oneTurn([{ name: "scan.png", mediaType: "image/png" }]).reattachFile, false);
    assert.equal(oneTurn([{ name: "prices.csv", mediaType: "text/csv" }]).reattachFile, false);
    assert.equal(oneTurn([{ name: "notes.txt", mediaType: "text/plain" }]).reattachFile, false);
    assert.equal(oneTurn([{ name: "bundle.zip", mediaType: "application/zip" }]).reattachFile, false);
    // A type alone does not make a document: the format table needs the extension.
    assert.equal(oneTurn([{ name: "quote", mediaType: "application/pdf" }]).reattachFile, false);
    assert.equal(oneTurn([{ name: "quote.pdf", mediaType: "image/png" }]).reattachFile, false);
    assert.equal(oneTurn([{ ...quoteA, unavailableAt: "2026-11-20T00:00:00.000Z" }]).reattachFile, false);
    assert.equal(oneTurn([{ name: "quote.docx", mediaType: `${OOXML}.wordprocessingml.document`, unavailableAt: "2026-11-20T00:00:00.000Z" }]).reattachFile, false);
});

test("the Review side settles on any readable document, never on an image or iWork", () => {
    assert.equal(isReattachableDocument({ name: "quote.pdf", mediaType: "application/pdf" }), true);
    assert.equal(isReattachableDocument({ name: "prices.xlsx", mediaType: `${OOXML}.spreadsheetml.sheet` }), true);
    assert.equal(isReattachableDocument({ name: "scan.png", mediaType: "image/png" }), false);
    assert.equal(isReattachableDocument({ name: "quote.pages", mediaType: "application/vnd.apple.pages" }), false);
});

test("imported turns, unknown ids and user ids give no handoff", () => {
    assert.equal(chatReviewHandoffFor(pdfTurns, "missing", "E"), null);
    assert.equal(chatReviewHandoffFor(pdfTurns, "u1", "E"), null);
    assert.equal(chatReviewHandoffFor([{ id: "x", role: "user", content: QUESTION, attachments: [quoteA], imported: { provider: "chatgpt" } }, { id: "a", role: "assistant", content: "y" }], "a", "E"), null);
});

test("the file marker is one-shot, tab-local and bound to the account that clicked", () => {
    clearReviewFileHandoffs();
    const href = reviewPrefillHref(QUESTION, "tok-1");
    assert.equal(new URL(href, "https://x.test").searchParams.get(REVIEW_FILE_HANDOFF_PARAM), "tok-1");
    assert.equal(reviewPrefillHref(QUESTION), "/review?prompt=What%20is%20the%20cancellation%20fee%3F");

    // A copied URL in another tab names a token this tab never issued.
    assert.equal(takeReviewFileHandoff("tok-1", "account:a"), false);

    const token = beginReviewFileHandoff("account:a");
    assert.equal(takeReviewFileHandoff(token, "account:b"), false, "another account");
    assert.equal(takeReviewFileHandoff(token, "account:a"), false, "a refused arrival still consumed it");

    const fresh = beginReviewFileHandoff("account:a");
    assert.equal(takeReviewFileHandoff(fresh, "account:a"), true);
    assert.equal(takeReviewFileHandoff(fresh, "account:a"), false, "back/forward cannot revive it");

    // A double click issues two tokens for the same handoff; whichever URL
    // lands is honoured once, and the other dies with it.
    const first = beginReviewFileHandoff("account:a");
    const second = beginReviewFileHandoff("account:a");
    assert.equal(takeReviewFileHandoff(second, "account:a"), true);
    assert.equal(takeReviewFileHandoff(first, "account:a"), false);

    // A later compare without a PDF supersedes a waiting one.
    const stale = beginReviewFileHandoff("account:a");
    clearReviewFileHandoffs();
    assert.equal(takeReviewFileHandoff(stale, "account:a"), false);
    assert.equal(takeReviewFileHandoff(null, "account:a"), false);
});
