import {
    emptyWarnings,
    isRecord,
    type ExternalConversationAdapter,
    type ParsedExternalConversation,
    type ParsedExternalMessage,
} from "@/lib/externalImportAdapters/types";

/**
 * Perplexity thread export adapter (Markdown).
 *
 * Perplexity has no account-wide conversation export. Each thread has its own
 * "Export -> Markdown", which writes one `.md` file:
 *
 *   <img src="https://r2cdn.perplexity.ai/pplx-full-logo-...png" .../>
 *
 *   # the user's question
 *
 *   the answer, Markdown, citing sources as [^1_1][^1_2]
 *   <span style="display:none">[^1_3][^1_4]</span>
 *
 *   <div align="center">⁂</div>
 *
 *   [^1_1]: https://example.com/a
 *
 *   ---
 *
 *   # the next question
 *   ...
 *
 * Share links (perplexity.ai/search/...) are not fetched: every perplexity.ai
 * path answers a server-side request with a Cloudflare bot challenge, so the
 * export file is the route, and it keeps the same "the original never leaves
 * the device" rule as every other provider (§5.1).
 *
 * A turn starts at a level-one heading that opens the file or follows a `---`
 * rule, outside a code fence. An answer may also hold a `---` and a `#`
 * heading of its own, so a candidate turn is checked against the export's
 * footnote numbering: Perplexity numbers sources per turn (`[^3_1]` is the
 * third turn's first) and defines them at the end of that answer. A
 * candidate that defines only the previous turn's sources, when that turn
 * defined none yet, is the rest of the previous answer.
 *
 * Two calls are left that the file cannot make: a heading after an uncited
 * answer (new question, or the answer's own?) and a multi-line question,
 * whose later lines export as plain paragraphs under the heading with nothing
 * marking where the answer begins. Those are semantic calls, so the worker
 * asks the import route, which asks a model (see "split hints" below). Without
 * hints -- switch off, call failed -- the heading line is the question and
 * every rule-and-heading is a turn, and the preview says the split may be off.
 *
 * Citations are kept. The footnote marks become `[n]` and the definitions a
 * "Sources" list at the end of the answer, because a footnote definition
 * whose mark is hidden (the display:none span) would be dropped by a
 * Markdown renderer -- and with it the source.
 *
 * Pure and isomorphic, like every adapter.
 */

/**
 * The shape the worker hands over for a Markdown file. `splitHints`, when
 * present, are the import route's answers to `perplexitySplitQuestions(text)`;
 * hints that do not fit those questions are ignored.
 */
export type PerplexityMarkdownEntry = {
    perplexityMarkdown: string;
    splitHints?: PerplexitySplitHints;
};

export const perplexityMarkdownEntry = (
    text: string,
    splitHints?: PerplexitySplitHints
): PerplexityMarkdownEntry =>
    splitHints ? { perplexityMarkdown: text, splitHints } : { perplexityMarkdown: text };

/** How much of the first question stands in for a title the export never had. */
const TITLE_CODE_POINTS = 80;

const LOGO = /^<img\s[^>]*perplexity\.ai[^>]*\/?>$/i;
const DIVIDER = /^<div\b[^>]*>\s*⁂\s*<\/div>$/;
const HIDDEN_CITATIONS = /^<span\b[^>]*display:\s*none[^>]*>(?:\s*,?\s*\[\^\d+_\d+\])*\s*<\/span>$/;
const FOOTNOTE_DEFINITION = /^\[\^\d+_(\d+)\]:\s*(.+)$/;
const FOOTNOTE_MARK = /\[\^\d+_(\d+)\]/g;
const FOOTNOTE_DEFINITION_TURN = /^\[\^(\d+)_\d+\]:\s/;

/**
 * A per-line "is this code?" check for one pass over the text, following
 * CommonMark fences: a run of three or more backticks or tildes opens one,
 * and only a run of the same character, at least as long, alone on its line,
 * closes it. A four-backtick block that shows a three-backtick one stays
 * code throughout. Fence lines themselves count as code.
 */
