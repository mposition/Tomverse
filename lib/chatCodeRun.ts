/**
 * Running a Python code block from an answer, in the user's own browser.
 *
 * Policy: docs/policy/generated-artifacts.md section 9 (the isolation) and
 * docs/policy/chat-attachment-formats.md section 2.4 (why this is not a
 * provider tool and so not a credit question).
 *
 * This file is the part both sides share and that holds no isolation of its
 * own: the default-off switch, the sentence the model is told, the limits, and
 * the messages the page and its runner frame exchange, with the one function
 * that decides whether a message from the frame is believed. The frame itself
 * (sandbox, policy, worker) is `lib/chatCodeRunFrame.ts`.
 *
 * Pure and client-safe: strings and numbers only.
 */

// The switch, the pages that may run code and the runtime directory's request rule live in
// lib/csp.ts, which the page policy and proxy.ts already import: a new import from those files
// would add a file to the Prompt Refiner's pinned runtime source closure.
export { chatCodeRunEnabled, chatCodeRunPagePath, codeRunVendorRequestRefused } from "./csp";

/**
 * What the model is told when the switch is on. Our own text, so it is a system
 * block, and it is priced with the others (lib/chatTurnSystemBlocks.ts).
 *
 * The last sentence is the one that matters: the run happens in the person's
 * browser and its output never comes back, so a model that says what the code
 * printed is inventing it.
 */
export const CHAT_CODE_RUN_PROMPT =
    "The user can run a Python code block from your answer in their own browser: a Run button appears under a finished fenced block " +
    "tagged python. It runs in a sandbox with numpy, pandas and matplotlib available (matplotlib figures are shown as images, " +
    "plt.show() is not needed). Nothing else can be installed, there is no network access, and the run stops after 30 seconds. " +
    "The user can add CSV, TSV, JSON or text files from their device to a run; the code reads them from the current directory by file name. " +
    "The output is shown only to the user. You do not see it unless the user pastes it back, so never state, summarise or invent what a run printed or drew. " +
    "Write self-contained scripts that print what they compute, and tell the user to press Run instead of claiming you ran the code.";

/** Fence tags that mean Python. */
const PYTHON_LANGUAGES: ReadonlySet<string> = new Set(["python", "py", "python3", "py3"]);

export const isPythonCodeLanguage = (language: string | null | undefined): boolean =>
    Boolean(language && PYTHON_LANGUAGES.has(language.trim().toLowerCase()));

/**
 * Every bound on a run. The frame enforces the time and output ones itself (it
 * ends the worker); the page enforces all of them again on what it receives,
 * because the frame is the thing it does not trust.
 */
export const CODE_RUN_LIMITS = {
    /** The code that may be sent to a run: the same size a previewed page may be. */
    maxCodeBytes: 1_000_000,
    /** The code's own running time. It starts once the runtime and packages are in, so a slow first download does not eat it. */
    runTimeoutMs: 30_000,
    /** Fetching and starting the runtime and its packages. A stall past this ends the run. */
    loadTimeoutMs: 120_000,
    /** Standard output and error together. Past it the run is ended. */
    maxOutputChars: 100_000,
    /** One output message. */
    maxChunkChars: 20_000,
    /** The text of the last expression's value, and of an error. */
    maxValueChars: 20_000,
    maxImages: 6,
    /** One figure as base64 text of its PNG (about 2 MB of image). */
    maxImageBase64Chars: 2_800_000,
    /** Pixels in one saved figure; a larger one is skipped rather than rendered. */
    maxFigurePixels: 16_000_000,
    maxFiles: 5,
    maxFileBytes: 10 * 1024 * 1024,
    maxTotalFileBytes: 20 * 1024 * 1024,
    maxFileNameChars: 100,
    /** What "put the result in the message box" writes. */
    composerOutputChars: 3_000,
} as const;

export const CODE_RUN_NAMESPACE = "tomverse-code-run";
export const CODE_RUN_VERSION = 1;

export type CodeRunPhase = "runtime" | "packages" | "running";
export type CodeRunStatus = "ok" | "error" | "timeout" | "output_limit" | "crashed";
export type CodeRunStream = "stdout" | "stderr";

/** The only message the page sends the frame. Files are bytes read in the browser; they never go anywhere else. */
export type CodeRunRequest = {
    ns: typeof CODE_RUN_NAMESPACE;
    v: typeof CODE_RUN_VERSION;
    token: string;
    type: "run";
    runId: string;
    code: string;
    files: { name: string; data: ArrayBuffer }[];
};

