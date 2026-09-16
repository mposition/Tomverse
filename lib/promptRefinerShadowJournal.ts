/** Node-only, provider-free append-only shadow journal. */
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
    canonicalBenchmarkJson,
    parseBenchmarkJson,
} from "./routerDevelopmentBenchmark";
import {
    PROMPT_REFINER_SHADOW_COST_MICRO_USD,
    PROMPT_REFINER_SHADOW_CORPUS_CASES,
    PROMPT_REFINER_SHADOW_HARNESS_VERSION,
    PROMPT_REFINER_SHADOW_PROVIDER_CALLS,
    evaluatePromptRefinerShadowCase,
    validatePromptRefinerShadowCorpus,
    type PromptRefinerShadowCaseEvaluation,
    type PromptRefinerShadowCorpus,
    type PromptRefinerShadowFailureCode,
} from "./promptRefinerShadowHarness";
import type { PromptRefinerShadowSourceIdentity } from "./promptRefinerShadowSource";

export const PROMPT_REFINER_SHADOW_JOURNAL_VERSION =
    "prompt-refiner-shadow-journal-v1" as const;
export const PROMPT_REFINER_SHADOW_JOURNAL_MAX_BYTES = 1024 * 1024;
export const PROMPT_REFINER_SHADOW_EVENT_MAX_BYTES = 8 * 1024;

type ShadowHeader = {
    kind: "header";
    schemaVersion: typeof PROMPT_REFINER_SHADOW_JOURNAL_VERSION;
    harnessVersion: typeof PROMPT_REFINER_SHADOW_HARNESS_VERSION;
    corpusDigest: string;
    corpusCases: typeof PROMPT_REFINER_SHADOW_CORPUS_CASES;
    sourceRef: string;
    sourceIdentityDigest: string;
    providerCalls: typeof PROMPT_REFINER_SHADOW_PROVIDER_CALLS;
    costMicroUsd: typeof PROMPT_REFINER_SHADOW_COST_MICRO_USD;
};
type ShadowTerminal = {
    kind: "case_terminal";
    caseId: string;
    status: PromptRefinerShadowCaseEvaluation["status"];
    failureCode: PromptRefinerShadowFailureCode | null;
    structuralBoundaryViolations: number;
    behavioralOutcomeMatched: boolean;
    providerCalls: typeof PROMPT_REFINER_SHADOW_PROVIDER_CALLS;
    costMicroUsd: typeof PROMPT_REFINER_SHADOW_COST_MICRO_USD;
};
type ShadowIntent = {
    kind: "case_intent";
    caseId: string;
    providerCalls: typeof PROMPT_REFINER_SHADOW_PROVIDER_CALLS;
    costMicroUsd: typeof PROMPT_REFINER_SHADOW_COST_MICRO_USD;
};
type ShadowStopped = {
    kind: "run_stopped";
    reason:
        | "case_limit"
        | "structural_boundary_violation"
        | "behavioral_fixture_mismatch";
    processedCases: number;
    remainingCases: number;
};
type ShadowResumed = {
    kind: "run_resumed";
    fromStatus: "stopped" | "interrupted";
    processedCases: number;
    remainingCases: number;
};
type ShadowCompleted = {
    kind: "run_completed";
    processedCases: typeof PROMPT_REFINER_SHADOW_CORPUS_CASES;
    structuralBoundaryPopulation: typeof PROMPT_REFINER_SHADOW_CORPUS_CASES;
    structuralBoundaryViolations: 0;
    behavioralOutcomePopulation: typeof PROMPT_REFINER_SHADOW_CORPUS_CASES;
    behavioralOutcomeMatches: typeof PROMPT_REFINER_SHADOW_CORPUS_CASES;
    providerCalls: typeof PROMPT_REFINER_SHADOW_PROVIDER_CALLS;
    costMicroUsd: typeof PROMPT_REFINER_SHADOW_COST_MICRO_USD;
};
export type PromptRefinerShadowJournalEvent =
    | ShadowHeader
    | ShadowIntent
    | ShadowTerminal
    | ShadowStopped
    | ShadowResumed
    | ShadowCompleted;

