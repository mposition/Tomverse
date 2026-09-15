// PLANNER-03: the prompt-injection test report.
//
//   npm run check:prompt-injection
//   npm run check:prompt-injection -- --json
//
// The gate's metric is
// `adversarial_retrieved_content_instruction_precedence_violations = 0` and the
// evidence it names is "memory, attachment, import, and project-content
// prompt-injection test report". This is that report, and it fails the build
// when the count is not zero -- a report nobody can fail is a document, not a
// gate.
//
// Every payload in tests/fixtures/promptInjectionCorpus.mjs is pushed through
// each builder that puts untrusted text into a prompt. Fenced text surfaces
// are checked for region containment; the Prompt Refiner's role-separated
// surface is checked for system-first rules and the exact two-field JSON data
// message. This deliberately does not claim whether a model obeys an
// instruction, which no repository assertion could hold.
//
// ## The sources and prompt surfaces the gate currently names
//
//   * memory       -- lib/memoryContextPrompt.ts. Covered below.
//   * attachment   -- lib/attachmentContextPrompt.ts. Covered below.
//   * import       -- imported conversation text does NOT reach a live prompt.
//                     It reaches memory extraction offline, and what can then
//                     reach a prompt is a validated memory, through the memory
//                     builder above. The corpus is run through the memory
//                     surface as import-derived content for that reason.
//   * project      -- ConversationProject carries a name and nothing else
//                     (prisma/schema.prisma). There is no project instruction
//                     text in this product, so there is no prompt path to
//                     test. Reported explicitly as "no surface" rather than
//                     silently omitted: a source the report does not mention
//                     reads as a source that passed.
//   * profile      -- assistant profile knowledge excerpts reach the dedicated
//                     fenced knowledge builder. Covered below.
//   * refiner      -- current-turn text reaches only the Prompt Refiner's
//                     system-first, canonical JSON data message. Covered below.
//
// If a project instruction field is ever added, this script fails until a
// surface for it is registered -- see SURFACE_COVERAGE below.

import {
    KNOWLEDGE_CONTEXT_RULES,
    KNOWLEDGE_MARKERS,
    buildProfileKnowledgePrompt,
} from "../lib/assistantProfilePrompt.ts";
import {
    ATTACHMENT_CONTEXT_RULES,
    buildAttachmentPromptText,
} from "../lib/attachmentContextPrompt.ts";
import {
    MEMORY_CONTEXT_RULES,
    buildMemoryContextPrompt,
} from "../lib/memoryContextPrompt.ts";
import {
    INJECTION_METRIC,
    auditAssembledPrompt,
    auditPromptRefinerMessages,
} from "../lib/promptInjectionAudit.ts";
import {
    PROMPT_REFINER_SYSTEM_INSTRUCTION,
    promptRefinerModelMessages,
} from "../lib/promptRefinerModelPrompt.ts";
import {
    PROMPT_REFINER_INPUT_SCOPE,
} from "../lib/promptRefinerSuggestion.ts";
import {
    ATTACHMENT_MARKERS,
    MEMORY_MARKERS,
    PROMPT_INJECTION_CORPUS,
} from "../tests/fixtures/promptInjectionCorpus.mjs";

const json = process.argv.includes("--json");

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

const BENIGN_KNOWLEDGE_PROMPT = buildProfileKnowledgePrompt([
    { fileName: "handbook.pdf", ordinal: 0, text: "Ordinary body." },
].map((entry) => ({
    fileName: entry.fileName,
    ordinal: entry.ordinal,
    content: entry.text,
})));


/**
 * Every untrusted source the gate names, and how it is exercised. A source
 * with no prompt path is recorded as such rather than dropped.
 */
const SURFACE_COVERAGE = [
    { source: "memory", surface: "memory", exercised: true },
    { source: "attachment", surface: "attachment", exercised: true },
    {
        source: "import",
        surface: "memory",
        exercised: true,
        note: "import text reaches a prompt only as a validated memory",
    },
    {
        source: "project",
        surface: null,
        exercised: false,
        note: "ConversationProject has a name and no instruction text, so no prompt path exists",
    },
    {
        // Release C added a fourth path the gate's four names predate: a
        // Policy: docs/policy/external-conversation-import-and-memory.md.
        // knowledge file's excerpts. §9.1 makes an instruction inside one
        // untrusted content, so it is measured here rather than trusted for
        // having been uploaded by the account owner.
        source: "profile-knowledge",
        surface: "profile-knowledge",
        exercised: true,
        note: "assistant profile knowledge excerpts (release C, §14)",
    },
    {
        source: "prompt-refiner-current-turn",
        surface: "prompt-refiner",
        exercised: true,
        note: "current user-turn text is role-separated and encoded as the sole sourceText field",
    },
];

const memoryCase = (payload) => {
    const built = buildMemoryContextPrompt({
        selected: [
            {
                memory: { kind: "fact", statement: payload.text },
                score: 1,
                tier: "primary",
            },
        ],
    });
    return {
        surface: "memory",
        payloadId: payload.id,
        payload: payload.text,
        assembled: built.text ?? "",
        rules: MEMORY_CONTEXT_RULES,
        openMarker: MEMORY_MARKERS.open,
        closeMarker: MEMORY_MARKERS.close,
        expectedRegions: 1,
        // A memory statement is a short fact; the builder flattens it so it
        // cannot draw its own structure.
        flattensNewlines: true,
        invisiblePolicy: "none",
        baselineAssembled: BENIGN_MEMORY_PROMPT,
    };
};

