import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import {
    HELP_FLAG_KEYS,
    HELP_GLOBAL_FORBIDDEN,
    HELP_GUIDE_SECTION_IDS,
    HELP_INTENTS,
    HELP_INTENT_COUNT_RANGE,
    HELP_INTENT_IDS,
    HELP_NAVIGATION_REGISTRY_VERSION,
    HELP_PUBLIC_ROUTES,
    helpIntentForbidden,
    helpNavigationRegistryProblems,
    resolveHelpDestination,
} from "../lib/helpNavigationIntents.ts";
import { chatWorkspaceGuideContent } from "../components/marketing/chatWorkspaceGuideContent.ts";
import { EXTERNAL_IMPORT_FLAG_KEY } from "../lib/externalImportAccess.ts";
import { EXTERNAL_CONTINUATION_FLAG_KEY } from "../lib/externalContinuationAccess.ts";
import { isStaticMarketingPathname } from "../lib/marketingRoutes.ts";
import { SETTINGS_SECTION_TAB, parseSettingsDeepLink } from "../lib/settingsNavigation.ts";

/**
 * HELP-NAV-01. The registry is prepared before any help UI exists, so what is
 * pinned now is that every destination it names resolves through the app's own
 * navigation functions, every condition is the flag the product reads, and the
 * prohibitions an answer must honour are machine-checked rather than a comment.
 */

const answerKey = JSON.parse(readFileSync("docs/ops/help-nav/answer-key.v2.json", "utf8"));
const intent = (id) => HELP_INTENTS.find((candidate) => candidate.id === id);

test("the registry has no structural problems and stays within the approved size", () => {
    assert.deepEqual(helpNavigationRegistryProblems(), []);
    assert.equal(HELP_NAVIGATION_REGISTRY_VERSION, "help-nav-intents-v2");
    assert.ok(HELP_INTENTS.length >= HELP_INTENT_COUNT_RANGE.min && HELP_INTENTS.length <= HELP_INTENT_COUNT_RANGE.max);
    assert.equal(answerKey.registry, HELP_NAVIGATION_REGISTRY_VERSION);
    assert.equal(answerKey.version, "help-nav-answer-key-v2");
});

test("the structural check refuses a guest-reachable settings destination, even a secondary one", () => {
    const broken = structuredClone(HELP_INTENTS);
    broken.find((candidate) => candidate.id === "billing-and-refund").destinations[1].access.signIn = "not-required";
    assert.ok(helpNavigationRegistryProblems(broken).some((problem) => problem.includes("does not require sign-in")));
});

test("every settings destination resolves to the deep link settings itself parses", () => {
    for (const { destinations, id } of HELP_INTENTS) {
        for (const destination of destinations) {
            const resolved = resolveHelpDestination(destination, "ko");
            if (destination.kind === "settings-section") {
                assert.equal(resolved.type, "href", id);
                const url = new URL(resolved.href, "https://tomverse.app");
                assert.equal(url.pathname, "/chat", id);
                const parsed = parseSettingsDeepLink(url.search);
                assert.equal(parsed?.section, destination.section, id);
                assert.equal(parsed?.tab, SETTINGS_SECTION_TAB[destination.section], id);
            }
            if (destination.kind === "settings-tab") {
                assert.deepEqual(resolved, { type: "open-settings-tab", tab: destination.tab }, id);
            }
            if (destination.kind === "feedback") {
                assert.deepEqual(resolved, { type: "open-feedback" }, id);
            }
        }
    }
});

test("every guide destination resolves to an anchor that exists in every guide language", () => {
    for (const [lang, copy] of Object.entries(chatWorkspaceGuideContent)) {
        const ids = new Set(copy.sections.map((section) => section.id));
        for (const id of HELP_GUIDE_SECTION_IDS) assert.ok(ids.has(id), `${lang} guide has no #${id}`);
        for (const candidate of HELP_INTENTS) {
            for (const destination of candidate.destinations.filter((d) => d.kind === "guide-section")) {
                const resolved = resolveHelpDestination(destination, lang);
                const url = new URL(resolved.href, "https://tomverse.app");
                assert.equal(url.pathname, "/support/help-centre/chat-workspace");
                assert.equal(url.hash, `#${destination.section}`);
                assert.equal(url.searchParams.get("lang"), lang);
            }
        }
    }
});

