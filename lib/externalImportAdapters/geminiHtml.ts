/**
 * Gemini answer HTML -> Markdown, for the A2 import adapter.
 *
 * docs/policy/external-import-gemini-a2.md §4, §5.
 *
 * A Google Takeout activity entry stores the user's prompt as plain text and
 * the model's answer as HTML: Gemini renders Markdown before exporting, so
 * what the archive holds is `<strong>`, `<pre><code>`, `<table>` and friends.
 * Storing that HTML would put markup in a message body that the product
 * renders as Markdown, so it is converted back.
 *
 * The vocabulary is bounded and the conversion is exact for it. An unknown
 * tag throws (§5: a structure we do not recognise is refused rather than
 * half-recovered) and the caller drops that one turn and counts it — the
 * adapter contract keeps one bad entry from failing an archive.
 *
 * Pure and isomorphic: no DOM. A Web Worker has no `document`, and even where
 * one exists, parsing untrusted export HTML through it is not something this
 * path should start doing.
 */

/** Thrown for markup this converter cannot claim to understand. */
export class GeminiMarkupError extends Error {
    constructor(public readonly tag: string) {
        super(`Unsupported markup in a Gemini answer: <${tag}>`);
        this.name = "GeminiMarkupError";
    }
}

/**
 * Every tag observed in a real export, and nothing else. Adding one means
 * deciding how it renders, which is why the list is not a permissive default.
 */
const BLOCK_TAGS = new Set([
    "p", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "pre", "blockquote", "hr",
    "table", "thead", "tbody", "tr", "th", "td",
    "div",
]);
const INLINE_TAGS = new Set(["strong", "b", "em", "i", "code", "a", "br", "img", "span"]);
const VOID_TAGS = new Set(["br", "hr", "img"]);

type Element = { kind: "element"; tag: string; attrs: string; children: Node[] };
type Text = { kind: "text"; value: string };
type Node = Element | Text;

const ENTITIES: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

const decodeEntities = (value: string): string =>
    value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
        if (body.startsWith("#")) {
            const code = body.startsWith("#x") || body.startsWith("#X")
                ? Number.parseInt(body.slice(2), 16)
                : Number.parseInt(body.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff
                ? String.fromCodePoint(code)
                : whole;
        }
        return ENTITIES[body.toLowerCase()] ?? whole;
    });

const attributeOf = (attrs: string, name: string): string | null => {
    const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attrs);
    if (!match) return null;
    return decodeEntities(match[2] ?? match[3] ?? "");
};

const TOKEN = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/g;

/** Builds a tree. Throws on a tag outside the vocabulary. */
function parse(html: string): Node[] {
    const root: Element = { kind: "element", tag: "#root", attrs: "", children: [] };
    const stack: Element[] = [root];
    const top = () => stack[stack.length - 1];

    let cursor = 0;
    TOKEN.lastIndex = 0;
    for (let match = TOKEN.exec(html); match; match = TOKEN.exec(html)) {
        if (match.index > cursor) {
            top().children.push({ kind: "text", value: html.slice(cursor, match.index) });
        }
        cursor = match.index + match[0].length;

        const tag = match[1].toLowerCase();
        const closing = match[0].startsWith("</");
        if (!BLOCK_TAGS.has(tag) && !INLINE_TAGS.has(tag)) throw new GeminiMarkupError(tag);

        if (VOID_TAGS.has(tag)) {
            if (!closing) {
                top().children.push({ kind: "element", tag, attrs: match[2] ?? "", children: [] });
            }
            continue;
        }
        if (closing) {
            // An unbalanced close is tolerated only when it matches something
            // open: exports do not nest badly, and guessing is what §5 forbids.
            const index = stack.map((node) => node.tag).lastIndexOf(tag);
            if (index > 0) stack.length = index;
            continue;
        }
        const element: Element = { kind: "element", tag, attrs: match[2] ?? "", children: [] };
        top().children.push(element);
        stack.push(element);
    }
    if (cursor < html.length) {
        top().children.push({ kind: "text", value: html.slice(cursor) });
    }
    return root.children;
}

const isElement = (node: Node): node is Element => node.kind === "element";

/** Inline runs: everything that does not force a line of its own. */
function renderInline(nodes: readonly Node[]): string {
    let out = "";
    for (const node of nodes) {
        if (!isElement(node)) {
            out += decodeEntities(node.value).replace(/\s+/g, " ");
            continue;
        }
        switch (node.tag) {
            case "strong":
            case "b":
                out += `**${renderInline(node.children).trim()}**`;
                break;
            case "em":
            case "i":
                out += `*${renderInline(node.children).trim()}*`;
                break;
            case "code":
                out += `\`${renderInline(node.children).trim()}\``;
                break;
            case "a": {
                const text = renderInline(node.children).trim();
                const href = attributeOf(node.attrs, "href");
                out += href ? `[${text}](${href})` : text;
                break;
            }
            case "br":
                out += "\n";
                break;
            case "img":
                // Counted by the adapter as a non-text part, not rendered.
                break;
            case "span":
                out += renderInline(node.children);
                break;
            default:
                // A block inside an inline run: render it as its own block and
                // let the caller's blank lines separate it.
                out += renderBlocks([node]);
        }
    }
    return out;
}

