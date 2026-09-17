/**
 * HELP-NAV-01: the reviewed registry of "I want to do X" intents an in-product
 * help assistant may answer, and where each one is allowed to send the user.
 *
 * Nothing renders this yet. `lib/helpNavigationMatcher.ts` matches questions
 * against it without a model and `lib/helpNavigationAnswer.ts` judges each
 * destination for a viewer; the launcher and sheet wait for the mobile composer
 * work (docs/ops/help-nav/README.md). What exists now is the part that has to be
 * right before any UI: which intents are answered at all, which destination
 * each resolves to, and what has to be true for that destination to be offered.
 *
 * ## Destinations are ids, never URLs
 *
 * A destination names a settings section, a settings tab, a Chat workspace
 * guide section or one public route, and is turned into a link or an action
 * only by `resolveHelpDestination()`, which calls the existing
 * `settingsSectionHref()` and `chatWorkspaceGuideHref()` -- so a synonym list,
 * a typo or a future model can never produce a URL.
 *
 * ## Conditions belong to a destination, not to an intent
 *
 * One answer can point at a public page and at a signed-in settings tab, so
 * each destination carries its own `access`: whether it needs an account,
 * which AppSetting flags must be on, and whether a plan decides anything. A
 * flag that is off is "not available", never "upgrade to get it"; a guest is
 * offered sign-in before anything that needs an account. No destination here is
 * plan-gated to open; where a plan limits what happens *inside* it, the page
 * and its server checks decide, and the answer says so rather than guessing.
 *
 * A step inside an intent can need a flag its destination does not -- importing
 * needs the import flag, continuing an import also needs the continuation flag
 * -- so `steps` carry their own flags too.
 *
 * ## What an answer may never do
 *
 * `HELP_GLOBAL_FORBIDDEN` applies to every intent. Each intent adds the
 * specific tempting actions for its own area, and
 * `tests/helpNavigationIntents.test.mjs` requires them.
 */

import { ACCOUNT_SETTINGS_TABS, type AccountSettingsTab } from "@/lib/accountSettingsEvents";
import { chatWorkspaceGuideHref } from "@/lib/localizedHelpHref";
import { SETTINGS_SECTION_IDS, settingsSectionHref, type SettingsSectionId } from "@/lib/settingsNavigation";
import type { Language } from "@/components/LanguageProvider";

export const HELP_NAVIGATION_REGISTRY_VERSION = "help-nav-intents-v2";

/** The approved size of the first registry (backlog HELP-NAV-01: 8 to 12 intents). */
export const HELP_INTENT_COUNT_RANGE = { min: 8, max: 12 } as const;

/** The Chat workspace guide's section anchors (components/marketing/chatWorkspaceGuideContent.ts). */
export const HELP_GUIDE_SECTION_IDS = [
    "states-and-labels",
    "projects",
    "lock-and-share",
    "models-and-panels",
    "ai-review",
    "files-and-drive",
    "credits-and-plans",
    "troubleshooting",
] as const;
export type HelpGuideSectionId = (typeof HELP_GUIDE_SECTION_IDS)[number];

/** Public pages an answer may link to. Each is a static marketing route. */
export const HELP_PUBLIC_ROUTES = ["/pricing", "/refund", "/support/help-centre"] as const;
export type HelpPublicRoute = (typeof HELP_PUBLIC_ROUTES)[number];

export const HELP_FLAG_KEYS = {
    externalImport: "feature.externalConversationImportEnabled",
    externalContinuation: "feature.externalConversationContinuationEnabled",
} as const;

export type HelpAccess = {
    signIn: "required" | "not-required";
    flagKeys: string[];
    /** `not-gated`: no plan decides whether this opens. Nothing in v2 is plan-gated to open. */
    plan: "not-gated";
};

const PUBLIC: HelpAccess = { signIn: "not-required", flagKeys: [], plan: "not-gated" };
const ACCOUNT: HelpAccess = { signIn: "required", flagKeys: [], plan: "not-gated" };

export type HelpDestination = { access: HelpAccess } & (
    | { kind: "settings-section"; section: SettingsSectionId }
    | { kind: "settings-tab"; tab: AccountSettingsTab }
    | { kind: "guide-section"; section: HelpGuideSectionId }
    | { kind: "public-route"; path: HelpPublicRoute }
    /** The existing feedback dialog, opened for the user to write in. Never submitted for them. */
    | { kind: "feedback" }
);

/**
 * Machine-readable prohibitions. Read-* tags name data the help assistant may
 * not read or send anywhere; the rest name actions it may not take for the user.
 */
export const HELP_FORBIDDEN_TAGS = [
    "read-conversation-content",
    "read-imported-content",
    "read-memory",
    "read-attachments",
    "read-draft",
    "read-profile-knowledge",
    "read-review-results",
    "change-setting",
    "delete",
    "share",
    "download",
    "purchase",
    "run-paid-work",
    "submit-feedback",
    "state-account-balance",
    "state-price-from-docs",
    "lock-or-unlock",
    "upload-file",
    "start-continuation",
    "reveal-admin-routes",
] as const;
export type HelpForbiddenTag = (typeof HELP_FORBIDDEN_TAGS)[number];