function codeLines(): (line: string) => boolean {
    let open: string | null = null;
    return (line) => {
        if (open === null) {
            const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
            if (!match) return false;
            // A backtick fence's info string cannot itself hold a backtick.
            if (match[1][0] === "`" && line.slice(match[0].length).includes("`")) return false;
            open = match[1];
            return true;
        }
        const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
        if (close && close[1][0] === open[0] && close[1].length >= open.length) open = null;
        return true;
    };
}
/** A level-one heading with text: an empty `# ` cannot be a question. */
const HEADING = /^# (?!#)(.*\S.*)$/;

const markdownOf = (value: unknown): string | null =>
    isRecord(value) && typeof value.perplexityMarkdown === "string"
        ? value.perplexityMarkdown
        : null;

/**
 * The export's logo line, or -- for a copy with the logo removed -- its
 * turn-scoped footnotes (`[^1_1]:`) together with the `⁂` source divider. A
 * notes file that merely uses footnotes has neither pair.
 */
const looksLikePerplexityExport = (text: string): boolean =>
    /r2cdn\.perplexity\.ai\/pplx-/.test(text) ||
    (/^\[\^1_1\]:\s/m.test(text) && /^<div\b[^>]*>\s*⁂\s*<\/div>\s*$/m.test(text) && /^# (?!#)/m.test(text));

const truncateTitle = (question: string): string => {
    const collapsed = question.replace(/\s+/g, " ").trim();
    const points = Array.from(collapsed);
    if (points.length === 0) return "Untitled conversation";
    return points.length <= TITLE_CODE_POINTS
        ? collapsed
        : `${points.slice(0, TITLE_CODE_POINTS).join("")}…`;
};

/**
 * A stable lineage id from the opening turn. The export carries no thread id;
 * a re-export of the same thread with more turns opens with the same question
 * and answer, so it lands in the same lineage as a new snapshot (§4.2), while
 * two threads that merely asked the same first question do not. Hashed so the
 * conversation text itself is not used as an identifier.
 */
const lineageId = (question: string, answer: string): string => {
    const text = `${question}\n${answer}`.replace(/\s+/g, " ").trim();
    let a = 0x811c9dc5;
    let b = 0x01000193 ^ text.length;
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        a = Math.imul(a ^ code, 0x01000193) >>> 0;
        b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
    }
    return `perplexity-md-${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
};

type Turn = { question: string; heading: string; body: string[] };

/** Every heading that could open a turn, before the numbering check. */
function candidateTurns(lines: readonly string[]): Turn[] {
    const turns: Turn[] = [];
    let current: Turn | null = null;
    const isCode = codeLines();
    let lastNonBlank = "";
    for (const line of lines) {
        const heading = isCode(line) ? null : HEADING.exec(line);
        if (heading && (current === null || lastNonBlank.trim() === "---")) {
            current = { question: heading[1], heading: line, body: [] };
            turns.push(current);
        } else if (current) {
            current.body.push(line);
        }
        if (line.trim()) lastNonBlank = line;
    }
    return turns;
}

/**
 * The turn numbers of the footnote definitions (`[^3_1]: url`) a candidate
 * holds, outside code. Only definitions count: they sit at the end of the
 * answer that cites them, while a mark can appear anywhere -- a follow-up
 * question quoting the previous answer carries its marks.
 */
function definedTurns(turn: Turn): number[] {
    const numbers: number[] = [];
    const isCode = codeLines();
    for (const line of turn.body) {
        const match = isCode(line) ? null : FOOTNOTE_DEFINITION_TURN.exec(line.trim());
        if (match) numbers.push(Number(match[1]));
    }
    return numbers;
}

/** Drops the `---` that separated a turn from the next one. */
function dropSeparator(body: string[]): void {
    while (body.length > 0 && !body[body.length - 1].trim()) body.pop();
    if (body.length > 0 && body[body.length - 1].trim() === "---") body.pop();
}

type NumberedTurn = Turn & { number: number; defines: boolean };

/**
 * Turns as far as the file alone can tell them apart, separators still in
 * place (the split hints below need them as written).
 */
function deterministicTurns(text: string): NumberedTurn[] {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const turns: NumberedTurn[] = [];
    for (const candidate of candidateTurns(lines)) {
        const previous = turns[turns.length - 1];
        const defined = definedTurns(candidate);
        let owner = -1;
        if (defined.length > 0 && defined.every((number) => number === defined[0])) {
            // Searched from the end; the mobile build's lib has no findLastIndex.
            for (let index = turns.length - 1; index >= 0 && owner < 0; index -= 1) {
                if (turns[index].number === defined[0]) owner = index;
            }
        }
        if (owner >= 0 && turns.slice(owner).every((turn) => !turn.defines)) {
            // The sources defined here belong to an earlier turn that has
            // defined none yet, and nothing since has: everything from that
            // turn on is one answer, split at rules and headings of its own.
            const merged = turns[owner];
            for (const fragment of [...turns.slice(owner + 1), candidate]) {
                merged.body.push(fragment.heading, ...fragment.body);
            }
            turns.length = owner + 1;
            merged.defines = true;
            continue;
        }
        turns.push({
            ...candidate,
            number: defined[0] ?? (previous?.number ?? 0) + 1,
            defines: defined.length > 0,
        });
    }
    return turns;
}

/* ---------------------------------------------------------- split hints - */

/**
 * The two calls the file cannot make, put to a model by the import route
 * (app/api/imports/external/perplexity-split). Only these excerpts leave the
 * device, and only an index or a yes/no comes back: the stored text is always
 * the export's own, cut where the hints say.
 *
 * - `turns[i].paragraphs`: the first paragraphs under turn i's heading. How
 *   many of them are the rest of a multi-line question (0 = none)?
 * - `boundaries`: a heading after an answer that defined no sources. Is it a
 *   new question, or the answer's own heading?
 */
export type PerplexitySplitQuestions = {
    turns: Array<{ question: string; paragraphs: string[] }>;
    boundaries: Array<{ turn: number; before: string; heading: string; after: string }>;
};

export type PerplexitySplitHints = {
    questionParagraphs: number[];
    continuesAnswer: boolean[];
};

/** Bounds on what is sent, per excerpt and in count. */
export const PERPLEXITY_SPLIT_LIMITS = {
    maxTurns: 200,
    maxParagraphsPerTurn: 3,
    excerptChars: 600,
    /**
     * The questions as sent, in UTF-8 bytes. Past this nothing is asked: the
     * request would outgrow a short model context, and the file split stands.
     */
    maxRequestBytes: 256 * 1024,
} as const;

/** Cut to the limit in UTF-16 units (what the route checks), never mid-pair. */
const excerpt = (text: string, from: "start" | "end" = "start"): string => {
    const limit = PERPLEXITY_SPLIT_LIMITS.excerptChars;
    if (text.length <= limit) return text;
    const cut = from === "start" ? text.slice(0, limit) : text.slice(text.length - limit);
    return from === "start" ? cut.replace(/[\uD800-\uDBFF]$/, "") : cut.replace(/^[\uDC00-\uDFFF]/, "");
};

/** Structural lines that end the run of leading prose. */
const isStructural = (trimmed: string): boolean =>
    LOGO.test(trimmed) ||
    DIVIDER.test(trimmed) ||
    HIDDEN_CITATIONS.test(trimmed) ||
    FOOTNOTE_DEFINITION.test(trimmed) ||
    trimmed === "---";

/**
 * The first prose paragraphs of a body, as line ranges. A paragraph is a run
 * of non-blank lines; code, a rule or a footnote definition ends the search,
 * because a question continues in prose.
 */
function leadingParagraphs(body: readonly string[]): Array<{ start: number; end: number }> {
    const found: Array<{ start: number; end: number }> = [];
    const isCode = codeLines();
    let start = -1;
    for (let index = 0; index <= body.length; index += 1) {
        const line = index < body.length ? body[index] : "";
        const code = index < body.length && isCode(line);
        const trimmed = line.trim();
        if (trimmed && !code && !isStructural(trimmed)) {
            if (start < 0) start = index;
            continue;
        }
        if (start >= 0) {
            found.push({ start, end: index });
            start = -1;
            if (found.length === PERPLEXITY_SPLIT_LIMITS.maxParagraphsPerTurn) break;
        }
        if (code || (trimmed && isStructural(trimmed))) break;
    }
    return found;
}

const paragraphText = (body: readonly string[], range: { start: number; end: number }) =>
    body.slice(range.start, range.end).join("\n");

/** Indices of the turns whose heading might be the previous answer's own. */
const ambiguousBoundaries = (turns: readonly NumberedTurn[]): number[] =>
    turns.flatMap((_, index) => (index > 0 && !turns[index - 1].defines ? [index] : []));

/**
 * What to ask about a Perplexity export, or null when there is nothing the
 * file leaves open, or more than the route accepts (the file split is used).
 */
export function perplexitySplitQuestions(text: string): PerplexitySplitQuestions | null {
    const turns = deterministicTurns(text);
    if (turns.length === 0 || turns.length > PERPLEXITY_SPLIT_LIMITS.maxTurns) return null;
    const questions: PerplexitySplitQuestions = {
        turns: turns.map((turn) => ({
            question: excerpt(turn.question),
            paragraphs: leadingParagraphs(turn.body).map((range) =>
                excerpt(paragraphText(turn.body, range))
            ),
        })),
        boundaries: ambiguousBoundaries(turns).map((index) => {
            const previous = [...turns[index - 1].body];
            dropSeparator(previous);
            return {
                turn: index,
                before: excerpt(previous.join("\n").trim(), "end"),
                heading: excerpt(turns[index].question),
                after: excerpt(turns[index].body.join("\n").trim()),
            };
        }),
    };
    const open =
        questions.turns.some((turn) => turn.paragraphs.length > 0) ||
        questions.boundaries.length > 0;
    if (!open) return null;
    const bytes = new TextEncoder().encode(JSON.stringify(questions)).length;
    return bytes <= PERPLEXITY_SPLIT_LIMITS.maxRequestBytes ? questions : null;
}

/**
 * True when hints answer exactly these questions: one in-range count per
 * turn and one yes/no per boundary. The one check on model output before it
 * decides anything about stored text.
 */
export function perplexitySplitHintsFit(
    questions: PerplexitySplitQuestions,
    hints: unknown
): hints is PerplexitySplitHints {
    if (!isRecord(hints)) return false;
    const { questionParagraphs, continuesAnswer } = hints;
    return (
        Array.isArray(questionParagraphs) &&
        Array.isArray(continuesAnswer) &&
        questionParagraphs.length === questions.turns.length &&
        continuesAnswer.length === questions.boundaries.length &&
        questionParagraphs.every(
            (count, index) =>
                Number.isInteger(count) &&
                count >= 0 &&
                count <= questions.turns[index].paragraphs.length
        ) &&
        continuesAnswer.every((value) => typeof value === "boolean")
    );
}

type SplitTurn = Turn & { extraQuestion: string[] };

function splitTurns(text: string, hints: PerplexitySplitHints | null): SplitTurn[] {
    const turns = deterministicTurns(text);
    const continues = new Set<number>();
    if (hints) {
        ambiguousBoundaries(turns).forEach((index, position) => {
            if (hints.continuesAnswer[position]) continues.add(index);
        });
    }
    const result: SplitTurn[] = [];
    turns.forEach((turn, index) => {
        const previous = result[result.length - 1];
        if (previous && continues.has(index)) {
            // The answer's own rule and heading: back into that answer.
            previous.body.push(turn.heading, ...turn.body);
            return;
        }
        const count = hints?.questionParagraphs[index] ?? 0;
        const ranges = leadingParagraphs(turn.body).slice(0, count);
        const extraQuestion = ranges.map((range) => paragraphText(turn.body, range));
        const body = ranges.length > 0 ? turn.body.slice(ranges[ranges.length - 1].end) : [...turn.body];
        result.push({ question: turn.question, heading: turn.heading, body, extraQuestion });
    });
    for (const turn of result.slice(0, -1)) dropSeparator(turn.body);
    return result;
}

const hintsOf = (entry: unknown): PerplexitySplitHints | null => {
    const text = markdownOf(entry);
    if (text === null || !isRecord(entry) || entry.splitHints === undefined) return null;
    const questions = perplexitySplitQuestions(text);
    return questions && perplexitySplitHintsFit(questions, entry.splitHints)
        ? entry.splitHints
        : null;
};

const cleanQuestion = (raw: string): string =>
    raw.replace(/<q>([\s\S]*?)<\/q>/g, "“$1”").trim();

function cleanAnswer(body: readonly string[]): string {
    const sources = new Map<number, string>();
    const kept: string[] = [];
    const isCode = codeLines();
    for (const line of body) {
        const trimmed = line.trim();
        if (!isCode(line)) {
            if (LOGO.test(trimmed) || DIVIDER.test(trimmed) || HIDDEN_CITATIONS.test(trimmed)) {
                continue;
            }
            const definition = FOOTNOTE_DEFINITION.exec(trimmed);
            if (definition) {
                sources.set(Number(definition[1]), definition[2].trim());
                continue;
            }
            // Blank runs left by the removed lines collapse to one -- outside
            // code only, where whitespace is the content.
            if (!trimmed && kept.length > 0 && !kept[kept.length - 1].trim()) continue;
            kept.push(line.replace(FOOTNOTE_MARK, "[$1]"));
            continue;
        }
        kept.push(line);
    }
    let answer = kept
        .join("\n")
        .trim()
        // A closing rule of the answer's own, left once the separator is gone.
        .replace(/(?:\n+---)+$/, "")
        .trim();
    if (sources.size > 0) {
        const list = [...sources.entries()]
            .sort(([a], [b]) => a - b)
            .map(([n, source]) => `[${n}] ${source}`)
            .join("\n");
        answer = answer ? `${answer}\n\nSources:\n${list}` : `Sources:\n${list}`;
    }
    return answer;
}

export const perplexityAdapter: ExternalConversationAdapter = {
    provider: "perplexity",

    detect(value: unknown): boolean {
        if (!Array.isArray(value) || value.length === 0) return false;
        const text = markdownOf(value[0]);
        return text !== null && looksLikePerplexityExport(text);
    },

    parseConversation(entry: unknown): ParsedExternalConversation | null {
        const text = markdownOf(entry);
        if (text === null) return null;
        const turns = splitTurns(text, hintsOf(entry));
        if (turns.length === 0) return null;

        // Lineage comes from the file split, so a re-export lands in the same
        // lineage whether or not hints were available for either one.
        const fileFirst = splitTurns(text, null)[0];
        const rawId = lineageId(cleanQuestion(fileFirst.question), cleanAnswer(fileFirst.body));
        const questionOf = (turn: SplitTurn) =>
            cleanQuestion([turn.question, ...turn.extraQuestion].join("\n\n"));
        const firstQuestion = questionOf(turns[0]);
        const warnings = emptyWarnings();
        const messages: ParsedExternalMessage[] = [];
        const push = (role: "user" | "assistant", content: string) => {
            if (!content) {
                warnings.skippedEmptyMessages += 1;
                return;
            }
            messages.push({
                rawExternalMessageId: `${rawId}-ordinal-${messages.length}`,
                role,
                ordinal: messages.length,
                content,
                // The Markdown export names neither the model nor the time.
                sourceModelLabel: null,
                sourceTimestamp: null,
            });
        };
        for (const turn of turns) {
            push("user", questionOf(turn));
            push("assistant", cleanAnswer(turn.body));
        }
        if (messages.length === 0) return null;

        return {
            rawExternalConversationId: rawId,
            title: truncateTitle(firstQuestion),
            sourceModelLabels: [],
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            messages,
            warnings,
        };
    },
};
