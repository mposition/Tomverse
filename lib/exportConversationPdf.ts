import "server-only";

import type { List, ListItem, PhrasingContent, Root, RootContent, Table } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString } from "mdast-util-to-string";
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

const clipTitle = (value: string) => (value.length > MAX_TITLE ? `${value.slice(0, MAX_TITLE - 1)}…` : value);

/** Long text in pieces the renderer accepts, split at line ends where possible. */
const chunks = (value: string): string[] => {
    if (value.length <= MAX_TEXT) return [value];
    const parts: string[] = [];
    let rest = value;
    while (rest.length > MAX_TEXT) {
        const cut = rest.lastIndexOf("\n", MAX_TEXT);
        const at = cut > MAX_TEXT / 2 ? cut : MAX_TEXT;
        parts.push(rest.slice(0, at));
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

/** Inline Markdown as reading text: a link keeps its address, code its backticks. */
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
                    return node.alt ? `[${node.alt}]` : "";
                case "footnoteReference":
                    return `[^${node.identifier}]`;
                default:
                    return "children" in node ? inline(node.children as PhrasingContent[]) : toString(node);
            }
        })
        .join("");

/** One list item's text; a nested list becomes indented lines under it. */
const listItemText = (item: ListItem, depth = 0): string =>
    item.children
        .map((child) =>
            child.type === "paragraph"
                ? inline(child.children)
                : child.type === "list"
                  ? child.children
                        .map((nested) => `${"  ".repeat(depth + 1)}• ${listItemText(nested, depth + 1)}`)
                        .join("\n")
                  : toString(child)
        )
        .filter(Boolean)
        .join("\n");

const listBlocks = (node: List): ArtifactDocumentBlock[] => {
    const items = node.children.map((item) => chunks(listItemText(item))[0]).filter((text) => text.trim());
    const blocks: ArtifactDocumentBlock[] = [];
    for (let start = 0; start < items.length; start += ARTIFACT_LIMITS.maxListItems) {
        blocks.push({
            type: node.ordered ? "numbers" : "bullets",
            items: items.slice(start, start + ARTIFACT_LIMITS.maxListItems),
        });
    }
    return blocks;
};

const tableBlocks = (node: Table): ArtifactDocumentBlock[] => {
    const [head, ...body] = node.children.map((row) =>
        row.children.map((cell) => chunks(inline(cell.children))[0] ?? "")
    );
    if (!head) return [];
    const width = Math.min(
        ARTIFACT_LIMITS.maxDocumentTableColumns,
        Math.max(head.length, ...body.map((row) => row.length))
    );
    const pad = (row: string[]) => Array.from({ length: width }, (_, index) => row[index] ?? "");
    const columns = pad(head).map((cell) => clipTitle(cell));
    const rows = body.map(pad);
    const blocks: ArtifactDocumentBlock[] = [];
    for (let start = 0; start === 0 || start < rows.length; start += ARTIFACT_LIMITS.maxDocumentTableRows) {
        blocks.push({ type: "table", columns, rows: rows.slice(start, start + ARTIFACT_LIMITS.maxDocumentTableRows) });
    }
    return blocks;
};

const paragraphs = (type: "paragraph" | "quote", text: string): ArtifactDocumentBlock[] =>
    text.trim() ? chunks(text).map((piece) => ({ type, text: piece })) : [];

const nodeBlocks = (node: RootContent): ArtifactDocumentBlock[] => {
    switch (node.type) {
        case "heading": {
            const text = clipTitle(headerLineText(inline(node.children)).trim());
            // Level 2 introduces each turn, so an answer's own headings sit below it.
            return text ? [{ type: "heading", level: Math.min(4, node.depth + 2), text }] : [];
        }
        case "paragraph":
            return paragraphs("paragraph", inline(node.children));
        case "list":
            return listBlocks(node);
        case "blockquote":
            return paragraphs(
                "quote",
                node.children.map((child) => (child.type === "paragraph" ? inline(child.children) : toString(child))).join("\n")
            );
        case "code":
            return chunks(node.value).map((text) => ({
                type: "code",
                ...(node.lang ? { language: node.lang.slice(0, 40) } : {}),
                text,
            }));
        case "table":
            return tableBlocks(node);
        case "thematicBreak":
            return [{ type: "divider" }];
        case "html":
            return paragraphs("paragraph", node.value);
        default:
            return paragraphs("paragraph", toString(node));
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
    const blocks: ArtifactDocumentBlock[] = input.headerLines.flatMap((line) =>
        paragraphs("quote", headerLineText(line))
    );
    for (const message of input.messages) {
        const when = formatDate(message.createdAt);
        if (blocks.length > 0) blocks.push({ type: "divider" });
        blocks.push({
            type: "heading",
            level: 2,
            text: clipTitle(`${headerLineText(formatExportMessageLabel(message))}${when ? ` · ${when}` : ""}`),
        });
        blocks.push(...markdownToDocumentBlocks(message.content));
        if (blocks.length > ARTIFACT_LIMITS.maxDocumentBlocks) throw new ConversationPdfTooLarge();
    }
    if (blocks.length === 0) blocks.push({ type: "paragraph", text: "" });

    return documentSpecSchema.parse({
        filename: "conversation.pdf",
        format: "pdf",
        title: clipTitle(headerLineText(input.title).trim() || "Conversation"),
        subtitle: `${input.productKey === "chat" ? "Tomverse Chat Export" : "Tomverse Review Export"}${created ? ` · ${created}` : ""}`,
        blocks,
    });
}

export type ConversationPdfOutcome =
    | { ok: true; bytes: Uint8Array }
    | { ok: false; code: "EXPORT_TOO_LARGE" | "UNSUPPORTED_CHARACTERS" };

/** Render, and name the two refusals the download menu can explain. */
export function renderConversationPdf(spec: DocumentSpec): ConversationPdfOutcome {
    try {
        return { ok: true, bytes: renderDocumentArtifact(spec).bytes };
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
