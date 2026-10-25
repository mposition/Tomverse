import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * MOBILE-KB-INSET-01. The mobile bottom dock pays the bottom safe-area inset
 * once, after its last visible row. `env()` cannot be set from a browser test
 * (Chromium emulation reports 0), so ownership is pinned on the source: the
 * dock reserves the inset after the disclaimer and optional consent notice.
 * Neither the disclaimer nor the composer bar reserves it again.
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

test("the mobile dock reserves the bottom safe-area inset once", () => {
    const shell = read("components/chat/MobileChatShell.tsx");
    const wrapper = /data-testid="mobile-bottom-dock"\s+className="([^"]*)"/.exec(shell);
    assert.ok(wrapper, "the dock wrapper's className was not found");
    assert.equal(wrapper[1].split(INSET).length - 1, 1);
    const notice = read("components/chat/AiDisclaimerNotice.tsx");
    const row = /<p\s+data-testid=\{testId\}\s+className="([^"]*)"/.exec(notice);
    assert.ok(row, "the notice row was not found");
    assert.equal(row[1].includes(INSET), false);
});

test("the mobile dock ends with the disclaimer and optional consent after the bar composer", () => {
    const shell = read("components/chat/MobileChatShell.tsx");
    const dockOpen = shell.indexOf('data-testid="mobile-bottom-dock"');
    const notice = shell.indexOf('<AiDisclaimerNotice testId="chat-ai-disclaimer-mobile" />');
    const composer = shell.indexOf("<ChatInput", dockOpen);
    assert.ok(dockOpen > 0 && composer > dockOpen && notice > composer, "the notice no longer follows the dock's composer");
    // The dock's composer is the bar variant, the one whose padding this pins.
    assert.match(shell.slice(composer, notice), /variant="bar"/);
    // The wrapper owns the inset; rows above the footer must not duplicate it.
    assert.equal(shell.slice(dockOpen, notice).split(INSET).length - 1, 1);
    // Consent follows the disclaimer, inside the same safe-area reservation.
    assert.match(shell.slice(notice), /^<AiDisclaimerNotice testId="chat-ai-disclaimer-mobile" \/>\s*<div ref=\{setBottomConsentSlot\} data-testid="composer-consent-slot"[^>]* \/>\s*<\/div>/);
});
