// The observation table carries the source report's words, and these tests say
// what that means in practice: the verdict is the source's own value, the three
// signals stay apart per branch, nothing is dropped or truncated, a signal kind
// the table does not know fails the run instead of disappearing, and the stored
// counts can be recomputed from the rows beside them.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { VERDICTS } from "../scripts/report-issue-backlog-core.mjs";
import {
  makeIssueBacklogFixture,
  runIssueBacklogCli,
} from "./support/issueBacklogFixtureRepo.mjs";
import {
  ALLOWED_LABEL_PHRASES,
  FORBIDDEN_LABEL_WORDS,
  OBSERVATION_FAILURE_STAGES,
  OBSERVATION_LABELS,
  OBSERVATION_ROW_LIMIT,
  OBSERVATION_RETENTION_DAYS,
  OBSERVATION_SCHEMA_VERSION,
  OBSERVATION_SILENCE_HOURS,
  OBSERVED_BRANCHES,
  P1_WINDOW_SLOTS,
  P2_MIN_SUCCESSES,
  P2_WINDOW_SLOTS,
  PRICING_STATES,
  PROBE_STATES,
  TITLE_MAX_CODE_POINTS,
  buildObservationPayload,
  normaliseIssueTitle,
  displayableObservationSlot,
  observationLabel,
  observationSilenceVerdict,
  observationSlotSeries,
  p1WindowJudgement,
  p2WindowJudgement,
  summariseObservation,
  validateObservationPayload,
} from "../lib/productResearchObservationCore.mjs";

const probe = (ref, overrides = {}) => ({
  kind: "probe",
  ref,
  resolved: false,
  detail: "a probe",
  ...overrides,
});

const pricing = (ref, overrides = {}) => ({
  kind: "pricing",
  ref,
  resolved: false,
  detail: "a pricing signal",
  ...overrides,
});

const issue = (overrides = {}) => ({
  number: 636,
  title: "Deprecate creation of fixed-amount billing promotions",
  verdict: VERDICTS.OPEN_WORK,
  resolvedOn: [],
  missingFrom: [],
  commitBranches: [],
  signals: [],
  ...overrides,
});

const built = (classified) => {
  const result = buildObservationPayload({ classified });
  assert.equal(result.failure, undefined, JSON.stringify(result.failure));
  return result.payload;
};

test("an issue with no signal anywhere keeps the source verdict and claims nothing", () => {
  const payload = built([issue()]);
  assert.equal(payload.issues.length, 1);
  const [row] = payload.issues;
  assert.equal(row.verdict, VERDICTS.OPEN_WORK);
  assert.deepEqual(row.signals.probe, { develop: "none", main: "none" });
  assert.deepEqual(row.signals.pricing, { develop: "none", main: "none" });
  assert.deepEqual(row.signals.commits, { develop: false, main: false });
  assert.equal(row.blockedOnPresent, false);
  // No field for a recommendation, a rank or a priority exists to be set.
  assert.deepEqual(Object.keys(row).sort(), [
    "blockedOnPresent",
    "id",
    "missingFrom",
    "resolvedOn",
    "signals",
    "title",
    "verdict",
  ]);
  assert.equal(payload.blindSpots.noSignalIssues, 1);
});

test("an unreadable probe reports as unavailable even beside a satisfied one", () => {
  const payload = built([
    issue({
      signals: [
        probe("develop", { resolved: true }),
        probe("develop", { unavailable: true }),
      ],
    }),
  ]);
  // Doubt wins: the unreadable probe proves nothing, so the branch cannot be
  // reported as satisfied.
  assert.equal(payload.issues[0].signals.probe.develop, "unavailable");
  assert.equal(payload.issues[0].signals.probe.main, "none");
});

test("the two branches keep their own probe and pricing state", () => {
  const payload = built([
    issue({
      resolvedOn: ["develop"],
      missingFrom: ["main"],
      verdict: VERDICTS.RESOLVED_NOT_ON_ALL_BRANCHES,
      signals: [
        probe("develop", { resolved: true }),
        probe("main", { unavailable: true }),
        pricing("develop", { resolved: true }),
        pricing("main"),
      ],
    }),
  ]);
  const [row] = payload.issues;
  assert.deepEqual(row.signals.probe, { develop: "satisfied", main: "unavailable" });
  assert.deepEqual(row.signals.pricing, { develop: "satisfied", main: "unsatisfied" });
  // No merged field exists that would let a reader lose which branch said what.
  assert.deepEqual(Object.keys(row.signals).sort(), ["commits", "pricing", "probe"]);
  assert.equal(payload.blindSpots.oneBranchOnly, 1);
});

