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
import {
    PROVIDER_DATA_DESTINATIONS,
    disclosableDataDestinations,
} from "../lib/providerDataDestinations.ts";

/**
 * The chat-provider notice states what Tomverse controls, then the
 * per-provider table. Reviewed facts and explicit unverified-provider notices
 * share the table. Country names come from the registry, not transfer text.
 */

const LOCALES = { ko, en, zh, fr, de, es, pt };
const KEYS = [
    "providers",
    "providerTransferTitle",
    "providerTransfer1",
    "providerTransfer2",
    "providerTransfer3",
    "providerTransfer4",
    "providerTransfer5",
    "providerTransfer6",
    "providerTransfer7",
];

const COUNTRY_CLAIM = [
    "different country",
    "outro país",
    "otro país",
    "autre pays",
    "anderen Land",
    "处理国家",
    "다를 수 있습니다",
];

test("every locale states the chat-provider transfer Tomverse controls", () => {
    for (const [name, bundle] of Object.entries(LOCALES)) {
        for (const key of KEYS) {
            const value = bundle.privacyPolicy?.[key];
            assert.equal(typeof value, "string", `${name}.privacyPolicy.${key}`);
            assert.ok(value.trim().length > 0, `${name}.privacyPolicy.${key} empty`);
            const folded = value.toLowerCase();
            for (const claim of COUNTRY_CLAIM) {
                assert.equal(
                    folded.includes(claim.toLowerCase()),
                    false,
                    `${name}.privacyPolicy.${key} still claims a country`
                );
            }
        }
        const body = KEYS.map((key) => bundle.privacyPolicy[key]).join("\n");
        assert.match(body, /HTTPS/);
        assert.match(body, /Brave Search/);
    }
});

test("the notice says the provider request omits account id, email, and client IP", () => {
    assert.match(ko.privacyPolicy.providerTransfer1, /계정 식별자, 이메일, 클라이언트 IP/);
    assert.match(en.privacyPolicy.providerTransfer1, /account identifier, email address, or client IP address/);
    assert.match(zh.privacyPolicy.providerTransfer1, /账户标识、电子邮件或客户端 IP/);
    assert.match(pt.privacyPolicy.providerTransfer1, /identificador da conta/);
    assert.match(fr.privacyPolicy.providerTransfer1, /identifiant du compte/);
    assert.match(es.privacyPolicy.providerTransfer1, /identificador de la cuenta/);
    assert.match(de.privacyPolicy.providerTransfer1, /Kontokennung/);
});

test("the privacy page preserves known disclosures and explicitly names unverified providers", () => {
    const source = readFileSync("components/legal/PrivacyPolicy.tsx", "utf8");
    assert.match(source, /PROVIDER_TRANSFER_ITEMS/);
    assert.match(source, /const destinations = PROVIDER_DATA_DESTINATIONS/);
    assert.match(source, /const showProviderTable = destinations\.length > 0/);
    const undisclosed = PROVIDER_DATA_DESTINATIONS.filter((entry) => entry.status !== "proven");
    // fal and bfl are image-only providers whose terms are not yet reviewed.
    assert.deepEqual(undisclosed.map((entry) => entry.provider), ["cohere", "fal", "bfl"]);
    assert.ok(disclosableDataDestinations().length < PROVIDER_DATA_DESTINATIONS.length);
    assert.ok(PROVIDER_DATA_DESTINATIONS.length > 0);
    const labels = [
        "providerTableTitle",
        "providerTableIntro",
        "providerUnverifiedNotice",
        "providerTableScrollHint",
        "colProvider",
        "colRecipient",
        "colStorage",
        "colProcessing",
        "colTraining",
        "colRetention",
        "colCommercialUse",
        "trainsYes",
        "trainsNo",
        "commercialProhibited",
        "commercialAllowed",
        "geoNotSpecified",
        "geoNotPinned",
        "geoCommitted",
        "geoDisclosedPossible",
        "geoNoPersistentContent",
        "retentionNotSpecified",
        "retentionCustomerControlled",
        "retentionBounded",
        "retentionTransient",
        "retentionNoPersistent",
        "providerSource",
    ];
    const places = new Set();
    for (const row of disclosableDataDestinations()) {
        for (const code of [
            ...row.recipientCountryCodes,
            ...row.customerContentStorage.countryCodes,
            ...row.customerContentStorage.macroRegions,
            ...row.processing.countryCodes,
            ...row.processing.macroRegions,
        ]) {
            places.add(code);
        }
    }
    for (const [name, bundle] of Object.entries(LOCALES)) {
        for (const key of labels) {
            const value = bundle.privacyPolicy?.[key];
            assert.equal(typeof value, "string", `${name}.privacyPolicy.${key}`);
            assert.ok(value.trim().length > 0, `${name}.privacyPolicy.${key} empty`);
        }
        for (const code of places) {
            const key = `place${code}`;
            const value = bundle.privacyPolicy?.[key];
            assert.equal(typeof value, "string", `${name}.privacyPolicy.${key}`);
            assert.ok(value.trim().length > 0, `${name}.privacyPolicy.${key} empty`);
        }
    }
});

/**
 * The table is wider than a phone on purpose, so it has to be the only part of
 * the section that is wide: the body column keeps `min-w-0` (otherwise the
 * 720px table sets the grid item's minimum size and the section's sentences
 * stop wrapping), and the scroller is a named, focusable region so the columns
 * past "Storage" are reachable from the keyboard. The rendered geometry is
 * measured in tests/e2e/privacy-provider-table-reflow.spec.ts.
 */
test("the wide provider table scrolls on its own without widening the section", () => {
    const policy = readFileSync("components/legal/PrivacyPolicy.tsx", "utf8");
    const source = readFileSync("components/legal/ProviderDestinationTable.tsx", "utf8");
    assert.match(policy, /className="min-w-0 legal-text"/);
    assert.match(policy, /className="min-w-0 legal-table"/);
    const scroller = source.match(/<div\s+className="mt-3 overflow-x-auto[\s\S]*?>/);
    assert.ok(scroller, "the table is not inside a horizontal scroller");
    assert.match(scroller[0], /role="region"/);
    assert.match(scroller[0], /aria-label=\{t\("privacyPolicy\.providerTableTitle"\)\}/);
    assert.match(scroller[0], /tabIndex=\{0\}/);
    assert.match(source, /t\("privacyPolicy\.providerTableScrollHint"\)/);
});
