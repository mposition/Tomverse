/**
 * Recognises a ```mermaid fenced block in the HAST node react-markdown hands
 * to its `pre` component, and returns the diagram source.
 *
 * Kept free of React and of the mermaid library: the library is loaded only
 * when a block like this actually appears (components/chat/MermaidDiagram.tsx).
 */

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
};

/** A diagram this large is shown as code instead of being laid out. */
export const MERMAID_MAX_SOURCE_CHARACTERS = 20_000;

const textOf = (node: HastNode): string =>
  typeof node.value === "string"
    ? node.value
    : (node.children ?? []).map(textOf).join("");

const classNames = (node: HastNode): string[] => {
  const value = node.properties?.className;
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" ? value.split(/\s+/) : [];
};

/** The diagram source of a `<pre><code class="language-mermaid">`, else null. */
export function mermaidSourceFromPre(node: HastNode | undefined): string | null {
  const code = node?.children?.find(
    (child) => child.type === "element" && child.tagName === "code"
  );
  if (!code || !classNames(code).includes("language-mermaid")) return null;
  const source = textOf(code).replace(/\r?\n$/, "");
  if (!source.trim() || source.length > MERMAID_MAX_SOURCE_CHARACTERS) return null;
  return source;
}

/** `<pre><code class="language-math">` is a display formula, not code. */
export function isMathPre(node: HastNode | undefined): boolean {
  const code = node?.children?.find(
    (child) => child.type === "element" && child.tagName === "code"
  );
  return Boolean(code) && classNames(code as HastNode).includes("language-math");
}
