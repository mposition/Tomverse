import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n, de, en, interpolate } from "../src/index.js";

test("looks up messages and interpolates", () => {
    const i18n = createI18n({ locale: "en", messages: { en, de } });
    assert.equal(i18n.t("greeting", { name: "Ann" }), "Hello, Ann!");
    i18n.setLocale("de");
    assert.equal(i18n.t("greeting", { name: "Ann" }), "Hallo, Ann!");
    assert.equal(i18n.locale, "de");
});

test("unknown keys return the key and missing params stay", () => {
    const i18n = createI18n({ messages: { en: { a: "x {y} z" } } });
    assert.equal(i18n.t("nope"), "nope");
    assert.equal(i18n.t("a"), "x {y} z");
    assert.equal(i18n.has("a"), true);
    assert.equal(interpolate("{n} items", { n: 3 }), "3 items");
});
