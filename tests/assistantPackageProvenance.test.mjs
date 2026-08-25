// What a package claimed about itself, on its way to a screen.
//
// docs/policy/assistant-package-import.md §6.5, §7.
//
// The provenance display shipped as nothing at all: the columns were written
// and read by the export services, and no component read them, so a published
// profile said nothing about where it came from. Adding the screen means a
// package's own words now reach a reader, and these pin what happens to them
// on the way.

import assert from "node:assert/strict";
import test from "node:test";

import { declaredSourceHost } from "../lib/assistantPackageProvenance.ts";
import { ko } from "../locales/ko.ts";
import { en } from "../locales/en.ts";
import { de } from "../locales/de.ts";
import { es } from "../locales/es.ts";
import { fr } from "../locales/fr.ts";
import { pt } from "../locales/pt.ts";
import { zh } from "../locales/zh.ts";

test("a stated URL is reduced to its host", () => {
    // A path or a query can carry a token, and this URL was written by the
    // package rather than by anyone here.
    assert.equal(
        declaredSourceHost("https://example.com/skills/abc?token=secret"),
        "example.com"
    );
    assert.equal(declaredSourceHost("http://example.com:8080/x"), "example.com:8080");
});

test("a scheme that is not http(s) is not a place anything came from", () => {
    // Rendered under "where this came from", a javascript: string would be
    // presented as a provenance rather than as the payload it is.
    assert.equal(declaredSourceHost("javascript:alert(1)"), null);
    assert.equal(declaredSourceHost("data:text/html,<script>x</script>"), null);
    assert.equal(declaredSourceHost("file:///etc/passwd"), null);
});

test("nothing stated, or unparseable, shows nothing", () => {
    assert.equal(declaredSourceHost(null), null);
    assert.equal(declaredSourceHost(""), null);
    assert.equal(declaredSourceHost("not a url"), null);
});

/**
 * The copy has to say the package said it.
 *
 * §6.5: "Agent Skill에서 가져왔다고 표시됨", not "Agent Skill에서 가져옴". The
 * server never saw the container, so a sentence asserting the origin as fact
 * would be this app vouching for something it cannot check.
 */
const CLAIM_WORDS = {
    ko: ["표시", "말"],
    en: ["states", "state", "stated"],
    de: ["gibt an", "angaben", "genannter"],
    es: ["declara", "declaró", "indicó"],
    fr: ["déclare", "déclaré", "indiqué"],
    pt: ["declara", "declarou", "indicado"],
    zh: ["声称", "声明", "说法"],
};

for (const [code, dictionary] of Object.entries({ ko, en, de, es, fr, pt, zh })) {
    test(`the ${code} provenance copy presents a claim, not a finding`, () => {
        const copy = dictionary.assistantProfiles;
        const combined = `${copy.provenanceEntry} ${copy.provenanceHint}`.toLowerCase();
        assert.ok(
            CLAIM_WORDS[code].some((word) => combined.includes(word.toLowerCase())),
            `${code} provenance copy must mark the origin as the package's claim`
        );
        // The time is the server's own, so it is the one thing here that is
        // not hedged -- and it must not be presented as the package's.
        assert.ok(copy.provenanceReceived.includes("{date}"));
    });
}