test("a stale probe is reported unsatisfied and labelled as not evidence", () => {
  const payload = built([
    issue({ signals: [probe("develop", { resolved: false })] }),
  ]);
  assert.equal(payload.issues[0].signals.probe.develop, "unsatisfied");
  assert.match(
    observationLabel("probe", "unsatisfied"),
    /미완료 증거 아님/,
    "an unsatisfied probe may be a stale probe, and the label has to say so"
  );
});

test("commit branches become one boolean per branch", () => {
  const payload = built([
    issue({
      verdict: VERDICTS.LANDED_BUT_UNVERIFIED,
      commitBranches: ["develop"],
      signals: [{ kind: "commits", resolved: false, detail: "1 commit", branches: ["develop"] }],
    }),
  ]);
  assert.deepEqual(payload.issues[0].signals.commits, { develop: true, main: false });
});

test("a recorded blocker is carried as presence, never as its sentence", () => {
  const payload = built([
    issue({
      verdict: VERDICTS.BLOCKED,
      blockedOn: "whether any promotion is live in production right now",
      signals: [probe("develop", { blockedOn: "whether any promotion is live" })],
    }),
  ]);
  const [row] = payload.issues;
  assert.equal(row.blockedOnPresent, true);
  assert.equal(JSON.stringify(row).includes("promotion is live"), false);
});

test("every issue gets a row, in ascending id order, with no filter", () => {
  const payload = built([
    issue({ number: 900 }),
    issue({ number: 12 }),
    issue({ number: 345, verdict: VERDICTS.BLOCKED }),
  ]);
  assert.deepEqual(
    payload.issues.map((row) => row.id),
    ["12", "345", "900"]
  );
});

test("more issues than the row limit fails instead of truncating", () => {
  const classified = Array.from({ length: OBSERVATION_ROW_LIMIT + 1 }, (_, index) =>
    issue({ number: index + 1 })
  );
  const result = buildObservationPayload({ classified });
  assert.equal(result.payload, undefined);
  assert.equal(result.failure.stage, "row_count_exceeded");
});

test("the same issue number twice is a set mismatch", () => {
  const result = buildObservationPayload({ classified: [issue(), issue()] });
  assert.equal(result.failure.stage, "set_mismatch");
});

test("a signal kind the table does not know fails the run", () => {
  const result = buildObservationPayload({
    classified: [issue({ signals: [{ kind: "coverage", ref: "develop", detail: "new" }] })],
  });
  // Dropping it would report less than the source said while looking complete.
  assert.equal(result.failure.stage, "schema_invalid");
  assert.match(result.failure.problem, /coverage/);
});

test("a new field on a known signal also fails the run", () => {
  const result = buildObservationPayload({
    classified: [issue({ signals: [probe("develop", { confidence: 0.5 })] })],
  });
  assert.equal(result.failure.stage, "schema_invalid");
  assert.match(result.failure.problem, /confidence/);
});

test("a verdict the source does not produce fails the run", () => {
  const result = buildObservationPayload({
    classified: [issue({ verdict: "probably_done" })],
  });
  assert.equal(result.failure.stage, "schema_invalid");
});

test("a branch-scoped signal naming an unknown branch fails the run", () => {
  const result = buildObservationPayload({
    classified: [issue({ signals: [probe("release")] })],
  });
  assert.equal(result.failure.stage, "schema_invalid");
  assert.match(result.failure.problem, /release/);
});

test("titles are normalised, and an unusable title fails rather than being stored", () => {
  const payload = built([
    issue({ number: 7, title: "  Tab\there ‮and bidi‬  " }),
  ]);
  assert.equal(payload.issues[0].title, "Tabhere and bidi");

  assert.match(normaliseIssueTitle("‎‏").problem ?? "", /empty/);
  assert.match(
    normaliseIssueTitle("x".repeat(TITLE_MAX_CODE_POINTS + 1)).problem ?? "",
    /longer than/
  );
  // A title at the limit is kept: GitHub's own limit is this number.
  assert.equal(
    normaliseIssueTitle("x".repeat(TITLE_MAX_CODE_POINTS)).title.length,
    TITLE_MAX_CODE_POINTS
  );
  // Markup stays as text; it is escaped where it is rendered, not here.
  assert.equal(normaliseIssueTitle("<script>alert(1)</script>").title, "<script>alert(1)</script>");
});

