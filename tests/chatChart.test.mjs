import assert from "node:assert/strict";
import test from "node:test";

import { CHART_LIMITS, formatChartNumber, niceScale, parseChartSpec } from "../lib/chatChart.ts";
import { CHAT_INLINE_CHART_PROMPT, chatInlineChartPromptEnabled } from "../lib/chatChartPrompt.ts";
import { chatAnswerSurfaceCopy } from "../locales/chatAnswerSurface.ts";
import { SUPPORTED_LANGUAGES } from "../lib/language.ts";

const bar = (extra = {}) =>
  JSON.stringify({ type: "bar", title: "Revenue", labels: ["Q1", "Q2"], series: [{ name: "2026", values: [120, 150] }], ...extra });

test("a category chart spec validates and is trimmed", () => {
  const spec = parseChartSpec(bar({ title: "  Revenue  ", xLabel: "Quarter" }));
  assert.equal(spec?.type, "bar");
  assert.equal(spec?.title, "Revenue");
  assert.equal(spec?.xLabel, "Quarter");
  assert.deepEqual(spec?.labels, ["Q1", "Q2"]);
  assert.deepEqual(spec?.series[0].values, [120, 150]);
});

test("a scatter spec takes pairs or {x, y} objects", () => {
  const spec = parseChartSpec(JSON.stringify({ type: "scatter", series: [{ name: "A", points: [[1, 2], { x: 3, y: 4 }] }] }));
  assert.deepEqual(spec?.series[0].points, [[1, 2], [3, 4]]);
});

test("a pie chart keeps its first series and rejects negatives and empty totals", () => {
  const pie = (values) => JSON.stringify({ type: "pie", labels: ["a", "b"], series: [{ values }, { values: [1, 1] }] });
  assert.deepEqual(parseChartSpec(pie([1, 3]))?.series.length, 1);
  assert.equal(parseChartSpec(pie([-1, 3])), null);
  assert.equal(parseChartSpec(pie([0, 0])), null);
});

test("anything malformed or over a limit stays null, so the code block remains", () => {
  assert.equal(parseChartSpec("not json"), null);
  assert.equal(parseChartSpec("[]"), null);
  assert.equal(parseChartSpec(JSON.stringify({ type: "radar", labels: ["a"], series: [{ values: [1] }] })), null);
  assert.equal(parseChartSpec(bar({ series: [{ name: "x", values: [1] }] })), null, "value count must match labels");
  assert.equal(parseChartSpec(bar({ series: [{ name: "x", values: [1, "2"] }] })), null, "numbers only");
  assert.equal(parseChartSpec(bar({ series: [] })), null);
  const many = Array.from({ length: CHART_LIMITS.series + 1 }, () => ({ name: "s", values: [1, 2] }));
  assert.equal(parseChartSpec(bar({ series: many })), null);
  const labels = Array.from({ length: CHART_LIMITS.labels + 1 }, (_, i) => String(i));
  assert.equal(parseChartSpec(bar({ labels, series: [{ name: "s", values: labels.map(() => 1) }] })), null);
  assert.equal(parseChartSpec(" ".repeat(CHART_LIMITS.sourceCharacters + 1)), null);
  const points = Array.from({ length: CHART_LIMITS.pointsPerSeries + 1 }, (_, i) => [i, i]);
  assert.equal(parseChartSpec(JSON.stringify({ type: "scatter", series: [{ points }] })), null);
});

test("axes end on round numbers and survive a flat series", () => {
  assert.deepEqual(niceScale(0, 150), { min: 0, max: 150, ticks: [0, 50, 100, 150] });
  const flat = niceScale(5, 5);
  assert.ok(flat.min < 5 && flat.max > 5);
  assert.equal(niceScale(0, 0.3).ticks.includes(0.3), true);
  assert.equal(formatChartNumber(12400), "12.4K");
});

test("the chart prompt is off unless CHAT_INLINE_CHART=on and names the block format", () => {
  const previous = process.env.CHAT_INLINE_CHART;
  try {
    delete process.env.CHAT_INLINE_CHART;
    assert.equal(chatInlineChartPromptEnabled(), false);
    process.env.CHAT_INLINE_CHART = "on";
    assert.equal(chatInlineChartPromptEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.CHAT_INLINE_CHART;
    else process.env.CHAT_INLINE_CHART = previous;
  }
  assert.match(CHAT_INLINE_CHART_PROMPT, /language `chart`/);
  assert.match(CHAT_INLINE_CHART_PROMPT, /only when the user asks/i);
});

test("chart words exist in every language", () => {
  for (const lang of SUPPORTED_LANGUAGES) {
    for (const [key, value] of Object.entries(chatAnswerSurfaceCopy[lang])) {
      assert.ok(value.trim().length > 0, `${lang}.${key}`);
    }
  }
});
