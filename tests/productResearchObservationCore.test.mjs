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
  OBSERVATION_SCHEMA_VERSION,
  OBSERVED_BRANCHES,
  PRICING_STATES,
  PROBE_STATES,
  TITLE_MAX_CODE_POINTS,
  buildObservationPayload,
  normaliseIssueTitle,
  observationLabel,
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
