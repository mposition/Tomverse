/**
 * HELP-NAV-01: turns a matched intent into what the answer offers this viewer.
 *
 * Each destination is judged on its own `access` (lib/helpNavigationIntents.ts):
 *
 * - `open`: the viewer can go there now, through `resolveHelpDestination()`.
 * - `sign-in`: the destination needs an account and the viewer is a guest.
 *   Sign-in is offered, never an upgrade.
 * - `unavailable`: a flag it needs is off. Stated as "not available right
 *   now", never as something a plan would unlock.
 *
 * Steps are judged the same way, on their own flags. Nothing here changes a
 * setting, opens anything, or reads anything but the viewer facts passed in.
 */

import type { Language } from "@/components/LanguageProvider";
import {
    HELP_INTENTS,
    helpIntentForbidden,
    resolveHelpDestination,
    type HelpDestination,
    type HelpForbiddenTag,
    type ResolvedHelpDestination,
} from "@/lib/helpNavigationIntents";
import type { HelpMatch } from "@/lib/helpNavigationMatcher";

export type HelpViewer = {
    signedIn: boolean;
    /** AppSetting flag keys that are on for this viewer. Anything absent is off. */
    enabledFlagKeys: ReadonlySet<string>;
    lang: Language;
};

export type HelpDestinationOffer =
    | { availability: "open"; destination: HelpDestination; action: ResolvedHelpDestination }
    | { availability: "sign-in"; destination: HelpDestination }
    | { availability: "unavailable"; destination: HelpDestination; missingFlagKeys: string[] };

export type HelpAnswer =
    | {
          outcome: "intent";
          intentId: string;
          offers: HelpDestinationOffer[];
          steps: Array<{ label: string; available: boolean }>;
          /** Carried so a renderer can refuse to add an action the intent forbids. */
          forbidden: ReadonlySet<HelpForbiddenTag>;
      }
    | { outcome: "clarify"; intentIds: [string, string] }
    | { outcome: "unsupported"; offers: HelpDestinationOffer[] };

const missingFlags = (flagKeys: readonly string[], viewer: HelpViewer) =>
    flagKeys.filter((key) => !viewer.enabledFlagKeys.has(key));

export const offerHelpDestination = (destination: HelpDestination, viewer: HelpViewer): HelpDestinationOffer => {
    // Existence before entitlement: a destination whose flag is off is not
    // offered behind sign-in, because signing in would not make it exist.
    const missing = missingFlags(destination.access.flagKeys, viewer);
    if (missing.length > 0) return { availability: "unavailable", destination, missingFlagKeys: missing };
    if (destination.access.signIn === "required" && !viewer.signedIn) return { availability: "sign-in", destination };
    return { availability: "open", destination, action: resolveHelpDestination(destination, viewer.lang) };
};

/** An unsupported question still gets somewhere to go: the help centre and the feedback dialog. */
const UNSUPPORTED_DESTINATIONS: HelpDestination[] = [
    { kind: "public-route", path: "/support/help-centre", access: { signIn: "not-required", flagKeys: [], plan: "not-gated" } },
    { kind: "feedback", access: { signIn: "not-required", flagKeys: [], plan: "not-gated" } },
];

export const answerHelpMatch = (match: HelpMatch, viewer: HelpViewer): HelpAnswer => {
    if (match.outcome === "clarify") return match;
    if (match.outcome === "unsupported") {
        return {
            outcome: "unsupported",
            offers: UNSUPPORTED_DESTINATIONS.map((destination) => offerHelpDestination(destination, viewer)),
        };
    }
    const intent = HELP_INTENTS.find((candidate) => candidate.id === match.intentId);
    if (!intent) {
        return {
            outcome: "unsupported",
            offers: UNSUPPORTED_DESTINATIONS.map((destination) => offerHelpDestination(destination, viewer)),
        };
    }
    return {
        outcome: "intent",
        intentId: intent.id,
        offers: intent.destinations.map((destination) => offerHelpDestination(destination, viewer)),
        steps: (intent.steps ?? []).map((step) => ({
            label: step.label,
            available: missingFlags(step.flagKeys, viewer).length === 0,
        })),
        forbidden: helpIntentForbidden(intent),
    };
};
