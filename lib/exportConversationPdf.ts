import "server-only";

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString } from "mdast-util-to-string";

// The syntax-tree types come from what the parser returns. `mdast` itself is a
// types-only package with no runtime entry, so importing it is an unresolved
// import to the app-runtime analysis (lib/agentControlPlaneSlice.ts).
type Root = ReturnType<typeof fromMarkdown>;
type RootContent = Root["children"][number];
type List = Extract<RootContent, { type: "list" }>;
type ListItem = List["children"][number];
type Table = Extract<RootContent, { type: "table" }>;
type PhrasingContent = Extract<RootContent, { type: "paragraph" }>["children"][number];
type Nodes = Root | RootContent | ListItem | PhrasingContent;
import { gfm } from "micromark-extension-gfm";

import { formatExportMessageLabel, headerLineText } from "@/lib/exportConversation";
import {
    ARTIFACT_LIMITS,
    documentSpecSchema,
    type ArtifactDocumentBlock,
    type DocumentSpec,
} from "@/lib/generatedArtifactCore";
import { ArtifactRenderError, renderDocumentArtifact } from "@/lib/generatedArtifactRenderers";
import { PdfGenerationError } from "@/lib/generatedArtifactPdf";

/**
 * The PDF form of a conversation export.
 *
 * Same conversation, same messages and the same header lines as the Markdown
 * export (the route decides those, in one place for both); only the writer
 * differs. The writer is the generated-file PDF renderer
 * (lib/generatedArtifactPdf.ts), which embeds the Noto Sans KR subset, so
 * Korean, Chinese and Japanese text draws as text. Message Markdown is read
 * with the parser the answer renderer already depends on
 * (mdast-util-from-markdown with GFM tables) and mapped onto that renderer's
 * blocks: headings, paragraphs, lists, quotes, code and tables. Maths,
 * Mermaid and charts arrive as their source text.
 *
 * Bounded before rendering: a conversation past PDF_EXPORT_LIMITS is refused
 * as too large rather than cut, because a PDF that silently stops reads as the
 * whole conversation.
 */

export const PDF_EXPORT_LIMITS = {
    messages: 1_000,
    characters: 400_000,
} as const;

export class ConversationPdfTooLarge extends Error {
    constructor() {
        super("This conversation is too long for a PDF.");
        this.name = "ConversationPdfTooLarge";
    }
}

export type PdfExportMessage = {
    role: string;
    content: string;
    modelId?: string | null;
    createdAt?: Date | string;
};

const MAX_TEXT = ARTIFACT_LIMITS.maxTextLength;
const MAX_TITLE = ARTIFACT_LIMITS.maxTitleLength;

/*
  Nothing in a message is cut. Every limit of the writer's blocks (text,
  heading, list and table sizes) is met by choosing a block that can hold the
  content -- a heading too long for one becomes a paragraph, a list or table
  that does not fit becomes paragraphs with its own markers or
  "column: value" lines, long text is split into consecutive blocks -- never
  by shortening it. What still cannot fit (block count, output bytes) is
  refused as too large.
*/

/** Long text in pieces the renderer accepts, split at line ends where possible. */
const chunks = (value: string): string[] => {
    if (value.length <= MAX_TEXT) return [value];
    const parts: string[] = [];
    let rest = value;
    while (rest.length > MAX_TEXT) {
        const cut = rest.lastIndexOf("\n", MAX_TEXT);
        const at = cut > MAX_TEXT / 2 ? cut : MAX_TEXT;
        parts.push(rest.slice(0, at));
        // The line break the text was split at becomes the boundary between blocks.
        rest = rest.slice(at).replace(/^\n/, "");
    }
    if (rest) parts.push(rest);
    return parts;
};