/** Every intent inherits these. */
export const HELP_GLOBAL_FORBIDDEN: readonly HelpForbiddenTag[] = [
    "read-conversation-content",
    "read-imported-content",
    "read-memory",
    "read-attachments",
    "read-draft",
    "read-profile-knowledge",
    "read-review-results",
    "change-setting",
    "delete",
    "share",
    "purchase",
    "run-paid-work",
    "submit-feedback",
    "reveal-admin-routes",
];

export type HelpIntent = {
    id: string;
    /** What the answer says the user can do, as a reviewer reads it. Draft, not product copy. */
    summary: string;
    /** The destinations offered, in order. Each one is offered only when its own access holds. */
    destinations: HelpDestination[];
    /** Steps whose availability differs from the destination's. */
    steps?: Array<{ label: string; flagKeys: string[] }>;
    /** Where the guidance comes from: a repository file, optionally `#guide-section`. */
    evidence: string[];
    /** Area-specific prohibitions on top of `HELP_GLOBAL_FORBIDDEN`. */
    forbidden: HelpForbiddenTag[];
};

export const HELP_INTENTS: readonly HelpIntent[] = [
    {
        id: "imported-conversations",
        summary: "Import conversations from another AI, then continue one in Tomverse.",
        destinations: [
            {
                kind: "settings-section",
                section: "external-import",
                access: { signIn: "required", flagKeys: [HELP_FLAG_KEYS.externalImport], plan: "not-gated" },
            },
        ],
        steps: [
            { label: "import", flagKeys: [HELP_FLAG_KEYS.externalImport] },
            { label: "continue", flagKeys: [HELP_FLAG_KEYS.externalImport, HELP_FLAG_KEYS.externalContinuation] },
        ],
        evidence: ["docs/policy/external-conversation-import-and-memory.md", "docs/policy/external-conversation-continuation.md"],
        forbidden: ["upload-file", "start-continuation", "lock-or-unlock", "download"],
    },
    {
        id: "manage-memory",
        summary: "See, correct or delete what the account remembers.",
        destinations: [{ kind: "settings-section", section: "memory", access: ACCOUNT }],
        evidence: ["docs/policy/external-conversation-import-and-memory.md"],
        forbidden: ["read-memory", "delete", "change-setting"],
    },
    {
        id: "choose-models",
        summary: "Pick one model for a focused answer or up to three to compare side by side.",
        destinations: [{ kind: "guide-section", section: "models-and-panels", access: PUBLIC }],
        evidence: ["components/marketing/chatWorkspaceGuideContent.ts#models-and-panels"],
        forbidden: ["change-setting", "state-price-from-docs"],
    },
    {
        id: "ai-review",
        summary: "Cross-check two or three finished answers with AI Review.",
        destinations: [{ kind: "guide-section", section: "ai-review", access: PUBLIC }],
        evidence: ["components/marketing/chatWorkspaceGuideContent.ts#ai-review"],
        forbidden: ["run-paid-work", "read-review-results", "state-price-from-docs"],
    },
    {
        id: "attach-files",
        summary: "Attach files or connect Google Drive to a question.",
        destinations: [{ kind: "guide-section", section: "files-and-drive", access: PUBLIC }],
        evidence: ["components/marketing/chatWorkspaceGuideContent.ts#files-and-drive", "docs/policy/chat-attachment-formats.md"],
        forbidden: ["upload-file", "read-attachments"],
    },
    {
        id: "projects",
        summary: "Group conversations into a project.",
        destinations: [{ kind: "guide-section", section: "projects", access: PUBLIC }],
        evidence: ["components/marketing/chatWorkspaceGuideContent.ts#projects"],
        forbidden: ["change-setting", "read-conversation-content"],
    },
    {
        id: "lock-or-share",
        summary: "Lock a conversation with a password, or share a read-only snapshot.",
        destinations: [{ kind: "guide-section", section: "lock-and-share", access: PUBLIC }],
        evidence: ["components/marketing/chatWorkspaceGuideContent.ts#lock-and-share"],
        forbidden: ["lock-or-unlock", "share", "read-conversation-content"],
    },
    {
        id: "credits-and-plan",
        summary: "Understand credits, see the account's plan, or compare plans before signing in.",
        destinations: [
            { kind: "settings-tab", tab: "plan", access: ACCOUNT },
            { kind: "guide-section", section: "credits-and-plans", access: PUBLIC },
            { kind: "public-route", path: "/pricing", access: PUBLIC },
        ],
        evidence: ["components/marketing/chatWorkspaceGuideContent.ts#credits-and-plans", "docs/policy/credit-and-cost-limits.md"],
        forbidden: ["purchase", "state-account-balance", "state-price-from-docs"],
    },
    {
        id: "billing-and-refund",
        summary: "Read the refund policy, and where the account's billing is managed.",
        destinations: [
            { kind: "public-route", path: "/refund", access: PUBLIC },
            { kind: "settings-tab", tab: "plan", access: ACCOUNT },
        ],
        evidence: ["app/(site)/(marketing)/refund/page.tsx"],
        forbidden: ["purchase", "state-account-balance"],
    },
    {
        id: "email-notifications",
        summary: "Choose which emails the account receives.",
        destinations: [{ kind: "settings-section", section: "email-notifications", access: ACCOUNT }],
        evidence: ["docs/policy/email-notifications.md"],
        forbidden: ["change-setting"],
    },
    {
        id: "export-or-delete-account-data",
        summary: "Download the account's data or delete the account.",
        destinations: [{ kind: "settings-section", section: "account-data", access: ACCOUNT }],
        evidence: ["docs/policy/user-attachment-persistence.md"],
        forbidden: ["download", "delete"],
    },
    {
        id: "report-a-problem",
        summary: "Report something that is not working, with what to keep for support.",
        destinations: [
            { kind: "feedback", access: PUBLIC },
            { kind: "guide-section", section: "troubleshooting", access: PUBLIC },
        ],
        evidence: ["components/marketing/chatWorkspaceGuideContent.ts#troubleshooting", "docs/policy/trace-feedback-automation.md"],
        forbidden: ["submit-feedback", "read-conversation-content", "read-attachments"],
    },
];

