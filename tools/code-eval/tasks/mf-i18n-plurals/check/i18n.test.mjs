import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n, de, en } from "../src/index.js";

const items = { zero: "no items", one: "{count} item", other: "{count} items" };

test("english plural forms", () => {
    const i18n = createI18n({ locale: "en", messages: { en: { items: { one: "{count} item", other: "{count} items" } } } });
    assert.equal(i18n.t("items", { count: 1 }), "1 item");
    assert.equal(i18n.t("items", { count: 3 }), "3 items");
    assert.equal(i18n.t("items", { count: 0 }), "0 items");
    assert.equal(i18n.t("items", { count: 1.5 }), "1.5 items");
});

test("the zero form is used only for zero and only when it exists", () => {
    const i18n = createI18n({ messages: { en: { items } } });
    assert.equal(i18n.t("items", { count: 0 }), "no items");
    assert.equal(i18n.t("items", { count: 1 }), "1 item");
    assert.equal(i18n.t("items", { count: 2 }), "2 items");
});

test("russian categories", () => {
    const form = { one: "one {count}", few: "few {count}", many: "many {count}", other: "other {count}" };
    const i18n = createI18n({ locale: "ru", messages: { ru: { files: form } } });
    const expected = { 1: "one 1", 2: "few 2", 4: "few 4", 5: "many 5", 11: "many 11", 12: "many 12", 21: "one 21", 22: "few 22", 25: "many 25" };
    for (const [count, text] of Object.entries(expected)) assert.equal(i18n.t("files", { count: Number(count) }), text, count);
    assert.equal(i18n.t("files", { count: 1.5 }), "other 1,5");
});

test("a missing category falls back to other; no usable form returns the key", () => {
    const i18n = createI18n({ locale: "ru", messages: { ru: { a: { one: "one {count}", other: "other {count}" }, b: { one: "only one" } } } });
    assert.equal(i18n.t("a", { count: 5 }), "other 5");
    assert.equal(i18n.t("b", { count: 5 }), "b");
    assert.equal(i18n.t("b", { count: 1 }), "only one");
});

test("a missing or invalid count uses other", () => {
    const i18n = createI18n({ messages: { en: { items } } });
    assert.equal(i18n.t("items"), "{count} items");
    assert.equal(i18n.t("items", { count: "1" }), "1 items");
    assert.equal(i18n.t("items", { count: NaN }), "NaN items");
    assert.equal(i18n.t("items", { count: Infinity }), "∞ items");
});

test("numbers are formatted for the current locale", () => {
    const messages = { en: { n: "{count} items" }, de: { n: "{count} Stuecke" } };
    const i18n = createI18n({ messages });
    assert.equal(i18n.t("n", { count: 1234567 }), "1,234,567 items");
    i18n.setLocale("de");
    assert.equal(i18n.t("n", { count: 1234567 }), "1.234.567 Stuecke");
    assert.equal(i18n.t("n", { count: 0.5 }), "0,5 Stuecke");
});

test("only numbers are formatted", () => {
    const i18n = createI18n({ messages: { en: { m: "{a}|{b}|{c}|{d}" } } });
    assert.equal(i18n.t("m", { a: "1234", b: true, c: 1234, d: null }), "1234|true|1,234|null");
    assert.equal(i18n.t("m", { a: "x" }), "x|{b}|{c}|{d}");
});

test("plural messages are formatted too", () => {
    const i18n = createI18n({ locale: "de", messages: { de: { items: { one: "{count} Ding", other: "{count} Dinge" } } } });
    assert.equal(i18n.t("items", { count: 1 }), "1 Ding");
    assert.equal(i18n.t("items", { count: 2500 }), "2.500 Dinge");
});

test("fallback chain: region, language, fallback locale", () => {
    const messages = { en: { hello: "Hello", only_en: "only en" }, "en-GB": { hello: "Hello (GB)" }, de: { only_de: "nur de" } };
    const gb = createI18n({ locale: "en-GB", messages });
    assert.equal(gb.t("hello"), "Hello (GB)");
    assert.equal(gb.t("only_en"), "only en");
    assert.equal(gb.t("only_de"), "only_de");
    const fr = createI18n({ locale: "fr-CA", messages });
    assert.equal(fr.t("hello"), "Hello");
    const german = createI18n({ locale: "de-AT", fallbackLocale: "de", messages });
    assert.equal(german.t("only_de"), "nur de");
    assert.equal(german.t("only_en"), "only_en");
    const chained = createI18n({ locale: "fr", fallbackLocale: "de-AT", messages: { "de-AT": { a: "a-at" }, de: { b: "b-de" } } });
    assert.equal(chained.t("a"), "a-at");
    assert.equal(chained.t("b"), "b-de");
});

test("has follows the chain and setLocale re-evaluates it", () => {
    const messages = { en: { shared: "S" }, de: { german: "G" } };
    const i18n = createI18n({ locale: "de-CH", messages });
    assert.equal(i18n.has("german"), true);
    assert.equal(i18n.has("shared"), true);
    assert.equal(i18n.has("nothing"), false);
    i18n.setLocale("en");
    assert.equal(i18n.has("german"), false);
    assert.equal(i18n.t("shared"), "S");
});

test("a plural message from the fallback uses the current locale for its rules", () => {
    const form = { one: "one {count}", few: "few {count}", other: "other {count}" };
    const i18n = createI18n({ locale: "ru", fallbackLocale: "en", messages: { en: { files: form } } });
    assert.equal(i18n.t("files", { count: 3 }), "few 3");
});

test("only own properties are messages", () => {
    const i18n = createI18n({ messages: { en: {} } });
    assert.equal(i18n.has("constructor"), false);
    assert.equal(i18n.t("toString"), "toString");
    assert.equal(i18n.has("__proto__"), false);
});

test("ready-made locales and plain strings still work", () => {
    const i18n = createI18n({ locale: "en", messages: { en, de } });
    assert.equal(i18n.t("greeting", { name: "Ann" }), "Hello, Ann!");
    i18n.setLocale("de");
    assert.equal(i18n.t("farewell", { name: "Ann" }), "Auf Wiedersehen, Ann.");
});