test("the issue body is never part of a row", () => {
  const payload = built([
    issue({
      // Whatever else the report carries, only the named fields are read.
      body: "a long issue body with private detail",
      remainder: "still to do: the thing",
      signals: [probe("develop")],
    }),
  ]);
  const serialised = JSON.stringify(payload);
  assert.equal(serialised.includes("private detail"), false);
  assert.equal(serialised.includes("still to do"), false);
});

test("a payload this module built validates, and a tampered one does not", () => {
  const payload = built([
    issue({ signals: [probe("develop", { resolved: true }), pricing("main")] }),
  ]);
  assert.deepEqual(validateObservationPayload(payload), { ok: true });

  const withExtraKey = structuredClone(payload);
  withExtraKey.issues[0].recommended = true;
  assert.match(
    validateObservationPayload(withExtraKey).problems.join("\n"),
    /keys .* are not exactly/
  );

  const withFreeString = structuredClone(payload);
  withFreeString.issues[0].missingFrom = ["https://example.invalid/?secret=1"];
  assert.match(
    validateObservationPayload(withFreeString).problems.join("\n"),
    /ordered subset/
  );

  const withBadId = structuredClone(payload);
  withBadId.issues[0].id = "0";
  assert.match(validateObservationPayload(withBadId).problems.join("\n"), /is not an issue id/);

  const withWrongVersion = structuredClone(payload);
  withWrongVersion.schemaVersion = OBSERVATION_SCHEMA_VERSION + 1;
  assert.match(
    validateObservationPayload(withWrongVersion).problems.join("\n"),
    /schemaVersion/
  );
});

test("a count that disagrees with the rows is refused", () => {
  const payload = built([issue(), issue({ number: 700 })]);
  assert.deepEqual(validateObservationPayload(payload), { ok: true });

  const inflated = structuredClone(payload);
  inflated.counts.byVerdict[VERDICTS.OPEN_WORK] += 1;
  assert.match(
    validateObservationPayload(inflated).problems.join("\n"),
    /disagree with payload.issues/
  );

  const inflatedBlindSpot = structuredClone(payload);
  inflatedBlindSpot.blindSpots.noSignalIssues = 99;
  assert.match(
    validateObservationPayload(inflatedBlindSpot).problems.join("\n"),
    /disagree with payload.issues/
  );
});

test("rows out of ascending order are refused on the way in", () => {
  const payload = built([issue({ number: 10 }), issue({ number: 20 })]);
  const swapped = structuredClone(payload);
  swapped.issues.reverse();
  assert.match(
    validateObservationPayload(swapped).problems.join("\n"),
    /ascending order/
  );
});

test("the summary can be recomputed from the rows alone", () => {
  const payload = built([
    issue({ number: 1, verdict: VERDICTS.OPEN_WORK }),
    issue({
      number: 2,
      verdict: VERDICTS.RESOLVED_NOT_ON_ALL_BRANCHES,
      resolvedOn: ["develop"],
      missingFrom: ["main"],
      signals: [probe("develop", { resolved: true })],
    }),
  ]);
  assert.deepEqual(summariseObservation(payload.issues), {
    counts: payload.counts,
    blindSpots: payload.blindSpots,
  });
  assert.equal(payload.counts.byVerdict[VERDICTS.OPEN_WORK], 1);
  assert.equal(payload.blindSpots.oneBranchOnly, 1);
});

test("every enum value a row can carry has a label, and no label invents a conclusion", () => {
  const groups = {
    verdict: Object.values(VERDICTS),
    probe: PROBE_STATES,
    pricing: PRICING_STATES,
    commits: ["true", "false"],
    branch: OBSERVED_BRANCHES,
    failureStage: OBSERVATION_FAILURE_STAGES,
  };
  for (const [group, values] of Object.entries(groups)) {
    for (const value of values) {
      assert.ok(
        observationLabel(group, value),
        `${group} value ${value} has no label, so a row carrying it cannot be shown`
      );
    }
    // And no label for a value the source cannot produce: a stale label is how
    // a renamed enum goes unnoticed.
    assert.deepEqual(
      Object.keys(OBSERVATION_LABELS[group]).sort(),
      [...values].sort(),
      `${group} labels do not match the values exactly`
    );
  }

  for (const [group, labels] of Object.entries(OBSERVATION_LABELS)) {
    for (const [value, label] of Object.entries(labels)) {
      const withoutAllowed = ALLOWED_LABEL_PHRASES.reduce(
        (text, phrase) => text.split(phrase).join(""),
        label
      );
      for (const word of FORBIDDEN_LABEL_WORDS) {
        assert.equal(
          withoutAllowed.includes(word),
          false,
          `${group}.${value} label says "${word}", which the source signals do not support`
        );
      }
    }
  }
});