type ShadowEnvelope = {
    seq: number;
    previousDigest: string | null;
    event: PromptRefinerShadowJournalEvent;
    entryDigest: string;
};

export type PromptRefinerShadowReplay = {
    status: "completed" | "stopped" | "interrupted";
    stopReason: ShadowStopped["reason"] | null;
    resumable: boolean;
    processedCases: number;
    structuralBoundaryPopulation: number;
    structuralBoundaryViolations: number;
    behavioralOutcomePopulation: number;
    behavioralOutcomeMatches: number;
    remainingCases: number;
    unknownCases: number;
    providerCalls: 0;
    costMicroUsd: 0;
    entries: ShadowEnvelope[];
    terminals: Map<string, ShadowTerminal>;
    intents: Map<string, ShadowIntent>;
};

export type PromptRefinerShadowIO = Pick<
    typeof fs,
    | "openSync"
    | "closeSync"
    | "readSync"
    | "writeSync"
    | "fsyncSync"
    | "fstatSync"
    | "existsSync"
    | "mkdirSync"
    | "unlinkSync"
    | "lstatSync"
>;

export type PromptRefinerShadowPaths = {
    journal: string;
    witness: string;
    lock: string;
};

export type PromptRefinerShadowRunReport = Omit<
    PromptRefinerShadowReplay,
    "entries" | "terminals" | "intents"
> & {
    schemaVersion: typeof PROMPT_REFINER_SHADOW_JOURNAL_VERSION;
    purpose: "development-only";
    dataClassification: "synthetic_test_only";
    harnessVersion: typeof PROMPT_REFINER_SHADOW_HARNESS_VERSION;
    corpusDigest: string;
    corpusCases: typeof PROMPT_REFINER_SHADOW_CORPUS_CASES;
    sourceRef: string;
    sourceIdentityDigest: string;
};

type ShadowSourceIdentity = Pick<
    PromptRefinerShadowSourceIdentity,
    "sourceRef" | "identityDigest"
>;

function fail(code: string): never {
    throw new Error(`prompt_refiner_shadow_${code}`);
}

function validateSourceIdentity(
    value: ShadowSourceIdentity
): ShadowSourceIdentity {
    if (
        value === null ||
        typeof value !== "object" ||
        !/^[a-f0-9]{40}$/.test(value.sourceRef) ||
        !/^[a-f0-9]{64}$/.test(value.identityDigest)
    ) {
        fail("source_identity");
    }
    return {
        sourceRef: value.sourceRef,
        identityDigest: value.identityDigest,
    };
}

function exactObject(
    value: unknown,
    fields: readonly string[],
    where: string
): Record<string, unknown> {
    if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    ) {
        return fail(`${where}_object_required`);
    }
    const keys = Object.keys(value).sort();
    const expected = [...fields].sort();
    if (
        keys.length !== expected.length ||
        keys.some((key, index) => key !== expected[index])
    ) {
        fail(`${where}_unexpected_or_missing_fields`);
    }
    return value as Record<string, unknown>;
}

const digest = (value: unknown): string => {
    return createHash("sha256")
        .update(canonicalBenchmarkJson(value), "utf8")
        .digest("hex");
};

export function promptRefinerShadowPaths(
    journalPath: string
): PromptRefinerShadowPaths {
    const journal = resolve(journalPath);
    return {
        journal,
        witness: `${journal}.witness.jsonl`,
        lock: `${journal}.lock`,
    };
}

function readBoundedText(
    path: string,
    maximum: number,
    io: PromptRefinerShadowIO
): string {
    if (io.lstatSync(path).isSymbolicLink()) fail("symlink");
    const descriptor = io.openSync(path, "r");
    try {
        const stat = io.fstatSync(descriptor);
        if (!stat.isFile() || stat.size > maximum) fail("file_size_or_type");
        const buffer = Buffer.alloc(stat.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const count = io.readSync(
                descriptor,
                buffer,
                offset,
                buffer.length - offset,
                null
            );
            if (!count) break;
            offset += count;
        }
        if (offset !== stat.size) fail("file_changed_during_read");
        return new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, offset)
        );
    } finally {
        io.closeSync(descriptor);
    }
}

