import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { QaReleaseTrainBoard } from "@/components/admin/QaReleaseTrainBoard";
import { QaReleaseTrainEmergencySection } from "@/components/admin/QaReleaseTrainEmergencySection";
import { QaReleaseTrainSummary } from "@/components/admin/QaReleaseTrainSummary";
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
  leftOut: [{ number: 2913, title: "", outcome: "conflict", predecessors: [2726] }],
  alreadyOnMain: [2824],
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
  assert.match(html, /aria-label="Train 20261025-1100: show details"/);
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
  // A pending emergency departs first, and the scheduled time still shows.
  assert.match(html, /Emergency: next round/);
  assert.ok(html.includes("with 2 PR(s); the scheduled train follows at"));
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
