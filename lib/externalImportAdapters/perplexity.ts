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
 * defined none yet, is the rest of the previous answer. An uncited answer
 * carries no such evidence, so a rule-and-heading inside one still splits it
 * -- and can shift the numbering for the turn after. Known limitation.
 *
 * The question is the heading line. A multi-line question exports its later
 * lines as plain paragraphs under the heading, with nothing marking where the
 * answer begins, so those lines arrive at the top of the answer. Known
 * limitation; telling them apart is a semantic call (an LLM split), which
 * would be a new paid call on the raw export.
 *
 * Citations are kept. The footnote marks become `[n]` and the definitions a
 * "Sources" list at the end of the answer, because a footnote definition
 * whose mark is hidden (the display:none span) would be dropped by a
 * Markdown renderer -- and with it the source.
 *
 * Pure and isomorphic, like every adapter.
 */

/** The shape the worker hands over for a Markdown file. */
export type PerplexityMarkdownEntry = { perplexityMarkdown: string };

export const perplexityMarkdownEntry = (
    text: string
): PerplexityMarkdownEntry => ({ perplexityMarkdown: text });

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
 * The export's logo line, or its turn-scoped footnotes (`[^1_1]:`) next to a
 * question heading. A plain notes file has neither.
 */
const looksLikePerplexityExport = (text: string): boolean =>
    /r2cdn\.perplexity\.ai\/pplx-/.test(text) ||
    (/^\[\^1_1\]:\s/m.test(text) && /^# (?!#)/m.test(text));

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

function splitTurns(text: string): Turn[] {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const turns: Array<Turn & { number: number; defines: boolean }> = [];
    for (const candidate of candidateTurns(lines)) {
        const previous = turns[turns.length - 1];
        const defined = definedTurns(candidate);
        if (
            previous &&
            !previous.defines &&
            defined.length > 0 &&
            defined.every((number) => number === previous.number)
        ) {
            // The sources defined here are the previous turn's own, and it
            // had none yet: this is the rest of that answer, split at a rule
            // and heading of its own.
            previous.body.push(candidate.heading, ...candidate.body);
            previous.defines = true;
            continue;
        }
        turns.push({
            ...candidate,
            number: defined[0] ?? (previous?.number ?? 0) + 1,
            defines: defined.length > 0,
        });
    }
    for (const turn of turns.slice(0, -1)) dropSeparator(turn.body);
    return turns;
}

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
        const turns = splitTurns(text);
        if (turns.length === 0) return null;

        const firstQuestion = cleanQuestion(turns[0].question);
        const rawId = lineageId(firstQuestion, cleanAnswer(turns[0].body));
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
            push("user", cleanQuestion(turn.question));
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