function writeDurably(
    path: string,
    text: string,
    flag: "wx" | "a",
    io: PromptRefinerShadowIO
): void {
    const descriptor = io.openSync(path, flag, 0o600);
    try {
        const bytes = Buffer.from(text, "utf8");
        let offset = 0;
        while (offset < bytes.length) {
            const count = io.writeSync(
                descriptor,
                bytes,
                offset,
                bytes.length - offset,
                null
            );
            if (
                !Number.isSafeInteger(count) ||
                count <= 0 ||
                count > bytes.length - offset
            ) {
                fail("short_write");
            }
            offset += count;
        }
        io.fsyncSync(descriptor);
    } finally {
        io.closeSync(descriptor);
    }
}

function jsonLines(text: string, maximum: number): unknown[] {
    if (!text || !text.endsWith("\n")) fail("journal_truncated");
    const lines = text.slice(0, -1).split("\n");
    if (lines.some((line) => !line)) fail("journal_blank_line");
    return lines.map((line) => {
        try {
            return parseBenchmarkJson(line, maximum);
        } catch {
            return fail("journal_json");
        }
    });
}

function terminalFrom(
    value: Record<string, unknown>,
    corpus: PromptRefinerShadowCorpus,
    intents: Map<string, ShadowIntent>,
    terminals: Map<string, ShadowTerminal>
): ShadowTerminal {
    const item = corpus.cases.find((candidate) => candidate.id === value.caseId);
    if (
        !item ||
        !intents.has(item.id) ||
        terminals.has(item.id) ||
        [...intents.keys()].at(-1) !== item.id
    ) {
        fail("duplicate_or_orphan_terminal");
    }
    if (
        value.providerCalls !== PROMPT_REFINER_SHADOW_PROVIDER_CALLS ||
        value.costMicroUsd !== PROMPT_REFINER_SHADOW_COST_MICRO_USD ||
        !["suggested", "failed"].includes(value.status as string) ||
        !Number.isSafeInteger(value.structuralBoundaryViolations) ||
        (value.structuralBoundaryViolations as number) < 0 ||
        typeof value.behavioralOutcomeMatched !== "boolean"
    ) {
        fail("terminal_shape");
    }
    const actual = evaluatePromptRefinerShadowCase(item);
    if (
        value.status !== actual.status ||
        value.failureCode !== actual.failureCode ||
        value.structuralBoundaryViolations !==
            actual.structuralBoundaryViolations ||
        value.behavioralOutcomeMatched !== actual.behavioralOutcomeMatched
    ) {
        fail("terminal_result_mismatch");
    }
    return value as ShadowTerminal;
}

