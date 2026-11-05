import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminTrustSafetyDigestPanel } from "@/components/admin/AdminTrustSafetyDigestPanel";
import { adminTrustSafetyMessages } from "@/lib/adminMessages/trustSafety";
import type { TrustSafetyDigestView } from "@/lib/trustSafetyDigestRead";

/**
 * E2's section, rendered (docs/policy/trust-safety-compliance-agent.md §5.6,
 * §9, §14).
 *
 * The English catalogue is used as the messages, so a copy key the panel reads
 * but the catalogue does not define renders as `undefined` here and fails.
 */

const messages = adminTrustSafetyMessages.en as unknown as Record<string, string>;

const bucket = (total: number, legalHold = 0) => ({ total, legalHold });

const view = (over: Partial<TrustSafetyDigestView> = {}): TrustSafetyDigestView => ({
  activation: { mode: "on", fault: null, countPermitted: true, pingPermitted: true },
  version: 2,
  observedAt: "2026-11-05T04:50:38.694Z",
  counts: {
    observed: bucket(12, 3),
    overdue: bucket(2, 1),
    imminent: bucket(0),
    closedLate: bucket(4, 2),
    worstLateClosureDays: 3,
    imminentWithinDays: 0,
  },
  ...over,
});

const render = (over: Parameters<typeof AdminTrustSafetyDigestPanel>[0]) =>
  renderToStaticMarkup(<AdminTrustSafetyDigestPanel {...over} />);

test("the two lines §14 asks the operator to judge by are both shown", () => {
  const html = render({ view: view(), messages, canWrite: true, refusedCode: null });
  // The count comparison line.
  assert.match(html, /Requests counted/);
  assert.match(html, />12</);
  assert.match(html, /Past the deadline/);
  // The late-closure line: the count and the worst overrun.
  assert.match(html, /Closed after the deadline/);
  assert.match(html, />4</);
  assert.match(html, /3 days/);
  // Legal hold travels alongside, never subtracted (§1-1).
  assert.match(html, /on legal hold/);
  assert.match(html, /never subtracted/);
});

test("an unapproved imminence window says so instead of showing a zero", () => {
  // §12 approves no threshold, so the panel must not present 0 as a count.
  const html = render({ view: view(), messages, canWrite: true, refusedCode: null });
  assert.match(html, /No window has been approved/);
});

test("an approved window shows the count and the window", () => {
  const html = render({
    view: view({
      counts: {
        observed: bucket(5),
        overdue: bucket(1),
        imminent: bucket(2),
        closedLate: bucket(0),
        worstLateClosureDays: null,
        imminentWithinDays: 7,
      },
    }),
    messages,
    canWrite: true,
    refusedCode: null,
  });
  assert.match(html, /Within 7 days/);
  assert.match(html, /None/, "no late closure reads as none, not as zero days");
});

test("a fault is named, and a counting fault replaces the counts", () => {
  const html = render({
    view: view({
      activation: {
        mode: null,
        fault: "chain_broken",
        countPermitted: false,
        pingPermitted: false,
      },
      counts: null,
    }),
    messages,
    canWrite: true,
    refusedCode: null,
  });
  assert.match(html, /does not point at it/, "the fault is explained");
  assert.match(html, /No counting happens/);
  assert.doesNotMatch(html, /Requests counted/, "no counts beside an unbelieved switch");
  assert.match(html, /Not established/, "and the mode is not reported as off");
});

test("the switch posts a form to the activation route, with the other mode", () => {
  // §5.6 does not allow these files to name `fetch`, so the control is a plain
  // submit. The value is the mode being moved to, never the current one.
  const on = render({ view: view(), messages, canWrite: true, refusedCode: null });
  // React orders the attributes itself, so both are asserted rather than the
  // literal tag.
  assert.match(on, /<form[^>]*action="\/api\/admin\/agents\/trust-safety\/activation"/);
  assert.match(on, /<form[^>]*method="post"/);
  assert.match(on, /name="mode" value="off"/);
  assert.match(on, /Turn off/);

  const off = render({
    view: view({
      activation: { mode: "off", fault: null, countPermitted: false, pingPermitted: false },
      counts: null,
    }),
    messages,
    canWrite: true,
    refusedCode: null,
  });
  assert.match(off, /name="mode" value="on"/);
  assert.match(off, /Turn on/);
});

test("without the permission there is no form at all", () => {
  const html = render({ view: view(), messages, canWrite: false, refusedCode: null });
  assert.doesNotMatch(html, /<form/);
  assert.match(html, /Only the owner can change this/);
});

test("a refusal the route redirected back with is shown, including the step-up remedy", () => {
  const refused = render({
    view: view(),
    messages,
    canWrite: true,
    refusedCode: "not_a_transition",
  });
  assert.match(refused, /Refused: not_a_transition/);
  assert.match(refused, /Nothing was written/);

  const stale = render({
    view: view(),
    messages,
    canWrite: true,
    refusedCode: "reauthentication_required",
  });
  assert.match(stale, /Sign in again/);
});

test("the fixed list of what the panel does not show is rendered in full", () => {
  // §9 requires it as code constants, and §5.3 is why the last line is there.
  const html = render({ view: view(), messages, canWrite: true, refusedCode: null });
  for (const line of [
    /Policy citations/,
    /MODERATION-01/,
    /Security workflow results/,
    /no moderation or abuse handling/,
    /When the observer last ran/,
  ]) {
    assert.match(html, line);
  }
});

test("a failed read degrades the section rather than the workspace", () => {
  const html = render({ view: null, messages, canWrite: true, refusedCode: null });
  assert.match(html, /could not be read/);
  assert.doesNotMatch(html, /<form/, "and offers no switch over values it does not have");
});

test("nothing in the panel reports when the observer last ran", () => {
  // §5.3: the run table stays unread. A "last round" line here would be its
  // first reader and would make the record into state.
  const html = render({ view: view(), messages, canWrite: true, refusedCode: null });
  assert.doesNotMatch(html, /last round|Last run|lastRound/i);
});