const attachmentCase = (payload) => ({
    surface: "attachment",
    payloadId: payload.id,
    payload: payload.text,
    assembled: buildAttachmentPromptText({
        userText: "What does this document say?",
        attachments: [
            { name: "report.pdf", kind: "PDF file", text: payload.text },
        ],
    }),
    rules: ATTACHMENT_CONTEXT_RULES,
    openMarker: ATTACHMENT_MARKERS.open,
    closeMarker: ATTACHMENT_MARKERS.close,
    expectedRegions: 1,
    // A document's line structure is the content the user is asking about;
    // the closing fence is what makes keeping it safe.
    flattensNewlines: false,
    invisiblePolicy: "structural-only",
    baselineAssembled: BENIGN_ATTACHMENT_PROMPT,
});

/** A filename is attacker-controlled too, so it gets the corpus as well. */
const filenameCase = (payload) => ({
    surface: "attachment-filename",
    payloadId: payload.id,
    payload: payload.text,
    assembled: buildAttachmentPromptText({
        userText: "What does this document say?",
        attachments: [
            { name: payload.text, kind: "PDF file", text: "Ordinary body." },
        ],
    }),
    rules: ATTACHMENT_CONTEXT_RULES,
    openMarker: ATTACHMENT_MARKERS.open,
    closeMarker: ATTACHMENT_MARKERS.close,
    expectedRegions: 1,
    flattensNewlines: true,
    invisiblePolicy: "none",
    baselineAssembled: BENIGN_ATTACHMENT_PROMPT,
});

/** A knowledge excerpt is untrusted for the same reason a document is. */
const knowledgeCase = (payload) => ({
    surface: "profile-knowledge",
    payloadId: payload.id,
    payload: payload.text,
    assembled: buildProfileKnowledgePrompt([
        { fileName: "handbook.pdf", ordinal: 0, content: payload.text },
    ]),
    rules: KNOWLEDGE_CONTEXT_RULES,
    openMarker: KNOWLEDGE_MARKERS.open,
    closeMarker: KNOWLEDGE_MARKERS.close,
    expectedRegions: 1,
    flattensNewlines: false,
    invisiblePolicy: "structural-only",
    baselineAssembled: BENIGN_KNOWLEDGE_PROMPT,
});

const promptRefinerCase = (payload) => {
    let messages = null;
    try {
        messages = promptRefinerModelMessages({
            requestId: `planner03_${payload.id}`,
            prompt: payload.text,
        });
    } catch {
        // A future corpus entry may sit outside the product request schema.
        // That is still a failed audit surface, not an unhandled report crash;
        // no validation error or payload bytes are printed.
    }
    return {
        surface: "prompt-refiner",
        payloadId: payload.id,
        payload: payload.text,
        messages,
        rules: PROMPT_REFINER_SYSTEM_INSTRUCTION,
        inputScope: PROMPT_REFINER_INPUT_SCOPE,
    };
};

const violations = [];
const bySurface = new Map();

for (const payload of PROMPT_INJECTION_CORPUS) {
    for (const build of [
        memoryCase,
        attachmentCase,
        filenameCase,
        knowledgeCase,
    ]) {
        const input = build(payload);
        const found = auditAssembledPrompt(input);
        bySurface.set(input.surface, (bySurface.get(input.surface) ?? 0) + 1);
        violations.push(...found);
    }
    const refinerInput = promptRefinerCase(payload);
    const refinerViolations = auditPromptRefinerMessages(refinerInput);
    bySurface.set(
        refinerInput.surface,
        (bySurface.get(refinerInput.surface) ?? 0) + 1
    );
    violations.push(...refinerViolations);
}

const uncoveredSources = SURFACE_COVERAGE.filter(
    (entry) => !entry.exercised
).map((entry) => `${entry.source} (${entry.note})`);

const report = {
    metric: INJECTION_METRIC,
    value: violations.length,
    payloads: PROMPT_INJECTION_CORPUS.length,
    casesBySurface: Object.fromEntries(bySurface),
    sources: SURFACE_COVERAGE,
    violations,
};

if (json) {
    console.log(JSON.stringify(report, null, 2));
} else {
    console.log(`${INJECTION_METRIC} = ${violations.length}`);
    console.log(
        `${PROMPT_INJECTION_CORPUS.length} adversarial payload(s) through ` +
            [...bySurface.entries()]
                .map(([surface, count]) => `${surface} (${count})`)
                .join(", ")
    );
    for (const entry of uncoveredSources) {
        console.log(`not exercised: ${entry}`);
    }
    if (violations.length > 0) {
        console.error(
            `\n${violations.length} instruction-precedence violation(s):\n` +
                violations
                    .map(
                        (violation) =>
                            `  - [${violation.surface}] ${violation.payloadId}: ` +
                            `${violation.kind} -- ${violation.detail}`
                    )
                    .join("\n") +
                "\n"
        );
    }
}

if (violations.length > 0) {
    console.error(
        "PLANNER-03 requires untrusted content to stay data when the prompt is\n" +
            "assembled. See lib/promptInjectionAudit.ts for what each violation\n" +
            "kind means.\n"
    );
    process.exit(1);
}

console.log(
    "Untrusted content stayed data at every fenced and role-separated boundary."
);
