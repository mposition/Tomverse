// PLANNER-03's audit, checked against builders that have been deliberately
// weakened.
//
// `npm run check:prompt-injection` reports zero violations today. On its own
// that says nothing: a checker that cannot fail reports zero for a broken
// builder just as readily as for a sound one. These tests remove one defence
// at a time and assert the audit notices, so the zero in the report is a
// measurement rather than a hope.
//
// Each case names the defence it removes and the violation kind that should
// appear, because those two together are the contract -- not the exact wording
// of a message.

import assert from "node:assert/strict";
import test from "node:test";

import {
    ATTACHMENT_CONTEXT_RULES,
    ATTACHMENT_MARKERS,
    buildAttachmentPromptText,
} from "../lib/attachmentContextPrompt.ts";
import {
    MEMORY_CONTEXT_RULES,
    MEMORY_MARKERS,
    buildMemoryContextPrompt,
} from "../lib/memoryContextPrompt.ts";
import { auditAssembledPrompt } from "../lib/promptInjectionAudit.ts";
import { PROMPT_INJECTION_CORPUS } from "./fixtures/promptInjectionCorpus.mjs";


/**
 * The same builders run on ordinary content. Structure that appears in both
 * runs is the builder's own; only what a payload adds counts against it.
 */
const BENIGN_MEMORY_PROMPT =
    buildMemoryContextPrompt({
        selected: [
            {
                memory: {
                    kind: "fact",
                    statement: "Prefers concise answers about scheduling.",
                },
                score: 1,
                tier: "primary",
            },
        ],
    }).text ?? "";

const BENIGN_ATTACHMENT_PROMPT = buildAttachmentPromptText({
    userText: "What does this say?",
    attachments: [
        { name: "report.pdf", kind: "PDF file", text: "Ordinary body." },
    ],
});

const payloadNamed = (id) => {
    const entry = PROMPT_INJECTION_CORPUS.find((item) => item.id === id);
    assert.ok(entry, `the corpus no longer has a payload called ${id}`);
    return entry;
};

const memoryInput = (payload, overrides = {}) => ({
    surface: "memory",
    payloadId: payload.id,
    payload: payload.text,
    assembled:
        buildMemoryContextPrompt({
            selected: [
                {
                    memory: { kind: "fact", statement: payload.text },
                    score: 1,
                    tier: "primary",
                },
            ],
        }).text ?? "",
    rules: MEMORY_CONTEXT_RULES,
    openMarker: MEMORY_MARKERS.open,
    closeMarker: MEMORY_MARKERS.close,
    expectedRegions: 1,
    flattensNewlines: true,
    invisiblePolicy: "none",
    baselineAssembled: BENIGN_MEMORY_PROMPT,
    ...overrides,
});

const attachmentInput = (payload, overrides = {}) => ({
    surface: "attachment",
    payloadId: payload.id,
    payload: payload.text,
    assembled: buildAttachmentPromptText({
        userText: "What does this say?",
        attachments: [
            { name: "report.pdf", kind: "PDF file", text: payload.text },
        ],
    }),
    rules: ATTACHMENT_CONTEXT_RULES,
    openMarker: ATTACHMENT_MARKERS.open,
    closeMarker: ATTACHMENT_MARKERS.close,
    expectedRegions: 1,
    flattensNewlines: false,
    invisiblePolicy: "structural-only",
    baselineAssembled: BENIGN_ATTACHMENT_PROMPT,
    ...overrides,
});

const kinds = (violations) => [...new Set(violations.map((v) => v.kind))].sort();

/* ---------------------------------------------- the builders as they stand */

test("every corpus payload is contained by the real memory builder", () => {
    for (const payload of PROMPT_INJECTION_CORPUS) {
        assert.deepEqual(
            auditAssembledPrompt(memoryInput(payload)),
            [],
            `${payload.id} escaped the memory builder`
        );
    }
});

test("every corpus payload is contained by the real attachment builder", () => {
    for (const payload of PROMPT_INJECTION_CORPUS) {
        assert.deepEqual(
            auditAssembledPrompt(attachmentInput(payload)),
            [],
            `${payload.id} escaped the attachment builder`
        );
    }
});

/* ------------------------------------------- one defence removed at a time */

test("a builder that stops defusing markers is caught", () => {
    // The defence: `inertStatement` rewrites a marker inside a statement to
    // "[marker]". Without it the payload closes the region and everything
    // after reads as ordinary prompt text.
    const payload = payloadNamed("close-memory-fence");
    const undefended = [
        MEMORY_CONTEXT_RULES,
        "",
        MEMORY_MARKERS.open,
        `- (fact) ${payload.text}`,
        MEMORY_MARKERS.close,
    ].join("\n");

    const found = auditAssembledPrompt(
        memoryInput(payload, { assembled: undefended })
    );
    assert.ok(found.length > 0, "a forged closing marker went unnoticed");
    assert.ok(kinds(found).includes("forged_boundary"), kinds(found).join());
});

