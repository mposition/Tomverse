import { parse, type DefaultTreeAdapterMap } from "parse5";

type ServedRawTextElement = {
  tag: "script" | "style";
  attributes: Record<string, string>;
  body: string;
};

// Parse HTML without executing scripts or fetching resources. Source offsets
// preserve the delivered body bytes used by the server's CSP hashes.
export function servedRawTextElements(html: string): ServedRawTextElement[] {
  const elements: ServedRawTextElement[] = [];
  const visit = (node: DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node && (node.tagName === "script" || node.tagName === "style")) {
      const location = node.sourceCodeLocation;
      if (!location?.startTag) throw new Error("Raw-text element has no source opening tag");
      elements.push({
        tag: node.tagName,
        attributes: Object.fromEntries(node.attrs.map(({ name, value }) => [name, value])),
        body: html.slice(location.startTag.endOffset, location.endTag?.startOffset ?? location.endOffset),
      });
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(parse(html, { sourceCodeLocationInfo: true }));
  return elements;
}