test("a real report from the CLI becomes a valid payload", () => {
  // The tests above build signals by hand, which proves the rules and not the
  // shapes: if the source adds a field or renames a kind, only running the real
  // CLI notices. This one does, over a real git repository.
  const fixture = makeIssueBacklogFixture({
    number: 636,
    title: "Deprecate creation of fixed-amount billing promotions",
  });
  try {
    const result = runIssueBacklogCli(fixture.pinnedArgs());
    assert.equal(result.status, 0, result.stderr);

    const built = buildObservationPayload(JSON.parse(result.stdout));
    assert.equal(built.failure, undefined, JSON.stringify(built.failure));
    assert.deepEqual(validateObservationPayload(built.payload), { ok: true });

    const [row] = built.payload.issues;
    assert.equal(row.id, "636");
    assert.equal(row.verdict, VERDICTS.LANDED_BUT_UNVERIFIED);
    // The commit referencing the issue is reachable from the pinned develop
    // commit and not from the pinned main commit.
    assert.deepEqual(row.signals.commits, { develop: true, main: false });
  } finally {
    fixture.cleanUp();
  }
});

test("the branches this table reports are the ones the report evaluates", () => {
  // Two copies exist: the CLI has no reason to import app code, and the app has
  // no reason to run the CLI. A third branch added to one and not the other
  // would silently drop a column.
  const cli = readFileSync(
    new URL("../scripts/report-issue-backlog.mjs", import.meta.url),
    "utf8"
  );
  const match = cli.match(/const RELEASE_BRANCHES = \[([^\]]+)\]/);
  assert.ok(match, "the CLI no longer declares RELEASE_BRANCHES as a literal");
  const names = match[1]
    .split(",")
    .map((part) => part.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  assert.deepEqual(names, OBSERVED_BRANCHES);
});

test("silence is judged against an anchor that outlives the rows", () => {
  const now = Date.parse("2026-10-03T00:00:00.000Z");
  const hours = (count) => now - count * 60 * 60 * 1000;
  const verdict = (input) => observationSilenceVerdict({ now, ...input });

  // An unset switch is a state an operator chose.
  assert.deepEqual(verdict({ enabled: false, lastSuccessAt: hours(100), enabledSince: hours(200) }), {
    state: "disabled",
    sinceHours: null,
    measuredFrom: null,
  });

  // Switched on with no anchor recorded yet. Reported rather than read as
  // either silence or health: the caller writes the anchor on the same pass, so
  // it lasts one run.
  for (const missing of [null, undefined, Number.NaN]) {
    assert.equal(
      verdict({ enabled: true, lastSuccessAt: null, enabledSince: missing }).state,
      "anchor_missing",
      String(missing),
    );
  }

  // A switch turned on a minute ago has no success and must not page anybody.
  assert.deepEqual(verdict({ enabled: true, lastSuccessAt: null, enabledSince: hours(1) }), {
    state: "no_observation_yet",
    sinceHours: 1,
    measuredFrom: "enabled_since",
  });

  // But an agent that has never once worked -- service switch never set, secret
  // wrong, first run hung -- has no last success to go stale, and keyed on the
  // last success alone this would never be reported at all.
  assert.equal(OBSERVATION_SILENCE_HOURS, 26);
  const never = verdict({ enabled: true, lastSuccessAt: null, enabledSince: hours(72) });
  assert.equal(never.state, "silent");
  assert.equal(never.measuredFrom, "enabled_since");

  // One slot a day plus its one-hour window is 25, so a late-but-inside-the-
  // window run is not an incident and a wholly missed slot is.
  for (const [age, expected] of [
    [25, "recent"],
    [25.9, "recent"],
    [26, "silent"],
    [100, "silent"],
  ]) {
    const judged = verdict({ enabled: true, lastSuccessAt: hours(age), enabledSince: hours(500) });
    assert.equal(judged.state, expected, String(age));
    assert.equal(judged.measuredFrom, "last_success", String(age));
  }

  // An agent silent for longer than the retention period has no rows left, and
  // the alarm must not stop exactly when the silence got long enough to matter.
  const swept = verdict({
    enabled: true,
    lastSuccessAt: null,
    enabledSince: hours(OBSERVATION_RETENTION_DAYS * 24 + 48),
  });
  assert.equal(swept.state, "silent");

  // A reference point in the future is the app's clock disagreeing with the
  // database's. Read as `recent` it would silence the check for as long as the
  // disagreement lasted.
  assert.equal(
    verdict({ enabled: true, lastSuccessAt: hours(-5), enabledSince: hours(500) }).state,
    "silent",
  );

  // The hours are the real figure rather than the threshold, so an incident can
  // say how long it has been.
  assert.equal(
    Math.round(verdict({ enabled: true, lastSuccessAt: hours(31), enabledSince: hours(500) }).sinceHours),
    31,
  );
});