function eventFrom(
    value: unknown,
    corpus: PromptRefinerShadowCorpus,
    sourceIdentity: ShadowSourceIdentity,
    sequence: number,
    intents: Map<string, ShadowIntent>,
    terminals: Map<string, ShadowTerminal>,
    priorStatus: PromptRefinerShadowReplay["status"] | "running" | null,
    priorStopReason: ShadowStopped["reason"] | null
): PromptRefinerShadowJournalEvent {
    const valueKind = (value as { kind?: unknown })?.kind;
    if (sequence === 0) {
        const header = exactObject(
            value,
            [
                "kind",
                "schemaVersion",
                "harnessVersion",
                "corpusDigest",
                "corpusCases",
                "sourceRef",
                "sourceIdentityDigest",
                "providerCalls",
                "costMicroUsd",
            ],
            "header"
        );
        if (
            valueKind !== "header" ||
            header.schemaVersion !== PROMPT_REFINER_SHADOW_JOURNAL_VERSION ||
            header.harnessVersion !== PROMPT_REFINER_SHADOW_HARNESS_VERSION ||
            header.corpusDigest !== corpus.contentDigest ||
            header.corpusCases !== PROMPT_REFINER_SHADOW_CORPUS_CASES ||
            header.sourceRef !== sourceIdentity.sourceRef ||
            header.sourceIdentityDigest !== sourceIdentity.identityDigest ||
            header.providerCalls !== 0 ||
            header.costMicroUsd !== 0
        ) {
            fail("journal_identity");
        }
        return header as ShadowHeader;
    }
    if (priorStatus === "completed") fail("event_after_completion");
    if (priorStatus === "stopped" && valueKind !== "run_resumed") {
        fail("resume_required_after_stop");
    }
    if (valueKind === "case_intent") {
        if (priorStatus !== "running") fail("intent_outside_run");
        const intent = exactObject(
            value,
            ["kind", "caseId", "providerCalls", "costMicroUsd"],
            "case_intent"
        );
        const next = corpus.cases[terminals.size];
        const pending = [...intents.keys()].filter(
            (caseId) => !terminals.has(caseId)
        );
        if (
            !next ||
            intent.caseId !== next.id ||
            intents.has(next.id) ||
            pending.length > 0 ||
            intent.providerCalls !== 0 ||
            intent.costMicroUsd !== 0
        ) {
            fail("duplicate_or_forged_intent");
        }
        intents.set(next.id, intent as ShadowIntent);
        return intent as ShadowIntent;
    }
    if (valueKind === "case_terminal") {
        if (priorStatus !== "running") fail("terminal_outside_run");
        const terminal = terminalFrom(
            exactObject(
                value,
                [
                    "kind",
                    "caseId",
                    "status",
                    "failureCode",
                    "structuralBoundaryViolations",
                    "behavioralOutcomeMatched",
                    "providerCalls",
                    "costMicroUsd",
                ],
                "case_terminal"
            ),
            corpus,
            intents,
            terminals
        );
        if (terminal.caseId !== corpus.cases[terminals.size]?.id) {
            fail("terminal_order");
        }
        terminals.set(terminal.caseId, terminal);
        return terminal;
    }
    if (valueKind === "run_stopped") {
        if (priorStatus !== "running") fail("stop_outside_run");
        if ([...intents.keys()].some((caseId) => !terminals.has(caseId))) {
            fail("stop_with_unknown_attempt");
        }
        const stopped = exactObject(
            value,
            ["kind", "reason", "processedCases", "remainingCases"],
            "run_stopped"
        );
        if (
            ![
                "case_limit",
                "structural_boundary_violation",
                "behavioral_fixture_mismatch",
            ].includes(
                stopped.reason as string
            ) ||
            stopped.processedCases !== terminals.size ||
            stopped.remainingCases !== corpus.cases.length - terminals.size ||
            stopped.remainingCases <= 0
        ) {
            fail("stop_state");
        }
        const last = [...terminals.values()].at(-1);
        const expectedStopReason = last?.structuralBoundaryViolations
            ? "structural_boundary_violation"
            : last && !last.behavioralOutcomeMatched
              ? "behavioral_fixture_mismatch"
              : "case_limit";
        if (stopped.reason !== expectedStopReason) {
            fail("stop_reason");
        }
        return stopped as ShadowStopped;
    }
    if (valueKind === "run_resumed") {
        const resumed = exactObject(
            value,
            ["kind", "fromStatus", "processedCases", "remainingCases"],
            "run_resumed"
        );
        const pendingIntent = [...intents.keys()].some(
            (caseId) => !terminals.has(caseId)
        );
        const failedInvariant = [...terminals.values()].some(
            (terminal) =>
                terminal.structuralBoundaryViolations !== 0 ||
                !terminal.behavioralOutcomeMatched
        );
        const priorMatches =
            (resumed.fromStatus === "stopped" && priorStatus === "stopped") ||
            (resumed.fromStatus === "interrupted" &&
                priorStatus === "running" &&
                !pendingIntent);
        if (
            !["stopped", "interrupted"].includes(
                resumed.fromStatus as string
            ) ||
            !priorMatches ||
            resumed.processedCases !== terminals.size ||
            resumed.remainingCases !== corpus.cases.length - terminals.size ||
            resumed.remainingCases <= 0 ||
            failedInvariant ||
            (priorStopReason === "structural_boundary_violation" ||
                priorStopReason === "behavioral_fixture_mismatch")
        ) {
            fail("resume_state");
        }
        return resumed as ShadowResumed;
    }
    if (valueKind === "run_completed") {
        if (priorStatus !== "running") fail("complete_outside_run");
        if ([...intents.keys()].some((caseId) => !terminals.has(caseId))) {
            fail("complete_with_unknown_attempt");
        }
        const completed = exactObject(
            value,
            [
                "kind",
                "processedCases",
                "structuralBoundaryPopulation",
                "structuralBoundaryViolations",
                "behavioralOutcomePopulation",
                "behavioralOutcomeMatches",
                "providerCalls",
                "costMicroUsd",
            ],
            "run_completed"
        );
        if (
            terminals.size !== corpus.cases.length ||
            [...terminals.values()].some(
                (terminal) =>
                    terminal.structuralBoundaryViolations !== 0 ||
                    !terminal.behavioralOutcomeMatched
            ) ||
            completed.processedCases !== corpus.cases.length ||
            completed.structuralBoundaryPopulation !== corpus.cases.length ||
            completed.structuralBoundaryViolations !== 0 ||
            completed.behavioralOutcomePopulation !== corpus.cases.length ||
            completed.behavioralOutcomeMatches !== corpus.cases.length ||
            completed.providerCalls !== 0 ||
            completed.costMicroUsd !== 0
        ) {
            fail("complete_state");
        }
        return completed as ShadowCompleted;
    }
    fail("journal_event_kind");
}

