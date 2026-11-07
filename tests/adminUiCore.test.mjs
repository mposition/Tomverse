import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_TONE_FAMILY,
  adminArcPath,
  adminBarRects,
  adminChartColor,
  adminDonutArcs,
  adminGaugeArcs,
  adminRingArc,
  adminSparkGeometry,
  formatAestClock,
} from "../lib/adminUiCore.ts";
import { ADMIN_PIXEL_TEAMS, adminPixelRects } from "../lib/adminPixelAvatarPalette.ts";

test("times read as Brisbane time, not UTC", () => {
  // 2026-11-07 03:42 UTC is 13:42 in Brisbane (UTC+10, no daylight saving).
  assert.equal(formatAestClock(new Date("2026-11-07T03:42:10Z")), "13:42");
  // Midnight UTC crosses the date line in Brisbane: 10:00 the same day.
  assert.equal(formatAestClock(new Date("2026-01-15T00:00:00Z")), "10:00");
  // Sydney is on UTC+11 in January; Brisbane is not.
  assert.equal(formatAestClock(new Date("2026-01-15T13:30:00Z")), "23:30");
  assert.equal(formatAestClock(new Date(Number.NaN)), "--:--");
});

test("a tone names a palette family, so Light can remap it", () => {
  assert.equal(ADMIN_TONE_FAMILY.ok, "emerald");
  assert.equal(ADMIN_TONE_FAMILY.unknown, "zinc");
  assert.equal(adminChartColor("blue"), "var(--color-blue-500)");
  assert.equal(adminChartColor("amber", 400), "var(--color-amber-400)");
});

test("a sparkline is drawn only from finite values, and its last point is the latest value", () => {
  const geometry = adminSparkGeometry([1, 3, 2, 5], 100, 40, 4);
  assert.ok(geometry);
  assert.match(geometry.line, /^M4,/);
  assert.ok(geometry.area.endsWith("Z"));
  assert.equal(geometry.last.x, 96);
  // The highest value sits at the top padding.
  assert.equal(geometry.last.y, 4);

  assert.equal(adminSparkGeometry([], 100, 40), null);
  assert.equal(adminSparkGeometry([1, Number.NaN], 100, 40), null);
  assert.equal(adminSparkGeometry([1, 2], 6, 40, 4), null);

  // A flat series sits in the middle, not on the floor where it would read as zero.
  const flat = adminSparkGeometry([7, 7, 7], 100, 40);
  assert.equal(flat.last.y, 20);
  // A single value still draws.
  assert.ok(adminSparkGeometry([3], 100, 40));
});

test("bars scale to the largest value and draw a zero as a hairline", () => {
  const rects = adminBarRects([0, 5, 10], 104, 50, 4);
  assert.equal(rects.length, 3);
  assert.equal(rects[0].width, 32);
  assert.equal(rects[2].height, 50);
  assert.equal(rects[1].height, 25);
  assert.equal(rects[0].height, 2);
  assert.equal(rects[2].x, 72);
  assert.equal(adminBarRects([1, -1], 100, 50), null);
  assert.equal(adminBarRects([1, Number.POSITIVE_INFINITY], 100, 50), null);
  assert.equal(adminBarRects([1, 2, 3], 4, 50, 4), null);
});

test("an arc goes clockwise and takes the long way only past 180 degrees", () => {
  assert.equal(adminArcPath(50, 50, 40, 0, 90), "M90,50 A40,40 0 0 1 50,90");
  assert.match(adminArcPath(50, 50, 40, -90, 200), / 0 1 1 /);
});

test("donut segments share the circle in proportion, starting at twelve o'clock", () => {
  const arcs = adminDonutArcs(
    [
      { value: 3, color: "violet", label: "Agents" },
      { value: 1, color: "blue", label: "Development" },
      { value: 0, color: "emerald", label: "Customers" },
    ],
    128,
    16
  );
  assert.equal(arcs.length, 3);
  assert.equal(arcs[0].share, 0.75);
  assert.equal(arcs[1].share, 0.25);
  // A zero segment keeps its legend entry but draws no arc.
  assert.equal(arcs[2].path, "");
  // Starts just past twelve o'clock (gap/2 = 1.5 degrees).
  assert.match(arcs[0].path, /^M65\.47,8/);

  assert.equal(adminDonutArcs([], 128, 16), null);
  assert.equal(adminDonutArcs([{ value: 0, color: "blue", label: "None" }], 128, 16), null);
  assert.equal(adminDonutArcs([{ value: -1, color: "blue", label: "Bad" }], 128, 16), null);

  // A single non-zero segment is a near-full circle, not a zero-length arc.
  const whole = adminDonutArcs([{ value: 4, color: "blue", label: "All" }], 100, 10);
  assert.match(whole[0].path, / 0 1 1 /);
});

test("a ring clamps to 0..1 and draws nothing it cannot read", () => {
  assert.equal(adminRingArc(Number.NaN, 64, 8), null);
  assert.equal(adminRingArc(0, 64, 8), "");
  assert.equal(adminRingArc(-2, 64, 8), "");
  assert.match(adminRingArc(0.25, 64, 8), /^M32,4 A28,28 0 0 1 60,32$/);
  assert.match(adminRingArc(5, 64, 8), / 0 1 1 /);
});

test("a gauge spans the top half and puts its marker where the score is", () => {
  const gauge = adminGaugeArcs(50, 200, 20);
  assert.equal(gauge.track, "M10,100 A90,90 0 0 1 190,100");
  assert.equal(gauge.marker.x, 100);
  assert.equal(gauge.marker.y, 10);
  assert.equal(adminGaugeArcs(0, 200, 20).fill, "");
  assert.equal(adminGaugeArcs(Number.NaN, 200, 20), null);
  assert.equal(adminGaugeArcs(150, 200, 20).marker.x, 190);
});

test("every AI team has a pixel figure inside its 16-unit grid", () => {
  for (const team of Object.keys(ADMIN_PIXEL_TEAMS)) {
    for (const body of [true, false]) {
      const rects = adminPixelRects(team, body);
      const rows = body ? 18 : 14;
      assert.ok(rects.length > 10, team);
      for (const rect of rects) {
        assert.ok(rect.x >= 0 && rect.x + rect.w <= 16, `${team} x`);
        assert.ok(rect.y >= 0 && rect.y + rect.h <= rows, `${team} y`);
        assert.match(rect.fill, /^#[0-9a-f]{6}$/);
      }
    }
  }
  // The head-only figure leaves the shirt out.
  assert.ok(adminPixelRects("sre", false).every((rect) => rect.fill !== ADMIN_PIXEL_TEAMS.sre.shirt));
});