/** Raw text with entities decoded and whitespace kept — for code blocks. */
function renderVerbatim(nodes: readonly Node[]): string {
    let out = "";
    for (const node of nodes) {
        if (isElement(node)) {
            if (node.tag === "br") out += "\n";
            else out += renderVerbatim(node.children);
        } else {
            out += decodeEntities(node.value);
        }
    }
    return out;
}

const cellsOf = (row: Element): string[] =>
    row.children
        .filter((child): child is Element => isElement(child) && (child.tag === "th" || child.tag === "td"))
        .map((cell) => renderInline(cell.children).trim().replace(/\|/g, "\\|"));

function renderTable(table: Element): string {
    const rows: string[][] = [];
    let headerCount = 0;
    const walk = (nodes: readonly Node[], inHead: boolean) => {
        for (const node of nodes) {
            if (!isElement(node)) continue;
            if (node.tag === "tr") {
                rows.push(cellsOf(node));
                const isHeaderRow =
                    inHead || node.children.some((c) => isElement(c) && c.tag === "th");
                if (isHeaderRow && rows.length === headerCount + 1) headerCount += 1;
            } else if (node.tag === "thead") walk(node.children, true);
            else if (node.tag === "tbody") walk(node.children, false);
        }
    };
    walk(table.children, false);
    if (rows.length === 0) return "";

    const width = Math.max(...rows.map((row) => row.length));
    const pad = (row: string[]) => {
        const padded = [...row];
        while (padded.length < width) padded.push("");
        return `| ${padded.join(" | ")} |`;
    };
    const lines = [pad(rows[0])];
    // A Markdown table needs a delimiter row; without a header the first row
    // becomes one, which is how every renderer reads it anyway.
    lines.push(`| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
    for (const row of rows.slice(1)) lines.push(pad(row));
    return lines.join("\n");
}

function renderList(list: Element, depth: number): string {
    const ordered = list.tag === "ol";
    const items = list.children.filter(
        (child): child is Element => isElement(child) && child.tag === "li"
    );
    const indent = "  ".repeat(depth);
    return items
        .map((item, index) => {
            const nested = item.children.filter(
                (child): child is Element =>
                    isElement(child) && (child.tag === "ul" || child.tag === "ol")
            );
            const own = item.children.filter((child) => !nested.includes(child as Element));
            const marker = ordered ? `${index + 1}.` : "-";
            const body = renderInline(own).trim();
            const sub = nested.map((child) => renderList(child, depth + 1)).join("\n");
            return sub ? `${indent}${marker} ${body}\n${sub}` : `${indent}${marker} ${body}`;
        })
        .join("\n");
}

function renderBlocks(nodes: readonly Node[]): string {
    const blocks: string[] = [];
    let inlineRun: Node[] = [];
    const flush = () => {
        if (inlineRun.length === 0) return;
        const text = renderInline(inlineRun).trim();
        if (text) blocks.push(text);
        inlineRun = [];
    };

    for (const node of nodes) {
        if (!isElement(node) || INLINE_TAGS.has(node.tag)) {
            inlineRun.push(node);
            continue;
        }
        flush();
        switch (node.tag) {
            case "p":
            case "div": {
                const text = renderBlocks(node.children).trim();
                if (text) blocks.push(text);
                break;
            }
            case "h1": case "h2": case "h3":
            case "h4": case "h5": case "h6": {
                const level = Number.parseInt(node.tag.slice(1), 10);
                const text = renderInline(node.children).trim();
                if (text) blocks.push(`${"#".repeat(level)} ${text}`);
                break;
            }
            case "ul":
            case "ol": {
                const text = renderList(node, 0);
                if (text.trim()) blocks.push(text);
                break;
            }
            case "pre": {
                const code = renderVerbatim(node.children).replace(/^\n+|\n+$/g, "");
                blocks.push(`\`\`\`\n${code}\n\`\`\``);
                break;
            }
            case "blockquote": {
                const inner = renderBlocks(node.children).trim();
                if (inner) {
                    blocks.push(inner.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n"));
                }
                break;
            }
            case "hr":
                blocks.push("---");
                break;
            case "table": {
                const text = renderTable(node);
                if (text) blocks.push(text);
                break;
            }
            default:
                // thead/tbody/tr/th/td outside a table: keep the text rather
                // than lose it, since the tags themselves are recognised.
                blocks.push(renderBlocks(node.children).trim());
        }
    }
    flush();
    return blocks.filter(Boolean).join("\n\n");
}

/** How many `<img>` elements the answer carried, for the skipped-parts count. */
export function countImages(html: string): number {
    return (html.match(/<img\b/gi) || []).length;
}

/**
 * Converts one answer's HTML to Markdown.
 *
 * @throws GeminiMarkupError when the answer contains a tag this converter
 * does not render. The caller drops that turn and counts it.
 */
export function geminiHtmlToMarkdown(html: string): string {
    return renderBlocks(parse(html)).trim();
}
