/**
 * Code execution in Chat: which models get it, what it costs, and how a run is
 * shown in the answer.
 *
 * Contract: docs/policy/chat-attachment-formats.md section 2.3.1.
 *
 * No sandbox of our own. The model provider runs the code in its own hosted
 * environment, attached as an AI SDK provider tool; this process executes
 * nothing. Pure and framework-free, so the gate, the price register and the
 * stream formatting are tested without a provider.
 *
 * ## The cost rule is the web-search one
 *
 * A provider tool that bills on top of tokens carries a flat credit surcharge
 * the user is told about, plus a reservation of its worst case against the
 * provider budget (`lib/webSearchCredits.ts`,
 * `lib/webSearchNativeCostReservation.ts`). A tool whose cost is inside the
 * token usage the provider reports carries neither -- Perplexity's search is
 * the precedent (`hasAdditionalCost: false`).
 *
 * Read against the providers' own pricing pages on 2026-11-27:
 *
 * - Google Gemini: "There's no additional charge for enabling code execution";
 *   generated code and results are billed as output tokens and intermediate
 *   tokens as input tokens. So no surcharge and no separate reservation: the
 *   settlement already prices the usage the provider reports, and the AI SDK
 *   counts `toolUsePromptTokenCount` into input tokens.
 * - OpenAI code interpreter: US$0.03 per 20-minute session of a 1 GB container,
 *   billed by the minute with a 5-minute minimum.
 * - Anthropic code execution: US$0.05 per container-hour, 5-minute minimum,
 *   free when the request also carries web_search_20260209 or later (this
 *   product sends web_search_20250305).
 *
 * The last two bill on top of tokens, so by the same rule they need a credit
 * surcharge -- a number nobody has decided. They are refused with
 * `surcharge_unapproved` until it is; the price is recorded so that the
 * decision, not the research, is what is left.
 */

export const CHAT_CODE_EXECUTION_ENV = "CHAT_CODE_EXECUTION_ENABLED";

/** `"true"` and nothing else, as every default-off switch here reads. */
export const chatCodeExecutionSwitchOn = (
    env: Readonly<Record<string, string | undefined>>
) => env[CHAT_CODE_EXECUTION_ENV] === "true";

/** The tool's registered name. Google requires exactly this one. */
export const CODE_EXECUTION_TOOL_NAME = "code_execution";

/**
 * Runs one answer may show before it is stopped.
 *
 * What this bounds, precisely: Gemini takes no request parameter that caps its
 * runs, so the only enforceable stop is this process cutting the stream. A run
 * is seen when its `tool-call` part arrives, which is after the provider has
 * started it -- so the call past the ceiling is the one that aborts the
 * attempt, and that sixth run may already have executed. At most six runs, of
 * at most 30 seconds each (Gemini's own limit), per answer. It bounds how long
 * one answer can keep computing, not a bill: Gemini charges nothing per run,
 * and the tokens the runs add are bounded by the request's output cap and
 * priced at settlement from the provider's usage.
 */
export const CODE_EXECUTION_MAX_CALLS_PER_TURN = 5;

export type CodeExecutionPriceEntry = {
    provider: "google" | "openai" | "anthropic";
    /** Does the provider bill this tool on top of the tokens it reports? */
    additionalCharge: boolean;
    /** What it bills, as the provider states it; null when it bills nothing. */
    price: string | null;
    /** Credits a turn that runs code carries on top of its weight. Null = undecided. */
    surchargeCredits: number | null;
    priceSource: string;
    checkedAt: string;
};

export const CODE_EXECUTION_PRICE_REGISTER: readonly CodeExecutionPriceEntry[] = [
    {
        provider: "google",
        additionalCharge: false,
        price: null,
        surchargeCredits: 0,
        priceSource: "https://ai.google.dev/gemini-api/docs/code-execution",
        checkedAt: "2026-11-27",
    },
    {
        provider: "openai",
        additionalCharge: true,
        price: "US$0.03 per 20-minute session, 1 GB container; per minute, 5-minute minimum",
        surchargeCredits: null,
        priceSource: "https://developers.openai.com/api/docs/pricing",
        checkedAt: "2026-11-27",
    },
    {
        provider: "anthropic",
        additionalCharge: true,
        price: "US$0.05 per container-hour, 5-minute minimum",
        surchargeCredits: null,
        priceSource: "https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool",
        checkedAt: "2026-11-27",
    },
];

export type CodeExecutionRefusal =
    | "switch_off"
    | "guest"
    | "research_turn"
    /** The provider has no code execution tool this product can attach. */
    | "provider_unsupported"
    /** A provider this product knows, but not a model verified to take the tool. */
    | "model_unverified"
    /** The tool is billed on top of tokens and its credit surcharge is undecided. */
    | "surcharge_unapproved";

export type CodeExecutionDecision =
    | { enabled: true; provider: "google"; maxCalls: number }
    | { enabled: false; reason: CodeExecutionRefusal };