export const HELP_INTENT_IDS: readonly string[] = HELP_INTENTS.map((intent) => intent.id);

/** Every prohibition that applies to an intent. */
export const helpIntentForbidden = (intent: HelpIntent): Set<HelpForbiddenTag> =>
    new Set([...HELP_GLOBAL_FORBIDDEN, ...intent.forbidden]);

export type ResolvedHelpDestination =
    | { type: "href"; href: string }
    | { type: "open-settings-tab"; tab: AccountSettingsTab }
    | { type: "open-feedback" };

/**
 * The only way a destination becomes something clickable. Settings sections and
 * guide anchors go through the functions the rest of the app uses, so a moved
 * settings row or a renamed anchor changes here with them.
 */
export const resolveHelpDestination = (destination: HelpDestination, lang: Language): ResolvedHelpDestination => {
    switch (destination.kind) {
        case "settings-section":
            return { type: "href", href: settingsSectionHref(destination.section) };
        case "settings-tab":
            return { type: "open-settings-tab", tab: destination.tab };
        case "guide-section":
            return { type: "href", href: chatWorkspaceGuideHref(lang, destination.section) };
        case "public-route":
            return { type: "href", href: `${destination.path}?lang=${lang}` };
        case "feedback":
            return { type: "open-feedback" };
    }
};

/** Structural problems with the registry; the test asserts this is empty. */
export const helpNavigationRegistryProblems = (intents: readonly HelpIntent[] = HELP_INTENTS): string[] => {
    const problems: string[] = [];
    const seen = new Set<string>();
    if (intents.length < HELP_INTENT_COUNT_RANGE.min || intents.length > HELP_INTENT_COUNT_RANGE.max) {
        problems.push(`registry has ${intents.length} intents, outside ${HELP_INTENT_COUNT_RANGE.min}-${HELP_INTENT_COUNT_RANGE.max}`);
    }
    for (const intent of intents) {
        if (seen.has(intent.id)) problems.push(`${intent.id}: duplicate id`);
        seen.add(intent.id);
        if (intent.destinations.length === 0) problems.push(`${intent.id}: no destination`);
        if (intent.evidence.length === 0) problems.push(`${intent.id}: no evidence`);
        for (const tag of intent.forbidden) {
            if (!(HELP_FORBIDDEN_TAGS as readonly string[]).includes(tag)) problems.push(`${intent.id}: unknown forbidden tag ${tag}`);
        }
        for (const destination of intent.destinations) {
            if (
                destination.kind === "settings-section" &&
                !(SETTINGS_SECTION_IDS as readonly string[]).includes(destination.section)
            ) {
                problems.push(`${intent.id}: unknown settings section ${destination.section}`);
            }
            if (
                destination.kind === "settings-tab" &&
                !(ACCOUNT_SETTINGS_TABS as readonly string[]).includes(destination.tab)
            ) {
                problems.push(`${intent.id}: unknown settings tab ${destination.tab}`);
            }
            // Every settings destination, primary or not, is an account surface.
            if (
                (destination.kind === "settings-section" || destination.kind === "settings-tab") &&
                destination.access.signIn !== "required"
            ) {
                problems.push(`${intent.id}: a settings destination that does not require sign-in`);
            }
        }
        if (!intent.destinations.some((destination) => destination.access.signIn === "not-required")) {
            // Fine for account intents, but a guest must then be offered sign-in, never a dead end.
            if (intent.destinations.some((destination) => destination.kind === "public-route")) {
                problems.push(`${intent.id}: a public route behind sign-in`);
            }
        }
    }
    return problems;
};
