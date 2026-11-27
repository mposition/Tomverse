/**
 * Global Chat shortcuts. Pure: given a key event, says which action it asks
 * for, so the rules (IME composition, typing in a field, Mac vs Windows) are
 * testable without a DOM.
 *
 *   Mod+Shift+O   new chat                (Mod is Cmd on Mac, Ctrl elsewhere)
 *   Mod+K         search conversations
 *   Shift+Esc     focus the message box
 *   Mod+Shift+C   copy the last answer
 *   Mod+/ or ?    show the shortcut list
 *
 * Two single-key forms (`/` focuses the message box, `?` shows the list) work
 * only when nothing editable has focus. Letters are matched on `event.code`:
 * with Option held a Mac reports a different `key`, and a Korean layout
 * reports Hangul for the same physical key.
 */

export type ChatShortcutAction =
  | "new-chat"
  | "search"
  | "focus-composer"
  | "copy-last-answer"
  | "show-shortcuts";

export type ChatShortcutEvent = {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  defaultPrevented?: boolean;
  target?: {
    tagName?: string;
    isContentEditable?: boolean;
    type?: string;
    role?: string | null;
  } | null;
};

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);

/** True when typing here produces characters (a single-key shortcut must stay out). */
export function isTextEntryTarget(target: ChatShortcutEvent["target"]): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return TEXT_INPUT_TYPES.has((target.type ?? "").toLowerCase());
  return target.role === "textbox" || target.role === "combobox" || target.role === "searchbox";
}

export function resolveChatShortcut(
  event: ChatShortcutEvent,
  platform: { isMac: boolean }
): ChatShortcutAction | null {
  if (event.defaultPrevented || event.repeat) return null;
  // The Enter or letter that confirms an IME composition reaches the page with
  // isComposing set (or keyCode 229 on older Android WebViews).
  if (event.isComposing || event.keyCode === 229) return null;

  const mod = platform.isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  const typing = isTextEntryTarget(event.target);

  if (mod && !event.altKey) {
    if (event.shiftKey && event.code === "KeyO") return "new-chat";
    if (event.shiftKey && event.code === "KeyC") return "copy-last-answer";
    if (!event.shiftKey && event.code === "KeyK") return "search";
    if (!event.shiftKey && (event.code === "Slash" || event.key === "/")) return "show-shortcuts";
    return null;
  }

  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  if (event.key === "Escape" && event.shiftKey) return "focus-composer";

  // Single keys never fire while typing, and never with Shift held for `/`.
  if (typing) return null;
  if (event.key === "/" && !event.shiftKey) return "focus-composer";
  if (event.key === "?") return "show-shortcuts";
  return null;
}

export function isMacPlatform(nav?: {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}): boolean {
  const source = nav ?? (typeof navigator === "undefined" ? undefined : (navigator as never));
  if (!source) return false;
  const platform = source.userAgentData?.platform || source.platform || "";
  if (/mac|iphone|ipad|ipod/i.test(platform)) return true;
  return !platform && /Mac OS X|iPhone|iPad/i.test(source.userAgent ?? "");
}

export type ShortcutRow = { action: ChatShortcutAction; keys: string[][] };

/** The keys to print, per platform; each inner array is one alternative. */
export function shortcutRows(isMac: boolean): ShortcutRow[] {
  const mod = isMac ? "⌘" : "Ctrl";
  const shift = isMac ? "⇧" : "Shift";
  return [
    { action: "new-chat", keys: [[mod, shift, "O"]] },
    { action: "search", keys: [[mod, "K"]] },
    { action: "focus-composer", keys: [["/"], [shift, "Esc"]] },
    { action: "copy-last-answer", keys: [[mod, shift, "C"]] },
    { action: "show-shortcuts", keys: [[mod, "/"], ["?"]] },
  ];
}
