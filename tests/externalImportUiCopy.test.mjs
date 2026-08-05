import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { de } from "../locales/de.ts";
import { en } from "../locales/en.ts";
import { es } from "../locales/es.ts";
import { fr } from "../locales/fr.ts";
import { ko } from "../locales/ko.ts";
import { pt } from "../locales/pt.ts";
import { zh } from "../locales/zh.ts";

/**
 * docs/policy/external-conversation-import-and-memory.md §16, §17, §21.
 *
 * The Release A import UI ships with copy in all seven locales, checked
 * statically — the seven-locale render matrix is deliberately not an E2E
 * concern. Beyond parity, two product rules are enforced here: the feature's
 * name must not collide with the guest-conversation import that already
 * lives in the Data tab, and no locale may promise memory features that
 * Release A does not have.
 */

const LOCALES = { ko, en, zh, fr, de, es, pt };

// French pluralizes these two exactly like English ("{count} messages"),
// so the not-English check would misread a correct translation.
const ENGLISH_HOMOGRAPH_KEYS = new Set([
    "fr.messagesCount",
    "fr.historyConversations",
]);

test("every supported locale carries every external import UI key", () => {
    const englishKeys = Object.keys(en.externalImport);
    assert.ok(englishKeys.length > 0);
    for (const [name, bundle] of Object.entries(LOCALES)) {
        for (const key of englishKeys) {
            const value = bundle.externalImport?.[key];
            assert.equal(
                typeof value,
                "string",
                `${name}.externalImport.${key} must exist`
            );
            assert.ok(
                value.trim().length > 0,
                `${name}.externalImport.${key} must not be empty`
            );
        }
    }
});

test("no locale silently reuses the English copy", () => {
    for (const [name, bundle] of Object.entries(LOCALES)) {
        if (name === "en") continue;
        for (const [key, english] of Object.entries(en.externalImport)) {
            if (ENGLISH_HOMOGRAPH_KEYS.has(`${name}.${key}`)) continue;
            assert.notEqual(
                bundle.externalImport[key],
                english,
                `${name}.externalImport.${key} must not duplicate the English copy`
            );
        }
    }
});

test("placeholders survive translation", () => {
    // Interpolation is plain string replacement, so a translated string that
    // drops or renames a {placeholder} renders the raw token to the user.
    const placeholderPattern = /\{[a-zA-Z]+\}/g;
    for (const [key, english] of Object.entries(en.externalImport)) {
        const expected = [...english.matchAll(placeholderPattern)]
            .map((match) => match[0])
            .sort();
        if (expected.length === 0) continue;
        for (const [name, bundle] of Object.entries(LOCALES)) {
            const actual = [
                ...bundle.externalImport[key].matchAll(placeholderPattern),
            ]
                .map((match) => match[0])
                .sort();
            assert.deepEqual(
                actual,
                expected,
                `${name}.externalImport.${key} must keep placeholders ${expected.join(", ")}`
            );
        }
    }
});

test("the feature's name never collides with the guest import", () => {
    // Policy §21: "이 브라우저의 게스트 대화 가져오기" (guest conversations
    // stored in this browser) and "다른 AI 서비스에서 가져오기" (an export
    // from another service) are different features and must read as such.
    for (const [name, bundle] of Object.entries(LOCALES)) {
        assert.notEqual(
            bundle.externalImport.dataTabTitle,
            bundle.auth.guestImportSectionTitle,
            `${name} must not reuse the guest import section title`
        );
    }
});

test("the components render the copy", () => {
    const sources = [
        "../components/imports/ExternalImportManagement.tsx",
        "../components/imports/ExternalImportWizard.tsx",
        "../components/imports/wizard/ProviderGuideStep.tsx",
        "../components/imports/wizard/FileInspectionStep.tsx",
        "../components/imports/wizard/ConversationSelectionStep.tsx",
        "../components/imports/wizard/ImportReviewStep.tsx",
        "../components/imports/wizard/ImportCompletedStep.tsx",
        "../components/imports/wizard/ImportStepIndicator.tsx",
        "../components/imports/ExternalImportDetail.tsx",
        "../components/imports/ExternalConversationViewer.tsx",
        "../components/imports/ConversationLockControls.tsx",
        "../components/auth/AuthButton.tsx",
    ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
    for (const key of [
        "externalImport.pageTitle",
        "externalImport.privacyNote",
        // Truncation consent is per conversation (§5.4). The row-level
        // consent control and its impact line are what must be rendered;
        // there is deliberately no global "approve them all" string.
        "externalImport.rowTruncationConsent",
        "externalImport.rowTruncationImpact",
        "externalImport.rowBlockedReason",
        "externalImport.truncationExplain",
        // Provider guidance is advisory: the mismatch notice has to exist.
        "externalImport.guideChatgptTitle",
        "externalImport.guideClaudeTitle",
        "externalImport.providerMismatchNotice",
        // The desktop-recommended state is a wizard state with three facts.
        "externalImport.desktopRecommendedNoUpload",
        "externalImport.desktopRecommendedNoData",
        "externalImport.desktopRecommendedRetry",
        // Step indicator and the user-facing rewording of transport terms.
        "externalImport.stepIndicatorLabel",
        "externalImport.stepPosition",
        "externalImport.continueToReview",
        "externalImport.preparingReviewTitle",
        "externalImport.reviewFinalizeCta",
        // Quota recovery must never read as "retry the same thing".
        "externalImport.quotaRevisionExplain",
        "externalImport.quotaRevisionRestartNotice",
        // Management screen: resume, restart and expiry.
        "externalImport.inProgressResume",
        "externalImport.inProgressNotResumable",
        "externalImport.expiredCardNotice",
        "externalImport.noServerDataYet",
        "externalImport.detailTitle",
        "externalImport.dataTabTitle",
        "externalImport.viewerTruncatedNotice",
        "externalImport.previousSnapshots",
        "externalImport.exportAll",
        "externalImport.deleteSnapshot",
        // §7: a locked snapshot has to say so where the owner meets it --
        // in the list, and in place of the content it is withholding.
        "externalImport.lockedBadge",
        "externalImport.lockGateTitle",
        "externalImport.lockSetCta",
        "externalImport.lockRemoveCta",
        // Losing the password is unrecoverable, so the warning is part of the
        // contract rather than a nicety.
        "externalImport.lockNoRecoveryWarning",
    ]) {
        assert.ok(
            sources.some((source) => source.includes(key)),
            `${key} must be rendered by an import component`
        );
    }
});

test("the copy makes no promise the implementation does not keep", () => {
    // Release A imports and stores; it does not extract memories or continue
    // conversations (§1, §6). The lock arrived in B5 (§7), so lock copy is
    // expected here now -- memory vocabulary still is not, which is why the
    // lock's memory-impact sentences live under memoryReview instead.
    for (const [name, bundle] of Object.entries(LOCALES)) {
        const body = Object.values(bundle.externalImport)
            .join(" ")
            .toLowerCase();
        for (const forbidden of [
            "memory",
            "메모리",
            "记忆",
            "mémoire",
            "gedächtnis",
            "memoria",
            "memória",
        ]) {
            assert.ok(
                !body.includes(forbidden),
                `${name} must not describe memory features in Release A copy`
            );
        }
    }
});