export function replayPromptRefinerShadowJournal(input: {
    journalText: string;
    witnessText: string;
    corpus: PromptRefinerShadowCorpus;
    sourceIdentity: ShadowSourceIdentity;
}): PromptRefinerShadowReplay {
    const corpus = validatePromptRefinerShadowCorpus(input.corpus);
    const sourceIdentity = validateSourceIdentity(input.sourceIdentity);
    if (
        Buffer.byteLength(input.journalText, "utf8") >
            PROMPT_REFINER_SHADOW_JOURNAL_MAX_BYTES ||
        Buffer.byteLength(input.witnessText, "utf8") >
            PROMPT_REFINER_SHADOW_JOURNAL_MAX_BYTES
    ) {
        fail("journal_byte_limit");
    }
    const rawEntries = jsonLines(
        input.journalText,
        PROMPT_REFINER_SHADOW_EVENT_MAX_BYTES
    );
    const rawWitness = jsonLines(
        input.witnessText,
        PROMPT_REFINER_SHADOW_EVENT_MAX_BYTES
    );
    const witnessHeader = exactObject(
        rawWitness[0],
        [
            "schemaVersion",
            "harnessVersion",
            "corpusDigest",
            "sourceRef",
            "sourceIdentityDigest",
        ],
        "witness_header"
    );
    if (
        witnessHeader.schemaVersion !==
            PROMPT_REFINER_SHADOW_JOURNAL_VERSION ||
        witnessHeader.harnessVersion !== PROMPT_REFINER_SHADOW_HARNESS_VERSION ||
        witnessHeader.corpusDigest !== corpus.contentDigest ||
        witnessHeader.sourceRef !== sourceIdentity.sourceRef ||
        witnessHeader.sourceIdentityDigest !== sourceIdentity.identityDigest
    ) {
        fail("witness_identity");
    }
    const entries: ShadowEnvelope[] = [];
    const intents = new Map<string, ShadowIntent>();
    const terminals = new Map<string, ShadowTerminal>();
    let status: PromptRefinerShadowReplay["status"] | "running" | null = null;
    let stopReason: ShadowStopped["reason"] | null = null;
    for (const [sequence, candidate] of rawEntries.entries()) {
        const envelope = exactObject(
            candidate,
            ["seq", "previousDigest", "event", "entryDigest"],
            "journal_entry"
        );
        const previousDigest = entries.at(-1)?.entryDigest ?? null;
        const body = {
            seq: sequence,
            previousDigest,
            event: envelope.event,
        };
        if (
            envelope.seq !== sequence ||
            envelope.previousDigest !== previousDigest ||
            envelope.entryDigest !== digest(body)
        ) {
            fail("journal_chain");
        }
        const event = eventFrom(
            envelope.event,
            corpus,
            sourceIdentity,
            sequence,
            intents,
            terminals,
            status,
            stopReason
        );
        if (event.kind === "header" || event.kind === "run_resumed") {
            status = "running";
            stopReason = null;
        } else if (event.kind === "run_stopped") {
            status = "stopped";
            stopReason = event.reason;
        } else if (event.kind === "run_completed") {
            status = "completed";
            stopReason = null;
        }
        entries.push({
            seq: sequence,
            previousDigest,
            event,
            entryDigest: envelope.entryDigest as string,
        });
    }
    if (!entries.length || entries[0].event.kind !== "header") {
        fail("journal_header_missing");
    }
    if (rawWitness.length !== entries.length + 1) {
        fail("journal_witness_mismatch");
    }
    entries.forEach((entry, index) => {
        const witness = exactObject(
            rawWitness[index + 1],
            ["seq", "entryDigest"],
            "witness_entry"
        );
        if (
            witness.seq !== entry.seq ||
            witness.entryDigest !== entry.entryDigest
        ) {
            fail("journal_witness_mismatch");
        }
    });
    const effectiveStatus = status === "running" ? "interrupted" : status;
    if (!effectiveStatus) fail("journal_state");
    const unknownCases = [...intents.keys()].filter(
        (caseId) => !terminals.has(caseId)
    ).length;
    const failedInvariant = [...terminals.values()].some(
        (terminal) =>
            terminal.structuralBoundaryViolations !== 0 ||
            !terminal.behavioralOutcomeMatched
    );
    return {
        status: effectiveStatus,
        stopReason,
        resumable:
            (effectiveStatus === "interrupted" &&
                unknownCases === 0 &&
                !failedInvariant) ||
            (effectiveStatus === "stopped" && stopReason === "case_limit"),
        processedCases: terminals.size,
        structuralBoundaryPopulation: terminals.size,
        structuralBoundaryViolations: [...terminals.values()].reduce(
            (total, terminal) => total + terminal.structuralBoundaryViolations,
            0
        ),
        behavioralOutcomePopulation: terminals.size,
        behavioralOutcomeMatches: [...terminals.values()].filter(
            (terminal) => terminal.behavioralOutcomeMatched
        ).length,
        remainingCases: corpus.cases.length - terminals.size,
        unknownCases,
        providerCalls: 0,
        costMicroUsd: 0,
        entries,
        terminals,
        intents,
    };
}

