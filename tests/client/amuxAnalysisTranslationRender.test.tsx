import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AmuxKoText, AmuxTranslationToggle } from "@/components/admin/AmuxAnalysisTranslation";
import { AmuxIdeaAnalysisResultPanel } from "@/components/admin/AmuxIdeaAnalysisResultPanel";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";

// Owner request 2026-10-30: a Korean translation shown beside the English
// analysis result, marked as a reference, behind a default-off switch.

const KEYS = ["translationShow", "translationHide", "translationLoading", "translationLabel",
  "translationHint", "translationTooLarge", "translationUnavailable", "translationStale"] as const;

test("every translation string exists in English and Korean, and they differ", () => {
  for (const key of KEYS) {
    const en = adminAmuxIdeaInputMessages.en[key];
    const ko = adminAmuxIdeaInputMessages.ko[key];
    assert.equal(typeof en, "string", key);
    assert.equal(typeof ko, "string", key);
    assert.ok(en.length > 0 && ko.length > 0 && en !== ko, key);
  }
  assert.equal(adminAmuxIdeaInputMessages.ko.translationLabel, "번역(참고용)");
});

test("a translation is marked as a Korean reference and nothing renders without one", () => {
  const m = adminAmuxIdeaInputMessages.ko;
  assert.equal(renderToStaticMarkup(createElement(AmuxKoText, { m, text: undefined })), "");
  const markup = renderToStaticMarkup(createElement(AmuxKoText, { m, text: "카드 보기" }));
  assert.match(markup, /lang="ko"/);
  assert.match(markup, /data-testid="amux-ko-translation"/);
  assert.ok(markup.includes("번역(참고용)") && markup.includes("카드 보기"));
});

test("the toggle names its action and reports each failure in words", () => {
  const m = adminAmuxIdeaInputMessages.en;
  const render = (props: Partial<Parameters<typeof AmuxTranslationToggle>[0]>) =>
    renderToStaticMarkup(createElement(AmuxTranslationToggle, {
      m, shown: false, state: null, stale: false, onToggle: () => undefined, ...props }));
  assert.ok(render({}).includes(m.translationShow));
  assert.ok(render({}).includes(m.translationHint));
  assert.ok(render({ shown: true }).includes(m.translationHide));
  assert.match(render({ state: "loading" }), /disabled=""/);
  assert.ok(render({ state: "loading" }).includes(m.translationLoading));
  assert.ok(render({ state: "too_large" }).includes(m.translationTooLarge));
  assert.ok(render({ state: "unavailable" }).includes(m.translationUnavailable));
  assert.ok(render({ stale: true }).includes(m.translationStale));
  assert.equal(render({}).includes(m.translationStale), false);
});

test("with the switch off the result panel shows no translation control", () => {
  for (const translationAvailable of [undefined, false]) {
    const markup = renderToStaticMarkup(createElement(AmuxIdeaAnalysisResultPanel, {
      ideaId: "22222222-2222-4222-8222-222222222222", translationAvailable }));
    assert.equal(markup.includes("amux-translation-toggle"), false);
    assert.equal(markup.includes("amux-ko-translation"), false);
  }
});
