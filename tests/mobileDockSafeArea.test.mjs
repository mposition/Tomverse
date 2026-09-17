import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * MOBILE-KB-INSET-01. The mobile bottom dock pays the bottom safe-area inset
 * once, on its last row. `env()` cannot be set from a browser test (Chromium
 * emulation reports 0), so ownership is pinned on the source: the notice that
 * ends the dock carries the inset and the composer bar above it does not.
 *
 * Whether this removes the gap seen above the keyboard on a real phone is a
 * device observation, not something this test can show.
 */

const INSET = "env(safe-area-inset-bottom)";
const read = (path) => readFileSync(path, "utf8");

const barClassName = (source) => {
    const match = /variant === "floating"\s*\?\s*"[^"]*"\s*:\s*`([^`]*)`/.exec(source);
    assert.ok(match, "the composer's bar/floating className was not found");
    return match[1];
};

test("the composer bar reserves no bottom safe-area inset", () => {
    assert.equal(barClassName(read("components/chat/ChatInput.tsx")).includes(INSET), false);
});

test("the notice that ends the mobile dock reserves it, once", () => {
    const notice = read("components/chat/AiDisclaimerNotice.tsx");
    const row = /<p\s+data-testid=\{testId\}\s+className="([^"]*)"/.exec(notice);
    assert.ok(row, "the notice row was not found");
    assert.equal(row[1].split(INSET).length - 1, 1);
});

test("the notice is still the mobile dock's last row", () => {
    const shell = read("components/chat/MobileChatShell.tsx");
    const notice = shell.indexOf('<AiDisclaimerNotice testId="chat-ai-disclaimer-mobile" />');
    const composer = shell.indexOf("<ChatInput");
    assert.ok(notice > composer && composer > 0, "the notice no longer follows the composer in the dock");
    // Nothing else is rendered between the notice and the dock's closing tag.
    assert.match(shell.slice(notice), /^<AiDisclaimerNotice testId="chat-ai-disclaimer-mobile" \/>\s*<\/div>/);
});