const formatDate = (value?: Date | string) => {
    if (!value) return "";
    const date = typeof value === "string" ? new Date(value) : value;
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

/** Inline Markdown as reading text: a link or image keeps its address, code its backticks. */
const inline = (nodes: readonly PhrasingContent[]): string =>
    nodes
        .map((node) => {
            switch (node.type) {
                case "text":
                case "html":
                    return node.value;
                case "inlineCode":
                    return `\`${node.value}\``;
                case "break":
                    return "\n";
                case "link": {
                    const label = inline(node.children);
                    return label && label !== node.url ? `${label} (${node.url})` : node.url;
                }
                case "image":
                    return node.alt ? `${node.alt} (${node.url})` : node.url;
                case "imageReference":
                    return `${node.alt ? `${node.alt} ` : ""}[${node.label ?? node.identifier}]`;
                case "footnoteReference":
                    return `[^${node.identifier}]`;
                default:
                    return "children" in node ? inline(node.children as PhrasingContent[]) : toString(node);
            }
        })
        .join("");

const listMarker = (list: List, index: number) => (list.ordered ? `${(list.start ?? 1) + index}.` : "•");
const taskBox = (item: ListItem) => (item.checked === true ? "[x] " : item.checked === false ? "[ ] " : "");

/**
 * Any block as reading text, a line per block, for the places the writer has
 * only a string for (a list item). Every child is kept, and a nested list
 * keeps its own markers.
 */
const plain = (node: Nodes, depth = 0): string => {
    switch (node.type) {
        case "paragraph":
        case "heading":
        case "tableCell":
            return inline(node.children);
        case "code":
        case "html":
            return node.value;
        case "list":
            return node.children
                .map((item, index) => `${"  ".repeat(depth)}${listMarker(node, index)} ${taskBox(item)}${listItemText(item, depth)}`)
                .join("\n");
        case "listItem":
            return listItemText(node, depth);
        case "table":
            return node.children.map((row) => row.children.map((cell) => inline(cell.children)).join(" | ")).join("\n");
        case "thematicBreak":
            return "---";
        case "definition":
            return `[${node.label ?? node.identifier}]: ${node.url}${node.title ? ` "${node.title}"` : ""}`;
        case "footnoteDefinition":
            return `[^${node.identifier}]: ${node.children.map((child) => plain(child, depth)).join("\n")}`;
        default:
            return "children" in node
                ? (node.children as Nodes[]).map((child) => plain(child, depth)).join("\n")
                : toString(node);
    }
};

/** One list item's text; a nested list becomes indented lines under it. */
const listItemText = (item: ListItem, depth = 0): string =>
    item.children
        .map((child) => plain(child, child.type === "list" ? depth + 1 : depth))
        .filter(Boolean)
        .join("\n");

const paragraphs = (type: "paragraph" | "quote", text: string): ArtifactDocumentBlock[] =>
    text.trim() ? chunks(text).map((piece) => ({ type, text: piece })) : [];

/** A heading when the writer can hold it as one, otherwise the same words as a paragraph. */
const headingBlocks = (level: number, text: string): ArtifactDocumentBlock[] =>
    !text ? [] : text.length <= MAX_TITLE ? [{ type: "heading", level, text }] : paragraphs("paragraph", text);

const listBlocks = (node: List): ArtifactDocumentBlock[] => {
    const items = node.children.map((item) => `${taskBox(item)}${listItemText(item)}`);
    // The list writer numbers from 1 and holds a bounded number of bounded items.
    const native =
        items.length <= ARTIFACT_LIMITS.maxListItems &&
        items.every((text) => text.length <= MAX_TEXT) &&
        (!node.ordered || (node.start ?? 1) === 1);
    if (native) return [{ type: node.ordered ? "numbers" : "bullets", items }];
    // Otherwise the same items, each with its own marker, as paragraphs:
    // nothing cut and nothing renumbered.
    return items.flatMap((text, index) => paragraphs("paragraph", `${listMarker(node, index)} ${text}`));
};

const tableBlocks = (node: Table): ArtifactDocumentBlock[] => {
    const [head = [], ...body] = node.children.map((row) => row.children.map((cell) => inline(cell.children)));
    const width = Math.max(head.length, ...body.map((row) => row.length));
    if (width === 0) return [];
    const pad = (row: string[]) => Array.from({ length: width }, (_, index) => row[index] ?? "");
    const fits =
        width <= ARTIFACT_LIMITS.maxDocumentTableColumns &&
        head.every((cell) => cell.length <= MAX_TITLE) &&
        body.every((row) => row.every((cell) => cell.length <= MAX_TEXT));
    if (fits) {
        const rows = body.map(pad);
        const blocks: ArtifactDocumentBlock[] = [];
        // A long table is several tables, each with the header again.
        for (let start = 0; start === 0 || start < rows.length; start += ARTIFACT_LIMITS.maxDocumentTableRows) {
            blocks.push({ type: "table", columns: pad(head), rows: rows.slice(start, start + ARTIFACT_LIMITS.maxDocumentTableRows) });
        }
        return blocks;
    }
    // Too wide for the page, or a header or cell too long for the table writer:
    // each row as "column: value" lines, every column and every character kept.
    if (body.length === 0) return paragraphs("paragraph", head.join(" | "));
    const name = (index: number) => head[index]?.trim() || `${index + 1}`;
    return body.flatMap((row) =>
        paragraphs("paragraph", pad(row).map((value, index) => `${name(index)}: ${value}`).join("\n"))
    );
};

const nodeBlocks = (node: RootContent): ArtifactDocumentBlock[] => {
    switch (node.type) {
        case "heading":
            // Level 2 introduces each turn, so an answer's own headings sit below it.
            return headingBlocks(Math.min(4, node.depth + 2), headerLineText(inline(node.children)).trim());
        case "paragraph":
            return paragraphs("paragraph", inline(node.children));
        case "list":
            return listBlocks(node);
        case "blockquote":
            // Its paragraphs as quotes; a list, code or table inside keeps its own form.
            return node.children.flatMap((child) =>
                child.type === "paragraph" ? paragraphs("quote", inline(child.children)) : nodeBlocks(child)
            );
        case "code":
            return chunks(node.value).map((text) => ({
                type: "code",
                ...(node.lang && node.lang.length <= 40 ? { language: node.lang } : {}),
                text,
            }));
        case "table":
            return tableBlocks(node);
        case "thematicBreak":
            return [{ type: "divider" }];
        default:
            return paragraphs("paragraph", plain(node));
    }
};

/** One message's Markdown as the renderer's blocks. */
export function markdownToDocumentBlocks(markdown: string): ArtifactDocumentBlock[] {
    const tree: Root = fromMarkdown(markdown, {
        extensions: [gfm()],
        mdastExtensions: [gfmFromMarkdown()],
    });
    return tree.children.flatMap(nodeBlocks);
}

/** The document the route renders: header lines, then every turn. */
export function conversationPdfSpec(input: {
    title: string;
    createdAt?: Date | string;
    productKey?: string | null;
    headerLines: readonly string[];
    messages: readonly PdfExportMessage[];
}): DocumentSpec {
    if (input.messages.length > PDF_EXPORT_LIMITS.messages) throw new ConversationPdfTooLarge();
    const characters = input.messages.reduce((total, message) => total + message.content.length, 0);
    if (characters > PDF_EXPORT_LIMITS.characters) throw new ConversationPdfTooLarge();

    const created = formatDate(input.createdAt);
    const title = headerLineText(input.title).trim() || "Conversation";
    const blocks: ArtifactDocumentBlock[] = [
        // A name longer than the title line can hold is printed whole below it.
        ...(title.length > MAX_TITLE ? paragraphs("paragraph", title) : []),
        ...input.headerLines.flatMap((line) => paragraphs("quote", headerLineText(line))),
    ];
    for (const message of input.messages) {
        const when = formatDate(message.createdAt);
        if (blocks.length > 0) blocks.push({ type: "divider" });
        blocks.push(...headingBlocks(2, `${headerLineText(formatExportMessageLabel(message))}${when ? ` · ${when}` : ""}`));
        blocks.push(...markdownToDocumentBlocks(message.content));
        if (blocks.length > ARTIFACT_LIMITS.maxDocumentBlocks) throw new ConversationPdfTooLarge();
    }
    if (blocks.length === 0) blocks.push({ type: "paragraph", text: "" });

    return documentSpecSchema.parse({
        filename: "conversation.pdf",
        format: "pdf",
        title: title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title,
        subtitle: `${input.productKey === "chat" ? "Tomverse Chat Export" : "Tomverse Review Export"}${created ? ` · ${created}` : ""}`,
        blocks,
    });
}

export type ConversationPdfOutcome =
    /**
     * `charactersReplaced`: a few characters the font has no glyph for (emoji,
     * some symbols) were drawn as boxes. The file is made, and the download
     * says so rather than letting it pass for a complete copy.
     */
    | { ok: true; bytes: Uint8Array; charactersReplaced: boolean }
    | { ok: false; code: "EXPORT_TOO_LARGE" | "UNSUPPORTED_CHARACTERS" };

/** Render, and name the two refusals the download menu can explain. */
export function renderConversationPdf(spec: DocumentSpec): ConversationPdfOutcome {
    try {
        const rendered = renderDocumentArtifact(spec);
        return { ok: true, bytes: rendered.bytes, charactersReplaced: (rendered.notices?.length ?? 0) > 0 };
    } catch (error) {
        if (error instanceof ArtifactRenderError && error.code === "OUTPUT_TOO_LARGE") {
            return { ok: false, code: "EXPORT_TOO_LARGE" };
        }
        if (error instanceof PdfGenerationError && error.code === "UNSUPPORTED_CHARACTERS") {
            return { ok: false, code: "UNSUPPORTED_CHARACTERS" };
        }
        throw error;
    }
}