const SLOT_DAY = 24 * 60 * 60 * 1000;
const END_SLOT = "2026-10-02T21:30:00.000Z";

/** `pattern` is newest-first: "o" ok, "f" failed, "." no row at all. */
const seriesFromPattern = (pattern) => {
  const end = Date.parse(END_SLOT);
  const rows = [];
  for (const [index, mark] of [...pattern].entries()) {
    if (mark === ".") continue;
    rows.push({
      slot: new Date(end - index * SLOT_DAY),
      outcome: mark === "o" ? "ok" : "failed",
      failureStage: mark === "o" ? null : "timeout",
    });
  }
  return observationSlotSeries(rows, { endSlot: END_SLOT, count: pattern.length });
};

test("a slot nothing ran on is in the series, because that night is the question", () => {
  // A list of stored rows cannot show a night nothing ran: two neighbouring
  // rows look consecutive whatever is missing between them.
  const series = seriesFromPattern("o.o");
  assert.deepEqual(
    series.map((entry) => entry.state),
    ["ok", "missing", "ok"],
  );
  assert.deepEqual(
    series.map((entry) => entry.slot),
    ["2026-10-02T21:30:00.000Z", "2026-10-01T21:30:00.000Z", "2026-09-30T21:30:00.000Z"],
  );
  // A failed slot keeps its stage, so the screen can say what stopped it.
  assert.equal(seriesFromPattern("f")[0].failureStage, "timeout");
});

test("two rows for one slot are reported, not reduced to one", () => {
  // The unique constraint makes this impossible, which is exactly why a series
  // that found one must say so rather than pick a row and carry on.
  const slot = new Date(Date.parse(END_SLOT));
  const series = observationSlotSeries(
    [
      { slot, outcome: "ok", failureStage: null },
      { slot, outcome: "failed", failureStage: "timeout" },
    ],
    { endSlot: END_SLOT, count: 1 },
  );
  assert.equal(series[0].state, "duplicate");
});

test("the staging window restarts at a break instead of counting around it", () => {
  assert.equal(P1_WINDOW_SLOTS, 14);

  const clean = p1WindowJudgement(seriesFromPattern("o".repeat(14)));
  assert.equal(clean.consecutiveOk, 14);
  assert.equal(clean.met, true);
  assert.equal(clean.brokenAt, null);

  // Thirteen clean nights behind one bad one is not fourteen consecutive
  // anything, and the policy says the count starts again.
  for (const [pattern, expected] of [
    ["f" + "o".repeat(14), { consecutiveOk: 0, state: "failed" }],
    ["." + "o".repeat(14), { consecutiveOk: 0, state: "missing" }],
    ["o".repeat(13) + "f" + "o".repeat(14), { consecutiveOk: 13, state: "failed" }],
    ["o".repeat(13) + "." + "o", { consecutiveOk: 13, state: "missing" }],
  ]) {
    const judgement = p1WindowJudgement(seriesFromPattern(pattern));
    assert.equal(judgement.consecutiveOk, expected.consecutiveOk, pattern.slice(0, 20));
    assert.equal(judgement.met, false, pattern.slice(0, 20));
    assert.equal(judgement.brokenAt.state, expected.state);
  }
});