function appendEvent(
    event: PromptRefinerShadowJournalEvent,
    entries: ShadowEnvelope[],
    paths: PromptRefinerShadowPaths,
    io: PromptRefinerShadowIO
): void {
    const body = {
        seq: entries.length,
        previousDigest: entries.at(-1)?.entryDigest ?? null,
        event,
    };
    const entry = { ...body, entryDigest: digest(body) };
    const line = `${canonicalBenchmarkJson(entry)}\n`;
    if (Buffer.byteLength(line, "utf8") > PROMPT_REFINER_SHADOW_EVENT_MAX_BYTES) {
        fail("event_byte_limit");
    }
    const priorBytes = io.existsSync(paths.journal)
        ? io.lstatSync(paths.journal).size
        : 0;
    if (
        priorBytes + Buffer.byteLength(line, "utf8") >
        PROMPT_REFINER_SHADOW_JOURNAL_MAX_BYTES
    ) {
        fail("journal_byte_limit");
    }
    writeDurably(paths.journal, line, entries.length ? "a" : "wx", io);
    writeDurably(
        paths.witness,
        `${canonicalBenchmarkJson({ seq: entry.seq, entryDigest: entry.entryDigest })}\n`,
        "a",
        io
    );
    entries.push(entry);
}

function readReplay(
    paths: PromptRefinerShadowPaths,
    corpus: PromptRefinerShadowCorpus,
    sourceIdentity: ShadowSourceIdentity,
    io: PromptRefinerShadowIO
): PromptRefinerShadowReplay {
    if (!io.existsSync(paths.journal) || !io.existsSync(paths.witness)) {
        fail("registered_journal_missing");
    }
    return replayPromptRefinerShadowJournal({
        journalText: readBoundedText(
            paths.journal,
            PROMPT_REFINER_SHADOW_JOURNAL_MAX_BYTES,
            io
        ),
        witnessText: readBoundedText(
            paths.witness,
            PROMPT_REFINER_SHADOW_JOURNAL_MAX_BYTES,
            io
        ),
        corpus,
        sourceIdentity,
    });
}

