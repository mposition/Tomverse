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
 * rule, outside a code fence. An answer's own `---` is followed by `##` or
 * prose in every export seen, and a fenced `---` / `# comment` is code.
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
const HIDDEN_CITATIONS = /^<span\s+style="display:\s*none;?">(?:\[\^\d+_\d+\])*<\/span>$/;
const FOOTNOTE_DEFINITION = /^\[\^\d+_(\d+)\]:\s*(.+)$/;
const FOOTNOTE_MARK = /\[\^\d+_(\d+)\]/g;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^# (?!#)(.*)$/;

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
 * A stable lineage id from the opening question. The export carries no
 * thread id; a re-export of the same thread with more turns opens with the
 * same question, so it lands in the same lineage as a new snapshot (§4.2).
 * Hashed so the question text itself is not used as an identifier.
 */
const lineageId = (question: string): string => {
    const text = question.replace(/\s+/g, " ").trim();
    let a = 0x811c9dc5;
    let b = 0x01000193 ^ text.length;
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        a = Math.imul(a ^ code, 0x01000193) >>> 0;
        b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
    }
    return `perplexity-md-${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
};

type Turn = { question: string; body: string[] };

function splitTurns(text: string): Turn[] {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const turns: Turn[] = [];
    let current: Turn | null = null;
    let inFence = false;
    let lastNonBlank = "";
    for (const line of lines) {
        if (FENCE.test(line)) inFence = !inFence;
        const heading = inFence ? null : HEADING.exec(line);
        const opensTurn =
            heading !== null && (current === null || lastNonBlank.trim() === "---");
        if (opensTurn) {
            if (current) {
                // The `---` that separated the turns belongs to neither.
                const at = current.body.map((l) => l.trim()).lastIndexOf("---");
                if (at >= 0) current.body.splice(at);
            }
            current = { question: heading[1], body: [] };
            turns.push(current);
        } else if (current) {
            current.body.push(line);
        }
        if (line.trim()) lastNonBlank = line;
    }
    return turns;
}

const cleanQuestion = (raw: string): string =>
    raw.replace(/<q>([\s\S]*?)<\/q>/g, "“$1”").trim();

function cleanAnswer(body: readonly string[]): string {
    const sources = new Map<number, string>();
    const kept: string[] = [];
    let inFence = false;
    for (const line of body) {
        if (FENCE.test(line)) inFence = !inFence;
        const trimmed = line.trim();
        if (!inFence) {
            if (LOGO.test(trimmed) || DIVIDER.test(trimmed) || HIDDEN_CITATIONS.test(trimmed)) {
                continue;
            }
            const definition = FOOTNOTE_DEFINITION.exec(trimmed);
            if (definition) {
                sources.set(Number(definition[1]), definition[2].trim());
                continue;
            }
            kept.push(line.replace(FOOTNOTE_MARK, "[$1]"));
            continue;
        }
        kept.push(line);
    }
    let answer = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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
        const rawId = lineageId(firstQuestion);
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
