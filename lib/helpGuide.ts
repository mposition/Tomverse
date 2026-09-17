/**
 * HELP-NAV-01, guided help: the user picks one of the registered intents and is
 * shown where that task is done. No question is typed, matched or stored.
 *
 * Everything the guide may offer comes from `lib/helpNavigationIntents.ts`:
 * the intents, their destinations, each destination's access conditions and
 * each step's flags. This module only judges them for one viewer and says how
 * the chosen destination is opened. It reads nothing about the user beyond
 * whether they are signed in and which flags are on, and it changes nothing.
 *
 * ## How a destination opens, and why
 *
 * The composer's unsent draft lives in memory, so any navigation of the chat
 * page would lose it. The guide therefore never navigates the page itself:
 *
 * - a settings section or tab opens the in-page settings dialog
 *   (`openAccountSettings`), with the tab the section already belongs to in
 *   `SETTINGS_SECTION_TAB` -- the same map `settingsSectionHref()` reads;
 * - a guide section or public page opens in a new tab, with the URL from
 *   `resolveHelpDestination()`, the one place a destination becomes a URL;
 * - the feedback destination opens the existing feedback dialog for the user
 *   to write in, never submitted for them;
 * - sign-in opens the sign-in page in a new tab.
 */

import type { Language } from "@/components/LanguageProvider";
import type { AccountSettingsTab } from "@/lib/accountSettingsEvents";
import {
    HELP_INTENTS,
    helpIntentForbidden,
    resolveHelpDestination,
    type HelpDestination,
    type HelpForbiddenTag,
    type HelpIntent,
} from "@/lib/helpNavigationIntents";
import { SETTINGS_SECTION_TAB } from "@/lib/settingsNavigation";

export type HelpGuideViewer = {
    signedIn: boolean;
    /** AppSetting flag keys that are on, resolved on the server. Anything absent is off. */
    enabledFlagKeys: ReadonlySet<string>;
    lang: Language;
};

export type HelpGuideAction =
    | { type: "open-settings"; tab: AccountSettingsTab; section: string | null }
    | { type: "new-tab"; href: string }
    | { type: "open-feedback" };

export type HelpGuideOffer =
    | { availability: "open"; destination: HelpDestination; action: HelpGuideAction; copyKey: string }
    | { availability: "sign-in"; destination: HelpDestination; copyKey: string }
    | { availability: "unavailable"; destination: HelpDestination; missingFlagKeys: string[]; copyKey: string };

export type HelpGuideAnswer = {
    intentId: string;
    copyKey: string;
    offers: HelpGuideOffer[];
    steps: Array<{ label: string; available: boolean }>;
    /** Carried so a renderer can refuse to add an action the intent forbids. */
    forbidden: ReadonlySet<HelpForbiddenTag>;
};

const camel = (id: string) => id.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** `helpGuide.intents.<key>` for an intent id. */
export const helpIntentCopyKey = (intentId: string) => `helpGuide.intents.${camel(intentId)}`;

/** `helpGuide.destinations...` label key for a destination. */
export const helpDestinationCopyKey = (destination: HelpDestination): string => {
    switch (destination.kind) {
        case "settings-section":
            return `helpGuide.destinations.settingsSection.${camel(destination.section)}`;
        case "settings-tab":
            return `helpGuide.destinations.settingsTab.${camel(destination.tab)}`;
        case "guide-section":
            return `helpGuide.destinations.guideSection.${camel(destination.section)}`;
        case "public-route": {
            const name = destination.path === "/support/help-centre" ? "helpCentre" : destination.path.slice(1);
            return `helpGuide.destinations.publicRoute.${name}`;
        }
        case "feedback":
            return "helpGuide.destinations.feedback";
    }
};

export const helpGuideAction = (destination: HelpDestination, lang: Language): HelpGuideAction => {
    switch (destination.kind) {
        case "settings-section":
            return { type: "open-settings", tab: SETTINGS_SECTION_TAB[destination.section], section: destination.section };
        case "settings-tab":
            return { type: "open-settings", tab: destination.tab, section: null };
        case "feedback":
            return { type: "open-feedback" };
        case "guide-section":
        case "public-route": {
            const resolved = resolveHelpDestination(destination, lang);
            if (resolved.type !== "href") throw new Error(`unexpected resolution for ${destination.kind}`);
            return { type: "new-tab", href: resolved.href };
        }
    }
};

const missingFlags = (flagKeys: readonly string[], viewer: HelpGuideViewer) =>
    flagKeys.filter((key) => !viewer.enabledFlagKeys.has(key));

export const offerHelpGuideDestination = (destination: HelpDestination, viewer: HelpGuideViewer): HelpGuideOffer => {
    const copyKey = helpDestinationCopyKey(destination);
    // Existence before entitlement: a destination whose flag is off is not
    // offered behind sign-in, because signing in would not make it exist.
    const missing = missingFlags(destination.access.flagKeys, viewer);
    if (missing.length > 0) return { availability: "unavailable", destination, missingFlagKeys: missing, copyKey };
    if (destination.access.signIn === "required" && !viewer.signedIn) return { availability: "sign-in", destination, copyKey };
    return { availability: "open", destination, action: helpGuideAction(destination, viewer.lang), copyKey };
};

export const answerHelpIntent = (intentId: string, viewer: HelpGuideViewer, intents: readonly HelpIntent[] = HELP_INTENTS): HelpGuideAnswer | null => {
    const intent = intents.find((candidate) => candidate.id === intentId);
    if (!intent) return null;
    return {
        intentId: intent.id,
        copyKey: helpIntentCopyKey(intent.id),
        offers: intent.destinations.map((destination) => offerHelpGuideDestination(destination, viewer)),
        steps: (intent.steps ?? []).map((step) => ({
            label: step.label,
            available: missingFlags(step.flagKeys, viewer).length === 0,
        })),
        forbidden: helpIntentForbidden(intent),
    };
};

/** Every flag key any registered destination or step reads: what the server must resolve. */
export const HELP_GUIDE_FLAG_KEYS: readonly string[] = Array.from(
    new Set(
        HELP_INTENTS.flatMap((intent) => [
            ...intent.destinations.flatMap((destination) => destination.access.flagKeys),
            ...(intent.steps ?? []).flatMap((step) => step.flagKeys),
        ])
    )
);
