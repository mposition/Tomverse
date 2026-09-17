import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    HELP_FLAG_KEYS,
    HELP_INTENTS,
    resolveHelpDestination,
} from "../lib/helpNavigationIntents.ts";
import { SETTINGS_SECTION_TAB } from "../lib/settingsNavigation.ts";
import {
    HELP_GUIDE_FLAG_KEYS,
    answerHelpIntent,
    helpDestinationCopyKey,
    helpIntentCopyKey,
} from "../lib/helpGuide.ts";
import { en } from "../locales/en.ts";
import { ko } from "../locales/ko.ts";
import { zh } from "../locales/zh.ts";
import { fr } from "../locales/fr.ts";
import { de } from "../locales/de.ts";
import { es } from "../locales/es.ts";
import { pt } from "../locales/pt.ts";

/**
 * HELP-NAV-01 guided help. The guide offers only what the reviewed registry
 * says, judged per destination, opened without navigating the chat page, and
 * worded in every locale.
 */

const LOCALES = { en, ko, zh, fr, de, es, pt };
const lookup = (dictionary, key) => key.split(".").reduce((node, part) => node?.[part], dictionary);

const GUEST = { signedIn: false, enabledFlagKeys: new Set(), lang: "ko" };
const MEMBER = { signedIn: true, enabledFlagKeys: new Set(), lang: "ko" };
const ALL_FLAGS = new Set(Object.values(HELP_FLAG_KEYS));
const VIEWERS = [GUEST, MEMBER, { ...MEMBER, enabledFlagKeys: ALL_FLAGS }, { ...GUEST, enabledFlagKeys: ALL_FLAGS, lang: "en" }];

test("every intent, destination and step has non-empty copy in all seven locales", () => {
    const keys = new Set(["helpGuide.menuItem", "helpGuide.title", "helpGuide.intro", "helpGuide.signInRequired", "helpGuide.unavailable"]);
    for (const intent of HELP_INTENTS) {
        keys.add(`${helpIntentCopyKey(intent.id)}.label`);
        keys.add(`${helpIntentCopyKey(intent.id)}.guide`);
        for (const destination of intent.destinations) keys.add(helpDestinationCopyKey(destination));
        for (const step of intent.steps ?? []) keys.add(`helpGuide.steps.${step.label}`);
    }
    for (const [lang, dictionary] of Object.entries(LOCALES)) {
        for (const key of keys) {
            const value = lookup(dictionary, key);
            assert.equal(typeof value, "string", `${lang}: ${key} is missing`);
            assert.ok(value.trim().length > 0, `${lang}: ${key} is empty`);
        }
    }
});

test("availability is judged per destination: flag before sign-in, then open", () => {
    for (const intent of HELP_INTENTS) {
        for (const viewer of VIEWERS) {
            const answer = answerHelpIntent(intent.id, viewer);
            assert.equal(answer.offers.length, intent.destinations.length, intent.id);
            answer.offers.forEach((offer, index) => {
                const destination = intent.destinations[index];
                assert.deepEqual(offer.destination, destination);
                const missing = destination.access.flagKeys.filter((key) => !viewer.enabledFlagKeys.has(key));
                const expected =
                    missing.length > 0
                        ? "unavailable"
                        : destination.access.signIn === "required" && !viewer.signedIn
                          ? "sign-in"
                          : "open";
                assert.equal(offer.availability, expected, `${intent.id} ${destination.kind}`);
                if (offer.availability !== "open") assert.equal("action" in offer, false);
            });
        }
    }
});

test("an open destination never navigates the chat page", () => {
    for (const intent of HELP_INTENTS) {
        for (const viewer of VIEWERS) {
            for (const offer of answerHelpIntent(intent.id, viewer).offers) {
                if (offer.availability !== "open") continue;
                const { destination, action } = offer;
                if (destination.kind === "settings-section") {
                    assert.deepEqual(action, {
                        type: "open-settings",
                        tab: SETTINGS_SECTION_TAB[destination.section],
                        section: destination.section,
                    });
                } else if (destination.kind === "settings-tab") {
                    assert.deepEqual(action, { type: "open-settings", tab: destination.tab, section: null });
                } else if (destination.kind === "feedback") {
                    assert.deepEqual(action, { type: "open-feedback" });
                } else {
                    // A reading page opens in a new tab, and its URL comes from the
                    // registry's one resolver.
                    assert.deepEqual(action, { type: "new-tab", href: resolveHelpDestination(destination, viewer.lang).href });
                }
            }
        }
    }
});

test("steps follow their own flags", () => {
    const off = answerHelpIntent("imported-conversations", MEMBER);
    assert.deepEqual(off.steps, [
        { label: "import", available: false },
        { label: "continue", available: false },
    ]);
    const importOnly = answerHelpIntent("imported-conversations", {
        ...MEMBER,
        enabledFlagKeys: new Set([HELP_FLAG_KEYS.externalImport]),
    });
    assert.deepEqual(importOnly.steps, [
        { label: "import", available: true },
        { label: "continue", available: false },
    ]);
});

test("the server resolves exactly the flags the registry reads", () => {
    assert.deepEqual([...HELP_GUIDE_FLAG_KEYS].sort(), Object.values(HELP_FLAG_KEYS).sort());
    const shell = readFileSync("components/chat/ReviewWorkspaceShell.tsx", "utf8");
    for (const name of Object.keys(HELP_FLAG_KEYS)) {
        assert.match(shell, new RegExp(`HELP_FLAG_KEYS\\.${name}`), `ReviewWorkspaceShell does not resolve ${name}`);
    }
});

test("an unknown intent id yields no answer", () => {
    assert.equal(answerHelpIntent("does-not-exist", MEMBER), null);
});

test("the guide has no free-text input and reaches no matcher", () => {
    const dialog = readFileSync("components/chat/HelpGuideDialog.tsx", "utf8");
    assert.doesNotMatch(dialog, /<input|<textarea|contentEditable/);
    assert.doesNotMatch(dialog, /helpNavigationMatcher|matchHelpQuestion|fetch\(/);
});
