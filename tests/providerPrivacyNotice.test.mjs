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
 * The chat-provider notice states only what Tomverse controls: what is sent,
 * when and how, the purpose, that choosing a model chooses the recipient,
 * how to refuse, and that the request does not carry the account identifier,
 * email, or client IP. Country, legal name, and retention stay off the page
 * until every live provider has a reviewed row.
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

test("the privacy page does not render unproven provider rows", () => {
    const source = readFileSync("components/legal/PrivacyPolicy.tsx", "utf8");
    assert.match(source, /PROVIDER_TRANSFER_ITEMS/);
    assert.equal(source.includes("providerDataDestinations"), false);
    assert.equal(source.includes("recipientEntity"), false);
});