/** The messages the frame sends the page. */
export type CodeRunFrameMessage =
    | { type: "ready" }
    | { type: "phase"; runId: string; phase: CodeRunPhase }
    | { type: "output"; runId: string; stream: CodeRunStream; text: string }
    | { type: "image"; runId: string; dataUrl: string }
    | {
          type: "done";
          runId: string;
          status: CodeRunStatus;
          /** `repr` of the last expression, when the code ended in one. */
          value: string | null;
          /** A Python traceback, when the code raised. */
          error: string | null;
          skippedFigures: number;
          durationMs: number;
      };

export const buildCodeRunRequest = (input: { token: string; runId: string; code: string; files: { name: string; data: ArrayBuffer }[] }): CodeRunRequest => ({
    ns: CODE_RUN_NAMESPACE,
    v: CODE_RUN_VERSION,
    type: "run",
    ...input,
});

const PHASES: ReadonlySet<string> = new Set(["runtime", "packages", "running"]);
const STATUSES: ReadonlySet<string> = new Set(["ok", "error", "timeout", "output_limit", "crashed"]);
const STREAMS: ReadonlySet<string> = new Set(["stdout", "stderr"]);
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A PNG as the frame sends it. Nothing else is shown as an image: not SVG, not a URL. */
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

/**
 * The page's side of the trust boundary: a message that came from the frame's
 * window, checked for shape and size. `null` for anything else -- a wrong
 * namespace, version or token (a stale frame, a stray window), an unknown type,
 * a field of the wrong kind, text over its limit, an image that is not a PNG
 * data URL. The caller has already compared `event.source` to its own frame.
 *
 * Nothing here is rendered as HTML by the caller: text stays text, an image
 * goes into an `<img>` only after the pattern above.
 */
export function parseCodeRunFrameMessage(data: unknown, expected: { token: string }): CodeRunFrameMessage | null {
    if (!isRecord(data)) return null;
    if (data.ns !== CODE_RUN_NAMESPACE || data.v !== CODE_RUN_VERSION || data.token !== expected.token) return null;
    const limits = CODE_RUN_LIMITS;
    switch (data.type) {
        case "ready":
            return { type: "ready" };
        case "phase":
            return typeof data.runId === "string" && RUN_ID.test(data.runId) && typeof data.phase === "string" && PHASES.has(data.phase)
                ? { type: "phase", runId: data.runId, phase: data.phase as CodeRunPhase }
                : null;
        case "output":
            return typeof data.runId === "string" && RUN_ID.test(data.runId) && typeof data.stream === "string" && STREAMS.has(data.stream) &&
                text(data.text, limits.maxChunkChars)
                ? { type: "output", runId: data.runId, stream: data.stream as CodeRunStream, text: data.text }
                : null;
        case "image":
            return typeof data.runId === "string" && RUN_ID.test(data.runId) && typeof data.dataUrl === "string" &&
                data.dataUrl.length <= limits.maxImageBase64Chars + 32 && PNG_DATA_URL.test(data.dataUrl)
                ? { type: "image", runId: data.runId, dataUrl: data.dataUrl }
                : null;
        case "done": {
            if (typeof data.runId !== "string" || !RUN_ID.test(data.runId)) return null;
            if (typeof data.status !== "string" || !STATUSES.has(data.status)) return null;
            const value = data.value === null || data.value === undefined ? null : text(data.value, limits.maxValueChars) ? data.value : undefined;
            const error = data.error === null || data.error === undefined ? null : text(data.error, limits.maxValueChars) ? data.error : undefined;
            if (value === undefined || error === undefined) return null;
            const skipped = data.skippedFigures;
            const duration = data.durationMs;
            if (typeof skipped !== "number" || !Number.isInteger(skipped) || skipped < 0 || skipped > 1_000) return null;
            if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 || duration > 86_400_000) return null;
            return { type: "done", runId: data.runId, status: data.status as CodeRunStatus, value, error, skippedFigures: skipped, durationMs: duration };
        }
        default:
            return null;
    }
}