function reportFrom(
    replay: PromptRefinerShadowReplay,
    corpus: PromptRefinerShadowCorpus,
    sourceIdentity: ShadowSourceIdentity
): PromptRefinerShadowRunReport {
    return {
        schemaVersion: PROMPT_REFINER_SHADOW_JOURNAL_VERSION,
        purpose: "development-only",
        dataClassification: "synthetic_test_only",
        harnessVersion: PROMPT_REFINER_SHADOW_HARNESS_VERSION,
        corpusDigest: corpus.contentDigest,
        corpusCases: PROMPT_REFINER_SHADOW_CORPUS_CASES,
        sourceRef: sourceIdentity.sourceRef,
        sourceIdentityDigest: sourceIdentity.identityDigest,
        status: replay.status,
        stopReason: replay.stopReason,
        resumable: replay.resumable,
        processedCases: replay.processedCases,
        structuralBoundaryPopulation: replay.structuralBoundaryPopulation,
        structuralBoundaryViolations: replay.structuralBoundaryViolations,
        behavioralOutcomePopulation: replay.behavioralOutcomePopulation,
        behavioralOutcomeMatches: replay.behavioralOutcomeMatches,
        remainingCases: replay.remainingCases,
        unknownCases: replay.unknownCases,
        providerCalls: 0,
        costMicroUsd: 0,
    };
}