test("the production window tolerates three bad nights in thirty and not four", () => {
  assert.equal(P2_WINDOW_SLOTS, 30);
  assert.equal(P2_MIN_SUCCESSES, 27);

  const met = p2WindowJudgement(seriesFromPattern("o".repeat(27) + "fff"));
  assert.equal(met.successes, 27);
  assert.equal(met.verdict, "met");

  const notMet = p2WindowJudgement(seriesFromPattern("o".repeat(26) + "ffff"));
  assert.equal(notMet.successes, 26);
  assert.equal(notMet.verdict, "not_met");

  // Unlike P1, the successes need not be consecutive: this asks whether it
  // keeps working, not whether it works at all.
  const scattered = p2WindowJudgement(seriesFromPattern("ofoofo" + "o".repeat(23) + "f"));
  assert.equal(scattered.observedSlots, 30);
  assert.equal(scattered.verdict, "met");

  // An integrity failure is not something a run of successes makes up for.
  const slot = new Date(Date.parse(END_SLOT));
  const duplicated = observationSlotSeries(
    [
      { slot, outcome: "ok", failureStage: null },
      { slot, outcome: "ok", failureStage: null },
      ...Array.from({ length: 29 }, (_unused, index) => ({
        slot: new Date(slot.getTime() - (index + 1) * SLOT_DAY),
        outcome: "ok",
        failureStage: null,
      })),
    ],
    { endSlot: END_SLOT, count: 30 },
  );
  const withDuplicate = p2WindowJudgement(duplicated);
  assert.equal(withDuplicate.successes, 29);
  assert.equal(withDuplicate.duplicates, 1);
  assert.equal(withDuplicate.verdict, "not_met");
});

test("a window shorter than itself is insufficient evidence, not a verdict", () => {
  // 27 of 30 cannot be read off twelve slots in either direction, and calling
  // it a failure would block the phase for not having waited.
  const short = p2WindowJudgement(seriesFromPattern("o".repeat(12)));
  assert.equal(short.observedSlots, 12);
  assert.equal(short.verdict, "insufficient_evidence");
  // P1 has no such state: fewer than fourteen consecutive is simply not
  // fourteen, and the number it reached is the whole answer.
  assert.equal(p1WindowJudgement(seriesFromPattern("o".repeat(12))).consecutiveOk, 12);
  assert.equal(p1WindowJudgement(seriesFromPattern("o".repeat(12))).met, false);
});

test("a failed or missing slot does not get an earlier success's rows", () => {
  // The screen asks what the backlog looks like now. An earlier success's rows
  // under a failed or missing slot would be an earlier success's content on a
  // screen reporting no update, which the policy forbids
  // (docs/policy/product-research-agent.md §2, condition 8). Yesterday's
  // observation is not wrong; it is not the answer to the question the heading
  // asks.
  const current = seriesFromPattern("o" + "o".repeat(5));
  assert.deepEqual(displayableObservationSlot(current, { everRecorded: true }), {
    slot: END_SLOT,
    omitted: "none",
  });

  for (const pattern of ["f" + "o".repeat(5), "." + "o".repeat(5)]) {
    const judged = displayableObservationSlot(seriesFromPattern(pattern), {
      everRecorded: true,
    });
    assert.equal(judged.slot, null, pattern);
    // Named apart from "nothing was ever recorded": the two look identical on
    // an empty screen and only this one is a fault.
    assert.equal(judged.omitted, "current_slot_not_recorded", pattern);
  }

  const never = displayableObservationSlot(seriesFromPattern("." + "."), {
    everRecorded: false,
  });
  assert.equal(never.slot, null);
  assert.equal(never.omitted, "never_recorded");

  // `everRecorded` is any row, not a successful one. A table holding nothing
  // but failures must not be captioned "nothing was ever recorded": that
  // contradicts the failures printed above it.
  const failuresOnly = displayableObservationSlot(seriesFromPattern("fff"), {
    everRecorded: true,
  });
  assert.equal(failuresOnly.slot, null);
  assert.equal(failuresOnly.omitted, "current_slot_not_recorded");

  // An empty series answers rather than throwing: a screen rendered before any
  // slot exists must not be a crash.
  assert.deepEqual(displayableObservationSlot([], {}), {
    slot: null,
    omitted: "never_recorded",
  });
  assert.deepEqual(displayableObservationSlot(undefined, { everRecorded: true }), {
    slot: null,
    omitted: "current_slot_not_recorded",
  });

  // A duplicate is not a displayable slot either: the one thing it is certain
  // of is that the stored state is wrong.
  const duplicated = [{ slot: END_SLOT, state: "duplicate" }];
  assert.equal(displayableObservationSlot(duplicated, { everRecorded: true }).slot, null);
});
