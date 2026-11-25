import type { BrowserAgentReply } from "../../../tomverse-cli/src/browser-tools";

/** What the agent reads from a page, shaped here so the host's bounds do not depend on what the page sends. */

export const MAX_READ_CHARACTERS = 14_000;
export const MAX_TREE_LINES = 500;
export const MAX_CONSOLE_ENTRIES = 100;

type ConsoleLevel = "log" | "info" | "warning" | "error";
export type ConsoleEntry = { level: ConsoleLevel; text: string };
type Page = { title: string; text: string; controls: string[] };

/** The page text, then its controls: one block the agent can read and pick selectors from. */
export function formatPageText(page: Page, url: string): string {
  const text = String(page.text ?? "").replace(/\n{3,}/g, "\n\n").trim();
  const controls = (Array.isArray(page.controls) ? page.controls : []).filter((line) => typeof line === "string").slice(0, 80);
  const block = ["Title: " + String(page.title ?? "").slice(0, 200), "URL: " + url, "", "Visible text:", text || "(none)",
    "", "Controls (kind, name, selector):", ...(controls.length ? controls : ["(none)"])].join("\n");
  return block.length > MAX_READ_CHARACTERS ? block.slice(0, MAX_READ_CHARACTERS) + "\n[truncated]" : block;
}

export type AxNode = {
  nodeId: string; parentId?: string; childIds?: string[]; ignored?: boolean;
  role?: { value?: unknown }; name?: { value?: unknown }; value?: { value?: unknown };
  properties?: Array<{ name?: string; value?: { value?: unknown } }>;
};
const SKIPPED_ROLES = new Set(["none", "presentation", "generic", "InlineTextBox", "LineBreak", "RootWebArea", "ignored"]);
const SHOWN_PROPERTIES = new Set(["disabled", "checked", "expanded", "selected", "required", "invalid", "level"]);

/** An indented outline (role, name, value, a few states) of the accessibility tree; structure only, in document order. */
export function formatAxTree(nodes: AxNode[]): string {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const lines: string[] = [];
  const visit = (node: AxNode, depth: number, parentName: string) => {
    if (lines.length >= MAX_TREE_LINES) return;
    const role = typeof node.role?.value === "string" ? node.role.value : "";
    const name = typeof node.name?.value === "string" ? node.name.value.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    const shown = !node.ignored && role !== "" && !SKIPPED_ROLES.has(role) && !(role === "StaticText" && (!name || name === parentName));
    let nextDepth = depth;
    if (shown) {
      const value = typeof node.value?.value === "string" || typeof node.value?.value === "number" ? " value=" + JSON.stringify(String(node.value.value).slice(0, 80)) : "";
      const states = (node.properties ?? []).filter((property) => property.name && SHOWN_PROPERTIES.has(property.name) && property.value?.value !== false && property.value?.value !== undefined)
        .map((property) => (property.value?.value === true ? property.name : `${property.name}=${String(property.value?.value)}`));
      lines.push("  ".repeat(Math.min(depth, 12)) + role + (name ? " " + JSON.stringify(name) : "") + value + (states.length ? " (" + states.join(", ") + ")" : ""));
      nextDepth = depth + 1;
    }
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) visit(child, nextDepth, shown ? name : parentName);
    }
  };
  const roots = nodes.filter((node) => !node.parentId || !byId.has(node.parentId));
  for (const root of roots) visit(root, 0, "");
  const text = lines.join("\n") || "(the page exposes no accessibility tree)";
  return lines.length >= MAX_TREE_LINES ? text + "\n[truncated]" : text;
}

/** Keeps the newest entries; only warnings and errors matter to the agent, and each is bounded. */
export function pushConsoleEntry(entries: ConsoleEntry[], level: string, message: string): void {
  const mapped: ConsoleLevel | null = level === "error" ? "error" : level === "warning" ? "warning" : null;
  // Electron's own notice about a page without a content security policy is about the app, not about the page's code.
  if (!mapped || message.startsWith("Electron Security Warning")) return;
  entries.push({ level: mapped, text: String(message).replace(/\s+/g, " ").trim().slice(0, 1000) });
  if (entries.length > MAX_CONSOLE_ENTRIES) entries.splice(0, entries.length - MAX_CONSOLE_ENTRIES);
}

/** The reply the host sends to the runner, with every page-derived string passed through `clean` (credentials out) and bounded. */
export function cleanReply(reply: BrowserAgentReply, clean: (text: string) => string): BrowserAgentReply {
  if (reply.status === "error") return { status: "error", message: clean(reply.message).slice(0, 500) };
  return {
    status: "ok",
    url: clean(reply.url).slice(0, 2048),
    ...(reply.title !== undefined ? { title: clean(reply.title).slice(0, 300) } : {}),
    ...(reply.text !== undefined ? { text: clean(reply.text).slice(0, 60_000) } : {}),
    ...(reply.image ? { image: reply.image } : {}),
    ...(reply.entries ? { entries: reply.entries.slice(-MAX_CONSOLE_ENTRIES).map((entry) => ({ level: entry.level, text: clean(entry.text).slice(0, 1000) })) } : {}),
  };
}