/**
 * Gemini models on the 3.x line or later, by their API name.
 *
 * Two facts from the installed `@ai-sdk/google` decide this rather than a
 * guess: the code execution tool needs a Gemini 2+ model, and a request that
 * mixes a provider tool with function tools (this product's own web search,
 * file and project tools) keeps the function tools only on a model with the
 * Gemini 3 tool combination -- on an older one they are silently dropped. An
 * alias such as `gemini-flash-lite-latest` is not matched: it can point at
 * any generation. Flash-Lite is left out too: Gemini 2.0 Flash-Lite did not
 * take the tool, and no later model page was read that says this one does --
 * a request carrying a tool the model refuses fails instead of answering.
 */
const GEMINI_WITH_MIXED_TOOLS = /^gemini-(\d+)\.\d+-(?:flash|pro)(?:-(?!lite(?:-|$))|$)/;

export const modelSupportsCodeExecution = (model: {
    provider: string;
    apiModel: string;
}): boolean => {
    if (model.provider !== "google") return false;
    const match = GEMINI_WITH_MIXED_TOOLS.exec(model.apiModel);
    return match !== null && Number(match[1]) >= 3;
};

/**
 * Whether this turn's answering model gets the tool.
 *
 * Asked about the model that answers, never used to choose one: Auto's
 * selection rules are unchanged, and a model without the tool simply answers
 * without it.
 */
export const resolveCodeExecution = (input: {
    env: Readonly<Record<string, string | undefined>>;
    model: { provider: string; apiModel: string };
    accessKind: string;
    researchTurn: boolean;
}): CodeExecutionDecision => {
    if (!chatCodeExecutionSwitchOn(input.env)) return { enabled: false, reason: "switch_off" };
    if (input.accessKind !== "user") return { enabled: false, reason: "guest" };
    if (input.researchTurn) return { enabled: false, reason: "research_turn" };
    const entry = CODE_EXECUTION_PRICE_REGISTER.find(
        (candidate) => candidate.provider === input.model.provider
    );
    if (!entry) return { enabled: false, reason: "provider_unsupported" };
    if (entry.additionalCharge && entry.surchargeCredits === null) {
        return { enabled: false, reason: "surcharge_unapproved" };
    }
    if (entry.provider !== "google" || !modelSupportsCodeExecution(input.model)) {
        return { enabled: false, reason: "model_unverified" };
    }
    return { enabled: true, provider: "google", maxCalls: CODE_EXECUTION_MAX_CALLS_PER_TURN };
};

// ---------------------------------------------------------------------------
// How a run reads in the answer
// ---------------------------------------------------------------------------

/**
 * The info-string words the web composer folds on (`MarkdownCodeBlock` in
 * `components/chat/ChatMessageList.tsx`). Everywhere else -- the mobile
 * app, an export, the next turn's history -- the block is an ordinary code
 * fence, which is what it should degrade to.
 */
export const CODE_EXECUTION_CODE_META = "tomverse-code-run";
export const CODE_EXECUTION_OUTPUT_META = "tomverse-code-output";

/** A fence longer than any backtick run inside, so the content cannot close it. */
const fenced = (info: string, body: string) => {
    const longestRun = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    return `${fence}${info}\n${body.replace(/\n+$/, "")}\n${fence}`;
};

const readString = (value: unknown, key: string) => {
    if (!value || typeof value !== "object") return null;
    const field = (value as Record<string, unknown>)[key];
    return typeof field === "string" ? field : null;
};

/**
 * One run as markdown: the code, then what it printed, each its own fence.
 *
 * The shapes are Gemini's as the installed `@ai-sdk/google` maps them: the call
 * input is `{ language, code }` and the result `{ outcome, output }`, where
 * `outcome` is `OUTCOME_OK`, `OUTCOME_FAILED` or `OUTCOME_DEADLINE_EXCEEDED`.
 */
export const codeExecutionMarkdown = (input: unknown, output: unknown): string | null => {
    const code = readString(input, "code");
    if (!code?.trim()) return null;
    const language = (readString(input, "language") ?? "python").toLowerCase();
    const languageTag = /^[a-z0-9_+-]{1,20}$/.test(language) ? language : "python";
    const printed = readString(output, "output") ?? "";
    const outcome = readString(output, "outcome");
    const status = outcome && outcome !== "OUTCOME_OK" ? `[${outcome}]\n` : "";
    return (
        `\n\n${fenced(`${languageTag} ${CODE_EXECUTION_CODE_META}`, code)}\n\n` +
        `${fenced(`text ${CODE_EXECUTION_OUTPUT_META}`, `${status}${printed}` || "(no output)")}\n\n`
    );
};

/**
 * Which fold a rendered `<pre>` belongs to, from the hast node react-markdown
 * hands the component: its `<code>` child carries the fence's info-string
 * words after the language as `data.meta`.
 */
