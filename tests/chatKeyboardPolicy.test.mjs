import assert from "node:assert/strict";
import test from "node:test";

import {
  getChatEnterKeyAction,
  isComposingKeydown,
} from "../lib/chatKeyboardPolicy.ts";

const key = (overrides = {}) => ({
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  ...overrides,
});

test("PC shell: plain Enter submits", () => {
  assert.equal(getChatEnterKeyAction(key(), false, false), "submit");
});

test("PC shell: Shift+Enter never submits", () => {
  assert.equal(
    getChatEnterKeyAction(key({ shiftKey: true }), false, false),
    "default"
  );
});

test("PC shell: Ctrl+Enter and Cmd+Enter also submit", () => {
  assert.equal(
    getChatEnterKeyAction(key({ ctrlKey: true }), false, false),
    "submit"
  );
  assert.equal(
    getChatEnterKeyAction(key({ metaKey: true }), false, false),
    "submit"
  );
});

test("PC shell: Enter during IME composition never submits", () => {
  assert.equal(getChatEnterKeyAction(key(), true, false), "default");
});

test("PC shell: non-Enter keys never submit", () => {
  assert.equal(getChatEnterKeyAction(key({ key: "a" }), false, false), "default");
});

test("mobile shell: plain Enter never submits (newline instead)", () => {
  assert.equal(getChatEnterKeyAction(key(), false, true), "default");
});

test("mobile shell: Shift+Enter never submits", () => {
  assert.equal(
    getChatEnterKeyAction(key({ shiftKey: true }), false, true),
    "default"
  );
});

test("mobile shell: Ctrl+Enter submits for external keyboards", () => {
  assert.equal(
    getChatEnterKeyAction(key({ ctrlKey: true }), false, true),
    "submit"
  );
});

test("mobile shell: Cmd+Enter submits for external keyboards", () => {
  assert.equal(
    getChatEnterKeyAction(key({ metaKey: true }), false, true),
    "submit"
  );
});

test("mobile shell: Ctrl+Enter during IME composition never submits", () => {
  assert.equal(
    getChatEnterKeyAction(key({ ctrlKey: true }), true, true),
    "default"
  );
});

test("isComposingKeydown reads nativeEvent.isComposing", () => {
  assert.equal(
    isComposingKeydown({ nativeEvent: { isComposing: true } }),
    true
  );
  assert.equal(
    isComposingKeydown({ nativeEvent: { isComposing: false } }),
    false
  );
});

test("isComposingKeydown falls back to legacy keyCode 229", () => {
  assert.equal(
    isComposingKeydown({ nativeEvent: {}, keyCode: 229 }),
    true
  );
  assert.equal(
    isComposingKeydown({ nativeEvent: {}, keyCode: 13 }),
    false
  );
});
