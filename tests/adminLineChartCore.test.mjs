// The trend chart's geometry. Like the other chart helpers it returns null for
// anything it cannot draw honestly, and the dashed comparison shares the
// current line's scale: on its own scale it would say two very different
// periods were alike.

import assert from "node:assert/strict";
import test from "node:test";
import { adminLineChartGeometry, trendWindows } from "../lib/adminLineChartCore.ts";

test("nothing, a single point or a non-number draws nothing", () => {
  assert.equal(adminLineChartGeometry([], null, 600, 200), null);
  assert.equal(adminLineChartGeometry([4], null, 600, 200), null);
  assert.equal(adminLineChartGeometry([1, Number.NaN], null, 600, 200), null);
  assert.equal(adminLineChartGeometry([1, 2], [1], 600, 200), null);
  assert.equal(adminLineChartGeometry([1, 2], null, 10, 200, 8), null);
});

test("a series draws a line, a closed area and a marker on the latest value", () => {
  const geometry = adminLineChartGeometry([1, 3, 2, 5], null, 600, 200);
  assert.ok(geometry);
  assert.match(geometry.line, /^M/);
  assert.match(geometry.area, / Z$/);
  assert.equal(geometry.previousLine, null);
  assert.equal(geometry.points.length, 4);
  assert.deepEqual(geometry.last, { x: geometry.points[3].x, y: geometry.points[3].y });
  // The highest value sits highest (smallest y).
  const ys = geometry.points.map((point) => point.y);
  assert.equal(Math.min(...ys), ys[3]);
});

test("the previous period is drawn on the same scale as the current one", () => {
  const alone = adminLineChartGeometry([10, 10, 10], null, 600, 200);
  const compared = adminLineChartGeometry([10, 10, 10], [100, 100, 100], 600, 200);
  assert.ok(alone && compared);
  assert.ok(compared.previousLine);
  // With a far larger previous period, the current line is drawn lower.
  assert.ok(compared.points[0].y > alone.points[0].y);
});

test("a window of a daily series is the last N days and the N before them when they exist", () => {
  const series = Array.from({ length: 30 }, (_, index) => index);
  const week = trendWindows(series, 7);
  assert.deepEqual(week.current, [23, 24, 25, 26, 27, 28, 29]);
  assert.deepEqual(week.previous, [16, 17, 18, 19, 20, 21, 22]);
  // Thirty days leaves nothing before it to compare with.
  const month = trendWindows(series, 30);
  assert.equal(month.current.length, 30);
  assert.equal(month.previous, null);
  // A short series is never padded.
  assert.equal(trendWindows([1, 2, 3], 7).previous, null);
});
