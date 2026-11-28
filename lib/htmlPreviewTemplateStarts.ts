import { parse, type DefaultTreeAdapterMap } from "parse5";

import type { TemplateStartTag } from "@/lib/htmlArtifactPreview";

type ParentNode = DefaultTreeAdapterMap["parentNode"];
type ChildNode = DefaultTreeAdapterMap["childNode"];
type Template = DefaultTreeAdapterMap["template"];

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/**
 * Every HTML `<template>` element the HTML parser makes from `document`, with
 * where its start tag's name ends in that text and its `shadowrootmode` value
 * (null when it has none).
 *
 * The text is parsed by parse5, an implementation of the HTML standard's
 * tokenizer and tree construction, the same steps the frame's parser takes:
 * text inside a script, a style, a comment, a textarea or a title is text,
 * not a tag; a `<template>` inside `<svg>` is an SVG element; one inside
 * MathML's `<mi>` is HTML again. Attribute values arrive decoded, and of two
 * same-named attributes only the first, as the browser keeps it. Nothing is
 * built from the tree: lib/htmlArtifactPreview.ts only reads the positions.
 *
 * Loaded on its own (the chat imports it only for a page that names
 * `shadowrootmode`), so parse5 is not in the chat's first bundle.
 */
export function findTemplateStartTags(document: string): TemplateStartTag[] {
    const tree = parse(document, { sourceCodeLocationInfo: true, scriptingEnabled: true });
    const found: TemplateStartTag[] = [];
    const pending: Array<ParentNode | ChildNode> = [tree];
    while (pending.length > 0) {
        const node = pending.pop()!;
        if ("tagName" in node && node.tagName === "template" && node.namespaceURI === HTML_NAMESPACE) {
            const start = node.sourceCodeLocation?.startTag?.startOffset;
            if (typeof start !== "number") throw new Error("A template element has no start tag in the source.");
            const mode = node.attrs.find((attribute) => attribute.name === "shadowrootmode" && !attribute.namespace);
            found.push({ nameEnd: start + "<template".length, mode: mode ? mode.value : null });
            const content = (node as Template).content.childNodes;
            for (let index = 0; index < content.length; index++) pending.push(content[index]);
        }
        if ("childNodes" in node) {
            const children = node.childNodes;
            for (let index = 0; index < children.length; index++) pending.push(children[index]);
        }
    }
    return found;
}
