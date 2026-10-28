import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { QaReleaseTrainBoard } from "@/components/admin/QaReleaseTrainBoard";
import { QaReleaseTrainEmergencySection } from "@/components/admin/QaReleaseTrainEmergencySection";
import { QaReleaseTrainLoading, QaReleaseTrainSummary } from "@/components/admin/QaReleaseTrainSummary";
import type { QaReleaseTrainBoardRow } from "@/lib/qaReleaseTrainBoardCore";

const row = (overrides: Partial<QaReleaseTrainBoardRow>): QaReleaseTrainBoardRow => ({
  slot: "20261025-1100",
  emergency: false,
  admittedAt: "2026-10-25T01:02:00Z",
  reportedAt: "2026-10-25T01:04:00Z",
  status: "arrived",
  pullRequestNumber: 2986,
  settledAt: "2026-10-25T01:56:00Z",
  included: [{ number: 2978, title: "ci admission stop fast" }],
  leftOut: [{ number: 2913, title: "", outcome: "conflict", why: "It needs #2726." }],
  alreadyOnMain: [2824],
  onOpenTrain: [],
  rcSha: "f".repeat(40),
  failure: null,
  ...overrides,
});

test("the departure board shows each train's time, load, pull request and status, closed until a row is opened", () => {
  const html = renderToStaticMarkup(
    <QaReleaseTrainBoard
      rows={[row({ slot: "20261025-1237", emergency: true, status: "boarding", admittedAt: "2026-10-25T02:37:00Z", settledAt: null }), row({})]}
      pullsRead={true}
      nowMs={Date.parse("2026-10-25T03:00:00Z")}
    />,
  );
  // AEST times, split into flaps.
  assert.match(html, />1<\/span><span[^>]*>2<\/span><span[^>]*>:<\/span><span[^>]*>3<\/span><span[^>]*>7</);
  assert.match(html, /Boarding/);
  assert.match(html, /Arrived/);
  assert.match(html, /Emergency/);
  assert.match(html, /#2986/);
  assert.match(html, /▲ 1/);
  assert.match(html, /▼ 1/);
  assert.match(html, /aria-expanded="false"/);
  // The flap digits are hidden from assistive technology; the row's name carries what it shows.
  assert.ok(html.includes('aria-label="Train 20261025-1100, departed 11:02, Arrived, 1 rode, 1 left out, main PR #2986: show details"'));
  // Details open on a click only.
  assert.doesNotMatch(html, /qa-release-train-board-detail/);
  assert.doesNotMatch(html, /GitHub could not be read/);
});

test("an empty board says so, and an unread GitHub is named instead of guessed", () => {
  const html = renderToStaticMarkup(<QaReleaseTrainBoard rows={[]} pullsRead={false} nowMs={0} />);
  assert.match(html, /No train has departed yet/);
  assert.match(html, /GitHub could not be read/);
});

test("the summary shows the next departure, what rides it, and the open train", () => {
  const html = renderToStaticMarkup(
    <QaReleaseTrainSummary nextDepartureAt="2026-10-25T07:00:00Z" riding={16} carried={12} openTrain={2998} openUnknown={false} emergencyPulls={2} />,
  );
  assert.match(html, /16/);
  assert.match(html, /12 carried · 4 new/);
  assert.match(html, /href="https:\/\/github.com\/mposition\/Tomverse\/pull\/2998"/);
  // A pending emergency departs first; the scheduled train waits while it is open.
  assert.match(html, /Emergency: next round/);
  assert.ok(html.includes("with 2 PR(s). If it opens a train, the "));
  assert.ok(html.includes(" train waits until it is merged"));
});

test("open main pull requests GitHub did not give are named unknown, never none, and the emergency train warns", () => {
  const html = renderToStaticMarkup(<QaReleaseTrainSummary nextDepartureAt={null} riding={0} carried={0} openTrain={null} openUnknown={true} emergencyPulls={null} />);
  assert.match(html, /Not read/);
  assert.match(html, /a train may be open/);
  assert.doesNotMatch(html, />None</);
  assert.match(renderToStaticMarkup(<QaReleaseTrainEmergencySection canWrite={true} openUnknown={true} />), /qa-release-train-emergency-open-unknown/);
  assert.doesNotMatch(renderToStaticMarkup(<QaReleaseTrainEmergencySection canWrite={true} />), /qa-release-train-emergency-open-unknown/);
});

test("only a writer is offered the emergency train", () => {
  assert.match(renderToStaticMarkup(<QaReleaseTrainEmergencySection canWrite={true} />), /data-testid="qa-release-train-emergency-open"/);
  assert.doesNotMatch(renderToStaticMarkup(<QaReleaseTrainEmergencySection canWrite={false} />), /qa-release-train-emergency-open/);
});

test("while the tab reads, it says so (the click is never left without an answer)", () => {
  const html = renderToStaticMarkup(<QaReleaseTrainLoading />);
  assert.match(html, /role="status"/);
  assert.match(html, /Reading the release train/);
});

test("the board pages the last seven AEST days, opening on the newest day that had a train", () => {
  const html = renderToStaticMarkup(
    <QaReleaseTrainBoard
      rows={[row({}), row({ slot: "20261024-1700", admittedAt: "2026-10-24T07:01:00Z", status: "empty", included: [], leftOut: [] })]}
      pullsRead={true}
      // 2026-10-26 07:00 AEST: no train yet today.
      nowMs={Date.parse("2026-10-25T21:00:00Z")}
    />,
  );
  assert.equal(html.match(/data-testid="qa-release-train-board-day-[0-9]/g)?.length, 7);
  assert.ok(html.includes('aria-label="10-26 Mon, 0 trains"'));
  assert.match(html, /aria-pressed="true" aria-label="10-25 Sun, 1 trains"/);
  // Only the chosen day's trains, and its totals.
  assert.match(html, /qa-release-train-board-row-20261025-1100/);
  assert.doesNotMatch(html, /qa-release-train-board-row-20261024-1700/);
  assert.match(html, /10-25 Sun · 1 trains · 1 rode · 1 left out · 1 arrived/);
  // An empty day cannot be picked; older trains are named as kept elsewhere.
  assert.match(html, /<button[^>]*disabled=""[^>]*data-testid="qa-release-train-board-day-2026-10-26"/);
  assert.match(html, /Only the last 7 days show here/);
});