export function runPromptRefinerShadowHarness(input: {
    corpus: PromptRefinerShadowCorpus;
    sourceIdentity: ShadowSourceIdentity;
    journalPath: string;
    resume: boolean;
    maxCases?: number;
    io?: PromptRefinerShadowIO;
}): PromptRefinerShadowRunReport {
    const corpus = validatePromptRefinerShadowCorpus(input.corpus);
    const sourceIdentity = validateSourceIdentity(input.sourceIdentity);
    const io = input.io ?? fs;
    const paths = promptRefinerShadowPaths(input.journalPath);
    const maxCases = input.maxCases ?? corpus.cases.length;
    if (
        !Number.isSafeInteger(maxCases) ||
        maxCases < 1 ||
        maxCases > corpus.cases.length
    ) {
        fail("max_cases");
    }
    io.mkdirSync(dirname(paths.journal), { recursive: true });
    let lockDescriptor: number;
    try {
        lockDescriptor = io.openSync(paths.lock, "wx", 0o600);
    } catch {
        return fail("lock_unavailable_no_stale_recovery");
    }
    try {
        const anyExisting =
            io.existsSync(paths.journal) || io.existsSync(paths.witness);
        if (input.resume) {
            if (!anyExisting) fail("resume_journal_missing");
        } else if (anyExisting) {
            fail("existing_journal_requires_resume");
        }

        let replay: PromptRefinerShadowReplay;
        if (!input.resume) {
            writeDurably(
                paths.witness,
                `${canonicalBenchmarkJson({
                    schemaVersion: PROMPT_REFINER_SHADOW_JOURNAL_VERSION,
                    harnessVersion: PROMPT_REFINER_SHADOW_HARNESS_VERSION,
                    corpusDigest: corpus.contentDigest,
                    sourceRef: sourceIdentity.sourceRef,
                    sourceIdentityDigest: sourceIdentity.identityDigest,
                })}\n`,
                "wx",
                io
            );
            const entries: ShadowEnvelope[] = [];
            appendEvent(
                {
                    kind: "header",
                    schemaVersion: PROMPT_REFINER_SHADOW_JOURNAL_VERSION,
                    harnessVersion: PROMPT_REFINER_SHADOW_HARNESS_VERSION,
                    corpusDigest: corpus.contentDigest,
                    corpusCases: PROMPT_REFINER_SHADOW_CORPUS_CASES,
                    sourceRef: sourceIdentity.sourceRef,
                    sourceIdentityDigest: sourceIdentity.identityDigest,
                    providerCalls: 0,
                    costMicroUsd: 0,
                },
                entries,
                paths,
                io
            );
            replay = readReplay(paths, corpus, sourceIdentity, io);
        } else {
            replay = readReplay(paths, corpus, sourceIdentity, io);
            if (!replay.resumable) fail("journal_not_resumable");
            appendEvent(
                {
                    kind: "run_resumed",
                    fromStatus: replay.status as "stopped" | "interrupted",
                    processedCases: replay.processedCases,
                    remainingCases: replay.remainingCases,
                },
                replay.entries,
                paths,
                io
            );
            replay = readReplay(paths, corpus, sourceIdentity, io);
        }

        let processedThisInvocation = 0;
        while (
            replay.processedCases < corpus.cases.length &&
            processedThisInvocation < maxCases
        ) {
            const item = corpus.cases[replay.processedCases];
            appendEvent(
                {
                    kind: "case_intent",
                    caseId: item.id,
                    providerCalls: 0,
                    costMicroUsd: 0,
                },
                replay.entries,
                paths,
                io
            );
            replay = readReplay(paths, corpus, sourceIdentity, io);
            const evaluation = evaluatePromptRefinerShadowCase(item);
            appendEvent(
                {
                    kind: "case_terminal",
                    caseId: item.id,
                    status: evaluation.status,
                    failureCode: evaluation.failureCode,
                    structuralBoundaryViolations:
                        evaluation.structuralBoundaryViolations,
                    behavioralOutcomeMatched:
                        evaluation.behavioralOutcomeMatched,
                    providerCalls: 0,
                    costMicroUsd: 0,
                },
                replay.entries,
                paths,
                io
            );
            processedThisInvocation += 1;
            replay = readReplay(paths, corpus, sourceIdentity, io);
            if (
                evaluation.structuralBoundaryViolations !== 0 ||
                !evaluation.behavioralOutcomeMatched
            ) {
                appendEvent(
                    {
                        kind: "run_stopped",
                        reason:
                            evaluation.structuralBoundaryViolations !== 0
                                ? "structural_boundary_violation"
                                : "behavioral_fixture_mismatch",
                        processedCases: replay.processedCases,
                        remainingCases: replay.remainingCases,
                    },
                    replay.entries,
                    paths,
                    io
                );
                return reportFrom(
                    readReplay(paths, corpus, sourceIdentity, io),
                    corpus,
                    sourceIdentity
                );
            }
        }

        if (replay.processedCases === corpus.cases.length) {
            appendEvent(
                {
                    kind: "run_completed",
                    processedCases: PROMPT_REFINER_SHADOW_CORPUS_CASES,
                    structuralBoundaryPopulation:
                        PROMPT_REFINER_SHADOW_CORPUS_CASES,
                    structuralBoundaryViolations: 0,
                    behavioralOutcomePopulation:
                        PROMPT_REFINER_SHADOW_CORPUS_CASES,
                    behavioralOutcomeMatches:
                        PROMPT_REFINER_SHADOW_CORPUS_CASES,
                    providerCalls: 0,
                    costMicroUsd: 0,
                },
                replay.entries,
                paths,
                io
            );
        } else {
            appendEvent(
                {
                    kind: "run_stopped",
                    reason: "case_limit",
                    processedCases: replay.processedCases,
                    remainingCases: replay.remainingCases,
                },
                replay.entries,
                paths,
                io
            );
        }
        return reportFrom(
            readReplay(paths, corpus, sourceIdentity, io),
            corpus,
            sourceIdentity
        );
    } finally {
        io.closeSync(lockDescriptor);
        io.unlinkSync(paths.lock);
    }
}
