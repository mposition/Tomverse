import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OptimizerAnswerComparisons, type OptimizerAnswerComparison } from "@/components/admin/OptimizerAnswerComparisons";

const pair = (answerMs?: OptimizerAnswerComparison["answerMs"]): OptimizerAnswerComparison => ({
  kind: "research", a: "current-model", b: "other-model", verdict: "a", answerMs,
});

test("a pair shows accepted-answer completion times beside its unchanged quality verdict", () => {
  const html = renderToStaticMarkup(<OptimizerAnswerComparisons comparisons={[pair({ a: 1250, b: 2300 })]} />);
  assert.match(html, /current-model.*other-model.*current pick better/);
  assert.match(html, /current 1.25 s; other 2.30 s/);
  assert.match(html, /not the browser&#x27;s first content/);
  assert.match(html, /official sources.*quality still need verification/);
});

test("old and unsuccessful answers stay unmeasured while a measured zero stays zero", () => {
  const html = renderToStaticMarkup(<OptimizerAnswerComparisons comparisons={[
    pair(), pair({ a: 0, b: null }), pair({ a: NaN, b: Infinity }), pair({ a: -1, b: 10 }),
  ]} />);
  assert.match(html, /current 0.00 s; other not measured/);
  assert.equal((html.match(/current not measured/g) ?? []).length, 3);
  assert.doesNotMatch(html, /NaN|Infinity|-0.00/);
});

test("an empty comparison list does not imply that any experiment ran", () => {
  assert.equal(renderToStaticMarkup(<OptimizerAnswerComparisons comparisons={[]} />), "");
});