export const codeExecutionFenceKind = (preNode: unknown): "code" | "output" | null => {
    const children = (preNode as { children?: unknown[] } | undefined)?.children;
    const code = Array.isArray(children) ? children[0] : undefined;
    const meta = (code as { data?: { meta?: unknown } } | undefined)?.data?.meta;
    if (typeof meta !== "string") return null;
    const words = meta.split(/\s+/);
    if (words.includes(CODE_EXECUTION_CODE_META)) return "code";
    if (words.includes(CODE_EXECUTION_OUTPUT_META)) return "output";
    return null;
};

const MARKERS = [CODE_EXECUTION_CODE_META, CODE_EXECUTION_OUTPUT_META];
const MARKER_CARRY = Math.max(...MARKERS.map((marker) => marker.length)) - 1;

/**
 * The model's own text, with the fold markers taken out of it -- repeatedly,
 * because removing one can join its neighbours into another.
 */
const stripMarkers = (text: string) => {
    let current = text;
    for (;;) {
        const next = MARKERS.reduce((value, marker) => value.split(marker).join(""), current);
        if (next === current) return current;
        current = next;
    }
};

/** How many trailing characters could still become a marker with more text. */
const markerPrefixLength = (text: string) => {
    for (let length = Math.min(MARKER_CARRY, text.length); length > 0; length -= 1) {
        const suffix = text.slice(text.length - length);
        if (MARKERS.some((marker) => marker.startsWith(suffix))) return length;
    }
    return 0;
};

type StreamPart = {
    type: string;
    text?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
    input?: unknown;
    output?: unknown;
    providerExecuted?: unknown;
};

/**
 * The answer as text, with each code run written into it where it happened.
 *
 * Stands in for `result.textStream` on a turn that carries the tool, and reads
 * the same way it does: text deltas become text and every other part is
 * ignored -- except a provider-executed `code_execution` call, which is
 * counted, and its result, which becomes the markdown above.
 *
 * "Every other part" includes `error`. That is what the installed ai@7's own
 * `textStream` does (`toTextStream` enqueues `text-delta` and nothing else),
 * and it is why the route observes provider errors through `streamText`'s
 * `onError` (`observeStreamError`) rather than through the stream it reads.
 * Raising them here instead would give a code-execution turn a failure path
 * every other turn lacks, and report the same error twice.
 *
 * The model's own text never carries the fold markers: a model that wrote one
 * would have its prose shown as "code that was run". They are removed here,
 * holding back the last few characters of each delta in case a marker is split
 * across two.
 *
 * The call count is the per-turn ceiling. The call past it ends this stream
 * and `onCeiling` aborts the provider request.
 */
export const createCodeExecutionTextStream = (
    fullStream: ReadableStream<StreamPart> | AsyncIterable<StreamPart>,
    options: { maxCalls: number; onCeiling: () => void }
): ReadableStream<string> => {
    const inputs = new Map<string, unknown>();
    let calls = 0;
    let carry = "";
    const iterator = (fullStream as AsyncIterable<StreamPart>)[Symbol.asyncIterator]();
    const takeText = (text: string) => {
        const combined = stripMarkers(carry + text);
        const cut = combined.length - markerPrefixLength(combined);
        carry = combined.slice(cut);
        return combined.slice(0, cut);
    };
    const flushText = () => {
        const rest = stripMarkers(carry);
        carry = "";
        return rest;
    };
    return new ReadableStream<string>({
        async pull(controller) {
            for (;;) {
                const next = await iterator.next();
                if (next.done) {
                    const rest = flushText();
                    if (rest) controller.enqueue(rest);
                    controller.close();
                    return;
                }
                const part = next.value;
                if (part.type === "text-delta" && typeof part.text === "string") {
                    const text = takeText(part.text);
                    if (text) {
                        controller.enqueue(text);
                        return;
                    }
                    continue;
                }
                const isRun =
                    part.toolName === CODE_EXECUTION_TOOL_NAME && part.providerExecuted === true;
                if (part.type === "tool-call" && isRun) {
                    calls += 1;
                    if (calls > options.maxCalls) {
                        const rest = flushText();
                        if (rest) controller.enqueue(rest);
                        controller.close();
                        options.onCeiling();
                        await iterator.return?.();
                        return;
                    }
                    if (typeof part.toolCallId === "string") inputs.set(part.toolCallId, part.input);
                    continue;
                }
                if (part.type === "tool-result" && part.toolName === CODE_EXECUTION_TOOL_NAME) {
                    const id = typeof part.toolCallId === "string" ? part.toolCallId : "";
                    const block = codeExecutionMarkdown(inputs.get(id) ?? part.input, part.output);
                    // Whatever the model already wrote goes out first, so the
                    // run appears where it happened in the answer.
                    const before = flushText();
                    const emitted = `${before}${block ?? ""}`;
                    if (emitted) {
                        controller.enqueue(emitted);
                        return;
                    }
                }
            }
        },
        async cancel(reason) {
            await iterator.return?.(reason);
        },
    });
};