test("a builder that stops flattening statements is caught", () => {
    // The defence: newlines inside a statement collapse to spaces, so a
    // statement cannot draw a heading of its own.
    const payload = payloadNamed("forge-section-heading");
    const unflattened = [
        MEMORY_CONTEXT_RULES,
        "",
        MEMORY_MARKERS.open,
        `- (fact) ${payload.text}`,
        MEMORY_MARKERS.close,
    ].join("\n");

    const found = auditAssembledPrompt(
        memoryInput(payload, { assembled: unflattened })
    );
    assert.ok(found.length > 0, "a forged section heading went unnoticed");
    assert.ok(kinds(found).includes("structure_injected"), kinds(found).join());
});

test("a builder that states its rules after the content is caught", () => {
    const payload = payloadNamed("priority-claim");
    const rulesLast = [
        MEMORY_MARKERS.open,
        `- (fact) ${payload.text}`,
        MEMORY_MARKERS.close,
        "",
        MEMORY_CONTEXT_RULES,
    ].join("\n");

    const found = auditAssembledPrompt(
        memoryInput(payload, { assembled: rulesLast })
    );
    assert.ok(kinds(found).includes("rules_after_content"), kinds(found).join());
});

test("a builder that drops the closing fence is caught", () => {
    // This is the shape the attachment path actually had before
    // `attach-context-v1`: a label, then the document, then nothing.
    const payload = payloadNamed("close-attachment-fence");
    const unfenced = [
        "What does this say?",
        ATTACHMENT_CONTEXT_RULES,
        ATTACHMENT_MARKERS.open,
        "[Attached PDF file: report.pdf]",
        payload.text,
    ].join("\n\n");

    const found = auditAssembledPrompt(
        attachmentInput(payload, { assembled: unfenced })
    );
    assert.ok(found.length > 0, "an unterminated document region went unnoticed");
});

test("a body that keeps control characters is caught, and bidi is not", () => {
    // The two halves of the "structural-only" policy, asserted together
    // because the value of each is that the other does not happen: a NUL is
    // never document text, and a bidi mark is exactly what a Hebrew or Arabic
    // document needs.
    const control = payloadNamed("control-characters");
    const rawControl = [
        "What does this say?",
        ATTACHMENT_CONTEXT_RULES,
        [
            ATTACHMENT_MARKERS.open,
            "[Attached PDF file: report.pdf]",
            control.text,
            ATTACHMENT_MARKERS.close,
        ].join("\n"),
    ].join("\n\n");
    assert.ok(
        kinds(
            auditAssembledPrompt(
                attachmentInput(control, { assembled: rawControl })
            )
        ).includes("structure_injected"),
        "a control character in a document body went unnoticed"
    );

    const bidi = payloadNamed("bidi-override");
    assert.deepEqual(
        auditAssembledPrompt(attachmentInput(bidi)),
        [],
        "bidi marks in a document body must not be reported: a right-to-left " +
            "document needs them to say what it says"
    );
});

test("a filename is held to the stricter policy than a body", () => {
    // The filename is attacker-controlled and is not content, so nothing
    // invisible belongs in it -- including the bidi marks a body may keep.
    const bidi = payloadNamed("bidi-override");
    const assembled = buildAttachmentPromptText({
        userText: "What does this say?",
        attachments: [
            { name: bidi.text, kind: "PDF file", text: "Ordinary body." },
        ],
    });
    assert.deepEqual(
        auditAssembledPrompt(
            attachmentInput(bidi, {
                surface: "attachment-filename",
                assembled,
                flattensNewlines: true,
                invisiblePolicy: "none",
            })
        ),
        [],
        "the real builder inerts the filename; this asserts it still does"
    );
});

/* ------------------------------------------------------- the audit's edges */

test("a payload line that is only a marker is left to the boundary rule", () => {
    // Otherwise the containment check matches the builder's own marker and
    // reports a violation for a payload the builder defused correctly. That
    // false positive is what the first draft of this audit produced.
    const payload = payloadNamed("open-a-second-region");
    assert.deepEqual(auditAssembledPrompt(memoryInput(payload)), []);
});

test("short payload lines do not count as escapes", () => {
    // A check that fires on a coincidence gets weakened the first time it
    // does, so it never fires on the real thing.
    const found = auditAssembledPrompt(
        memoryInput({ id: "short", text: "ok\nno\nyes" })
    );
    assert.deepEqual(found, []);
});