test("every public route is a static marketing page and needs no account", () => {
    for (const path of HELP_PUBLIC_ROUTES) assert.equal(isStaticMarketingPathname(path), true, path);
    for (const candidate of HELP_INTENTS) {
        for (const destination of candidate.destinations.filter((d) => d.kind === "public-route")) {
            assert.equal(destination.access.signIn, "not-required", candidate.id);
            assert.equal(isStaticMarketingPathname(destination.path), true, candidate.id);
        }
    }
    for (const candidate of HELP_INTENTS) {
        for (const destination of candidate.destinations.filter((d) => d.kind === "public-route")) {
            for (const lang of Object.keys(chatWorkspaceGuideContent)) {
                const resolved = resolveHelpDestination(destination, lang);
                assert.equal(resolved.type, "href", candidate.id);
                const url = new URL(resolved.href, "https://tomverse.app");
                // Same origin, the registered path, the reader's language, nothing else.
                assert.equal(url.origin, "https://tomverse.app", candidate.id);
                assert.equal(url.pathname, destination.path, candidate.id);
                assert.equal(url.searchParams.get("lang"), lang, candidate.id);
                assert.deepEqual([...url.searchParams.keys()], ["lang"], candidate.id);
                assert.equal(url.hash, "", candidate.id);
            }
        }
    }
    assert.ok(
        HELP_INTENTS.some((candidate) => candidate.destinations.some((d) => d.kind === "public-route" && d.path === "/pricing")),
        "a guest can reach plan comparison"
    );
});

test("flag conditions are the keys the product reads, and the ones it reads are required", () => {
    assert.equal(HELP_FLAG_KEYS.externalImport, EXTERNAL_IMPORT_FLAG_KEY);
    assert.equal(HELP_FLAG_KEYS.externalContinuation, EXTERNAL_CONTINUATION_FLAG_KEY);
    const imports = intent("imported-conversations");
    assert.deepEqual(imports.destinations[0].access.flagKeys, [EXTERNAL_IMPORT_FLAG_KEY]);
    assert.deepEqual(imports.steps.find((step) => step.label === "import").flagKeys, [EXTERNAL_IMPORT_FLAG_KEY]);
    assert.deepEqual(
        imports.steps.find((step) => step.label === "continue").flagKeys.sort(),
        [EXTERNAL_CONTINUATION_FLAG_KEY, EXTERNAL_IMPORT_FLAG_KEY].sort()
    );
    // No destination depends on a plan to open.
    for (const candidate of HELP_INTENTS) {
        for (const destination of candidate.destinations) assert.equal(destination.access.plan, "not-gated", candidate.id);
    }
});

test("evidence names a repository file, and guide anchors in evidence exist", () => {
    for (const candidate of HELP_INTENTS) {
        for (const evidence of candidate.evidence) {
            const [path, anchor] = evidence.split("#");
            assert.ok(existsSync(path) && statSync(path).isFile(), `${candidate.id}: ${path} is not a file`);
            if (anchor) assert.ok(HELP_GUIDE_SECTION_IDS.includes(anchor), `${candidate.id}: unknown anchor #${anchor}`);
        }
    }
});