/** The page's whole picture of one run, built only from messages that passed the check above. */
export type CodeRunState = {
    /** `idle` before the first press; `loading` until the code starts; `running`; `done` when the frame said so. */
    status: "idle" | "loading" | "running" | "done";
    runId: string | null;
    phase: CodeRunPhase | null;
    /** Adjacent writes to the same stream are one segment, so the order of output and errors is kept. */
    segments: { stream: CodeRunStream; text: string }[];
    outputChars: number;
    images: string[];
    value: string | null;
    error: string | null;
    outcome: CodeRunStatus | "stopped" | null;
    skippedFigures: number;
    durationMs: number | null;
};

export const IDLE_CODE_RUN: CodeRunState = {
    status: "idle",
    runId: null,
    phase: null,
    segments: [],
    outputChars: 0,
    images: [],
    value: null,
    error: null,
    outcome: null,
    skippedFigures: 0,
    durationMs: null,
};

export const startCodeRun = (runId: string): CodeRunState => ({ ...IDLE_CODE_RUN, status: "loading", runId, phase: "runtime" });

/** A run the page ended itself: `stopped` is the Stop button, `timeout` a frame that went silent. */
export const stopCodeRun = (state: CodeRunState, outcome: "stopped" | "timeout" = "stopped"): CodeRunState =>
    state.status === "loading" || state.status === "running" ? { ...state, status: "done", outcome } : state;

export function reduceCodeRun(state: CodeRunState, message: CodeRunFrameMessage): CodeRunState {
    if (message.type === "ready") return state;
    if (state.status === "idle" || state.status === "done" || message.runId !== state.runId) return state;
    const limits = CODE_RUN_LIMITS;
    switch (message.type) {
        case "phase":
            return { ...state, status: message.phase === "running" ? "running" : "loading", phase: message.phase };
        case "output": {
            const room = limits.maxOutputChars - state.outputChars;
            if (room <= 0) return state;
            const chunk = message.text.length > room ? message.text.slice(0, room) : message.text;
            const last = state.segments[state.segments.length - 1];
            const segments =
                last && last.stream === message.stream
                    ? [...state.segments.slice(0, -1), { stream: last.stream, text: last.text + chunk }]
                    : [...state.segments, { stream: message.stream, text: chunk }];
            return { ...state, segments, outputChars: state.outputChars + chunk.length };
        }
        case "image":
            return state.images.length >= limits.maxImages ? { ...state, skippedFigures: state.skippedFigures + 1 } : { ...state, images: [...state.images, message.dataUrl] };
        case "done":
            return {
                ...state,
                status: "done",
                outcome: message.status,
                value: message.value,
                error: message.error,
                skippedFigures: state.skippedFigures + message.skippedFigures,
                durationMs: message.durationMs,
            };
    }
}

/** Standard output, the last expression and the traceback as one text, the way it reads in a console. */
export function codeRunPlainText(state: CodeRunState): string {
    const parts = state.segments.map((segment) => segment.text).filter(Boolean);
    const joined = parts.reduce((all, part) => (all && !all.endsWith("\n") ? `${all}\n${part}` : `${all}${part}`), "");
    return [joined, state.value ?? "", state.error ?? ""].filter((part) => part.trim()).join("\n");
}

/**
 * The text "use the result in the message" puts in the composer: a request,
 * then the output in a fenced block, cut to a length a message can carry. The
 * fence is longer than any run of backticks in the output, so the output cannot
 * close it early.
 */
export function buildCodeRunComposerText(request: string, output: string): string {
    const limit = CODE_RUN_LIMITS.composerOutputChars;
    const body = output.length > limit ? `${output.slice(0, limit)}\n...` : output;
    const longest = (body.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `${request}\n\n${fence}text\n${body.replace(/\s+$/, "")}\n${fence}`;
}

/** A name safe to write into the runner's file system: no folders, no oddities, bounded. */
export function sanitizeCodeRunFileName(name: string): string {
    const base = name.split(/[\\/]/).pop() ?? "";
    const clean = base.replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/, "").trim().slice(0, CODE_RUN_LIMITS.maxFileNameChars);
    return clean || "file";
}

/** Whether another file may be added, given what is already chosen. The reason is a key for the caller to translate. */
export function checkCodeRunFileAdd(existing: readonly { size: number }[], added: { size: number }): "count" | "size" | "total" | null {
    const limits = CODE_RUN_LIMITS;
    if (existing.length >= limits.maxFiles) return "count";
    if (added.size > limits.maxFileBytes) return "size";
    if (existing.reduce((sum, file) => sum + file.size, 0) + added.size > limits.maxTotalFileBytes) return "total";
    return null;
}
