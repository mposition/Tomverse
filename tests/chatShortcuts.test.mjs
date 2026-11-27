import assert from "node:assert/strict";
import test from "node:test";

import { isMacPlatform, isTextEntryTarget, resolveChatShortcut, shortcutRows } from "../lib/chatShortcuts.ts";

const base = {
  key: "",
  code: "",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  target: { tagName: "BODY" },
};
const press = (event, isMac = false) => resolveChatShortcut({ ...base, ...event }, { isMac });

test("Windows and Linux use Ctrl, Mac uses Command", () => {
  const newChat = { key: "O", code: "KeyO", shiftKey: true };
  assert.equal(press({ ...newChat, ctrlKey: true }), "new-chat");
  assert.equal(press({ ...newChat, metaKey: true }), null);
  assert.equal(press({ ...newChat, metaKey: true }, true), "new-chat");
  assert.equal(press({ ...newChat, ctrlKey: true }, true), null);
  assert.equal(press({ key: "k", code: "KeyK", ctrlKey: true }), "search");
  assert.equal(press({ key: "k", code: "KeyK", metaKey: true }, true), "search");
  assert.equal(press({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }), "copy-last-answer");
  assert.equal(press({ key: "/", code: "Slash", ctrlKey: true }), "show-shortcuts");
});

test("letters are matched by physical key, so a Korean layout or Option still works", () => {
  assert.equal(press({ key: "ㅏ", code: "KeyK", ctrlKey: true }), "search");
  assert.equal(press({ key: "ø", code: "KeyO", metaKey: true, shiftKey: true }, true), "new-chat");
});

test("Alt chords and extra modifiers are left to the browser", () => {
  assert.equal(press({ key: "k", code: "KeyK", ctrlKey: true, altKey: true }), null);
  assert.equal(press({ key: "k", code: "KeyK", ctrlKey: true, shiftKey: true }), null);
  assert.equal(press({ key: "k", code: "KeyK", ctrlKey: true, metaKey: true }), null);
});

test("an IME composition never triggers anything", () => {
  assert.equal(press({ key: "k", code: "KeyK", ctrlKey: true, isComposing: true }), null);
  assert.equal(press({ key: "Process", code: "KeyK", ctrlKey: true, keyCode: 229 }), null);
  assert.equal(press({ key: "?", isComposing: true }), null);
});

test("single-key shortcuts stay out of text fields", () => {
  const textarea = { tagName: "TEXTAREA" };
  const input = { tagName: "INPUT", type: "text" };
  const editable = { tagName: "DIV", isContentEditable: true };
  const textbox = { tagName: "DIV", role: "textbox" };
  for (const target of [textarea, input, editable, textbox, { tagName: "SELECT" }, { tagName: "INPUT", type: "search" }]) {
    assert.equal(press({ key: "/", code: "Slash", target }), null, JSON.stringify(target));
    assert.equal(press({ key: "?", code: "Slash", shiftKey: true, target }), null, JSON.stringify(target));
  }
  // Checkboxes and buttons are not text entry.
  assert.equal(press({ key: "/", code: "Slash", target: { tagName: "INPUT", type: "checkbox" } }), "focus-composer");
  assert.equal(press({ key: "?", code: "Slash", shiftKey: true, target: { tagName: "BUTTON" } }), "show-shortcuts");
  assert.equal(press({ key: "/", code: "Slash" }), "focus-composer");
});

test("chords that do not type still work from inside the message box", () => {
  const target = { tagName: "TEXTAREA" };
  assert.equal(press({ key: "k", code: "KeyK", ctrlKey: true, target }), "search");
  assert.equal(press({ key: "Escape", code: "Escape", shiftKey: true, target }), "focus-composer");
  assert.equal(press({ key: "Escape", code: "Escape", target }), null);
});

test("held keys and handled events are ignored", () => {
  assert.equal(press({ key: "k", code: "KeyK", ctrlKey: true, repeat: true }), null);
  assert.equal(press({ key: "k", code: "KeyK", ctrlKey: true, defaultPrevented: true }), null);
});

test("text entry detection", () => {
  assert.equal(isTextEntryTarget(null), false);
  assert.equal(isTextEntryTarget({ tagName: "input", type: "" }), true);
  assert.equal(isTextEntryTarget({ tagName: "INPUT", type: "button" }), false);
});

test("the list prints Mac and Windows keys", () => {
  const windows = shortcutRows(false).find((row) => row.action === "new-chat");
  const mac = shortcutRows(true).find((row) => row.action === "new-chat");
  assert.deepEqual(windows.keys, [["Ctrl", "Shift", "O"]]);
  assert.deepEqual(mac.keys, [["⌘", "⇧", "O"]]);
  assert.equal(shortcutRows(false).length, 5);
});

test("platform detection", () => {
  assert.equal(isMacPlatform({ platform: "MacIntel" }), true);
  assert.equal(isMacPlatform({ userAgentData: { platform: "macOS" }, platform: "" }), true);
  assert.equal(isMacPlatform({ platform: "Win32" }), false);
  assert.equal(isMacPlatform({ platform: "", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)" }), true);
});