/*
  Written out here, not read from the module: a test that compares a constant
  with itself passes whatever the constant loses. Removing a prohibition has to
  be a change to this list as well, in the same review.
*/
const EXPECTED_GLOBAL_FORBIDDEN = [
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

const EXPECTED_INTENT_FORBIDDEN = {
    "imported-conversations": ["upload-file", "start-continuation", "lock-or-unlock", "download"],
    "manage-memory": ["read-memory", "delete", "change-setting"],
    "choose-models": ["change-setting", "state-price-from-docs"],
    "ai-review": ["run-paid-work", "read-review-results", "state-price-from-docs"],
    "attach-files": ["upload-file", "read-attachments"],
    projects: ["change-setting", "read-conversation-content"],
    "lock-or-share": ["lock-or-unlock", "share", "read-conversation-content"],
    "credits-and-plan": ["purchase", "state-account-balance", "state-price-from-docs"],
    "billing-and-refund": ["purchase", "state-account-balance"],
    "email-notifications": ["change-setting"],
    "export-or-delete-account-data": ["download", "delete"],
    "report-a-problem": ["submit-feedback", "read-conversation-content", "read-attachments"],
};

test("the global prohibitions are exactly the reviewed list", () => {
    assert.deepEqual([...HELP_GLOBAL_FORBIDDEN].sort(), [...EXPECTED_GLOBAL_FORBIDDEN].sort());
});

test("each intent's own prohibitions are exactly the reviewed list, and all of them apply", () => {
    assert.deepEqual(Object.keys(EXPECTED_INTENT_FORBIDDEN).sort(), [...HELP_INTENT_IDS].sort());
    for (const candidate of HELP_INTENTS) {
        assert.deepEqual([...candidate.forbidden].sort(), [...EXPECTED_INTENT_FORBIDDEN[candidate.id]].sort(), candidate.id);
        const applied = helpIntentForbidden(candidate);
        for (const tag of [...EXPECTED_GLOBAL_FORBIDDEN, ...EXPECTED_INTENT_FORBIDDEN[candidate.id]]) {
            assert.ok(applied.has(tag), `${candidate.id} does not apply ${tag}`);
        }
    }
});

test("the answer key names only registered intents, one expectation per case", () => {
    const ids = new Set(HELP_INTENT_IDS);
    const caseIds = new Set();
    for (const entry of answerKey.cases) {
        assert.ok(!caseIds.has(entry.id), `duplicate case ${entry.id}`);
        caseIds.add(entry.id);
        assert.ok(["dev", "holdout"].includes(entry.split), entry.id);
        assert.ok(["ko", "en"].includes(entry.lang), entry.id);
        const kinds = ["expect", "clarify", "unsupported"].filter((key) => key in entry);
        assert.equal(kinds.length, 1, `${entry.id} must have exactly one expectation`);
        if (entry.expect) assert.ok(ids.has(entry.expect), `${entry.id}: unknown intent ${entry.expect}`);
        if (entry.clarify) {
            assert.ok(entry.clarify.length >= 2, `${entry.id}: a clarification offers at least two intents`);
            for (const id of entry.clarify) assert.ok(ids.has(id), `${entry.id}: unknown intent ${id}`);
            assert.ok(entry.why, `${entry.id}: a clarification says why it is ambiguous`);
        }
        if (entry.unsupported) assert.ok(entry.why, `${entry.id}: a refusal says why`);
    }
});

test("dev and holdout are kept apart and holdout is not a reworded copy of dev", () => {
    const words = (question) => new Set(question.toLowerCase().split(/\s+/u).filter((word) => word.length > 1));
    const dev = answerKey.cases.filter((entry) => entry.split === "dev");
    for (const entry of answerKey.cases.filter((c) => c.split === "holdout")) {
        for (const other of dev) {
            const a = words(entry.question);
            const b = words(other.question);
            const shared = [...a].filter((word) => b.has(word)).length;
            const overlap = shared / Math.max(1, Math.min(a.size, b.size));
            assert.ok(overlap < 0.6, `${entry.id} shares most of its words with ${other.id}`);
        }
    }
});

test("each intent is expected in both splits, and both splits carry clarifications, refusals and English", () => {
    for (const candidate of HELP_INTENTS) {
        for (const split of ["dev", "holdout"]) {
            assert.ok(
                answerKey.cases.some((entry) => entry.split === split && entry.expect === candidate.id),
                `${candidate.id} has no ${split} case`
            );
        }
    }
    for (const split of ["dev", "holdout"]) {
        const cases = answerKey.cases.filter((entry) => entry.split === split);
        assert.ok(cases.some((entry) => entry.clarify), `${split} has no clarification case`);
        assert.ok(cases.some((entry) => entry.unsupported), `${split} has no refusal case`);
        assert.ok(cases.some((entry) => entry.lang === "en" && entry.unsupported), `${split} has no English refusal`);
    }
});
