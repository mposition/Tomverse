// The product-research observation table: what the issue backlog report said,
// carried over without being re-judged.
//
// `scripts/report-issue-backlog-core.mjs` decides every verdict. This module
// only rearranges that output into one row per open issue with the three
// signals kept apart per release branch, so a reader can see which branch a
// signal came from instead of a merged answer. It recommends nothing, ranks
// nothing and drops no issue: a report with more issues than the row limit
// fails rather than being truncated, because a truncated list read as "these
// are the open issues" is worse than no list.
//
// Everything here is pure. No git, no network, no database, no clock: the
// caller passes `computedAt`, so the same report always produces the same rows.
//
// Plain `.mjs` with no dependency, deliberately: the runner that produces a
// payload and the app route that re-validates it before storing have to agree
// exactly, and the only way to be sure is for both to call these functions.

import { createHash } from "node:crypto";

import { VERDICTS } from "../scripts/report-issue-backlog-core.mjs";

/** The schema the payload declares. Bumped when a stored payload's shape changes. */
export const OBSERVATION_SCHEMA_VERSION = 1;

/**
 * The branches the report evaluates, in promotion order.
 *
 * `scripts/report-issue-backlog.mjs` has its own copy; the test holds the two
 * equal. They are separate because that script is a CLI with no reason to
 * import app code, and this module is read by the app.
 */
export const OBSERVED_BRANCHES = ["develop", "main"];

/** One row per open issue, at most this many. Beyond it the run fails. */
export const OBSERVATION_ROW_LIMIT = 200;

/** GitHub's own issue-title limit, which a normalised title may not exceed. */
export const TITLE_MAX_CODE_POINTS = 256;

/**
 * How long a row is kept, and the earliest it may be removed.
 *
 * Both halves are one number: the retention trigger refuses a delete before it
 * and the maintenance sweep removes rows after it. Written here rather than in
 * either of them so the two cannot drift, and repeated in the migration under
 * `-- retention: OBSERVATION_RETENTION_DAYS` where a test compares them.
 */
export const OBSERVATION_RETENTION_DAYS = 90;

const VERDICT_VALUES = Object.values(VERDICTS);

/** What a branch's probe signals add up to, strongest-doubt-first. */
export const PROBE_STATES = ["none", "unavailable", "unsatisfied", "satisfied"];
/** Pricing has no "unavailable": the parser either read the module or did not. */
export const PRICING_STATES = ["none", "unsatisfied", "satisfied"];

/**
 * How a slot ended.
 *
 * Two values, and a failed slot carries no payload -- the shape CHECK in the
 * migration is what makes that true rather than a convention the writer keeps.
 */
export const OBSERVATION_OUTCOMES = ["ok", "failed"];

/**
 * Failure stages a run can end in. Closed on purpose: a stage name is stored
 * and displayed, so a new one is a schema change and not a free string.
 */
export const OBSERVATION_FAILURE_STAGES = [
  "clone_failed",
  "release_branch_unavailable",
  "issue_fetch_failed",
  "issue_input_too_large",
  "issue_backlog_failed",
  "schema_invalid",
  "set_mismatch",
  "count_mismatch",
  "row_count_exceeded",
  "timeout",
];

/**
 * What a person reads instead of the raw enum.
 *
 * The source vocabulary is about signals, and read without help it invites the
 * opposite conclusion: `open_work` means "no signal was found", not "this is
 * unfinished", and an unsatisfied probe may only mean the probe is stale. Every
 * label that could be read as a completion claim says so in the label itself.
 */
export const OBSERVATION_LABELS = {
  verdict: {
    [VERDICTS.RESOLVED_IN_CODE]:
      "평가된 모든 branch에서 내용 신호 충족(이슈는 열림)",
    [VERDICTS.CODE_COMPLETE_REMAINDER]:
      "내용 신호 충족, 원천에 잔여 조건 기록 있음",
    [VERDICTS.RESOLVED_NOT_ON_ALL_BRANCHES]:
      "일부 branch에서만 내용 신호 충족",
    [VERDICTS.LANDED_BUT_UNVERIFIED]:
      "이슈를 언급한 commit 있음, 완료 조건 미검증",
    [VERDICTS.BLOCKED]: "원천에 blockedOn 기록 있음",
    [VERDICTS.OPEN_WORK]: "완료 신호 없음(미완료 증거 아님)",
  },
  probe: {
    none: "probe 없음",
    unavailable: "probe 판정 불가",
    unsatisfied: "probe 조건 불충족(미완료 증거 아님)",
    satisfied: "probe 조건 충족",
  },
  pricing: {
    none: "가격 신호 없음",
    unsatisfied: "가격 조건 불충족(미완료 증거 아님)",
    satisfied: "가격 조건 충족",
  },
  commits: {
    true: "있음",
    false: "없음",
  },
  branch: {
    develop: "develop",
    main: "main",
  },
  // A slot's state on the screen. `missing` is the one that needs saying:
  // a night with no row is not a night with nothing to report, it is a night
  // nobody can answer for.
  slotState: {
    ok: "관측 기록됨",
    failed: "회차 실패",
    missing: "기록 없음(관측 자체가 없음)",
    duplicate: "한 slot에 행 2개 이상(정합성 이상)",
  },
  failureStage: {
    clone_failed: "실패 단계: clone_failed",
    release_branch_unavailable: "실패 단계: release_branch_unavailable",
    issue_fetch_failed: "실패 단계: issue_fetch_failed",
    issue_input_too_large: "실패 단계: issue_input_too_large",
    issue_backlog_failed: "실패 단계: issue_backlog_failed",
    schema_invalid: "실패 단계: schema_invalid",
    set_mismatch: "실패 단계: set_mismatch",
    count_mismatch: "실패 단계: count_mismatch",
    row_count_exceeded: "실패 단계: row_count_exceeded",
    timeout: "실패 단계: timeout",
  },
};

/** The one sentence the section always carries. */
export const OBSERVATION_HEADING = "이 표는 추천이 아닙니다";

/**
 * Words a label may not contain, because each of them states a conclusion the
 * source signals do not support.
 */
export const FORBIDDEN_LABEL_WORDS = [
  "추천",
  "우선",
  "다음 작업",
  "착수",
  "미완료",
  "완료 확정",
];

/** The only phrases allowed to contain one of those words. */
export const ALLOWED_LABEL_PHRASES = ["미완료 증거 아님", OBSERVATION_HEADING];

const CONTROL_AND_BIDI = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/gu;

/**
 * An issue title with the bytes that make a stored string unsafe to display
 * removed, or a problem if nothing legible is left.
 *
 * Titles come from whoever opened the issue, so they are data: control
 * characters and bidi overrides are stripped rather than escaped, because a
 * right-to-left override inside a title reorders the rest of the row when it is
 * rendered. The rest -- quotes, angle brackets, anything else -- is kept and
 * rendered as text.
 */
export const normaliseIssueTitle = (value) => {
  if (typeof value !== "string") return { problem: "title is not a string" };
  const stripped = value.normalize("NFC").replace(CONTROL_AND_BIDI, "").trim();
  const length = [...stripped].length;
  if (length === 0) return { problem: "title is empty once normalised" };
  if (length > TITLE_MAX_CODE_POINTS) {
    return { problem: `title is longer than ${TITLE_MAX_CODE_POINTS} code points` };
  }
  return { title: stripped };
};

const ISSUE_ID_PATTERN = /^[1-9][0-9]{0,5}$/;

/** Signal keys this module knows how to read, per kind. */
const KNOWN_SIGNAL_KEYS = {
  probe: new Set(["kind", "ref", "resolved", "unavailable", "remainder", "blockedOn", "detail"]),
  pricing: new Set(["kind", "ref", "resolved", "detail"]),
  commits: new Set(["kind", "resolved", "detail", "branches"]),
};

/**
 * One branch's probe state.
 *
 * Doubt wins over satisfaction: a branch with one unreadable probe and one
 * satisfied probe is `unavailable`, because the unreadable one proves nothing
 * and reporting `satisfied` would claim it did.
 */
const probeState = (signals) => {
  if (signals.length === 0) return "none";
  if (signals.some((signal) => signal.unavailable === true)) return "unavailable";
  if (signals.some((signal) => signal.resolved !== true)) return "unsatisfied";
  return "satisfied";
};

const pricingState = (signals) => {
  if (signals.length === 0) return "none";
  if (signals.some((signal) => signal.resolved !== true)) return "unsatisfied";
  return "satisfied";
};

const emptyByBranch = (value) =>
  Object.fromEntries(OBSERVED_BRANCHES.map((branch) => [branch, value]));

/**
 * sha256 of the payload, serialised with its object keys in sorted order.
 *
 * Canonical, so the same observation digests the same whatever order the
 * runner happened to build its objects in. Arrays keep their order, because
 * the row order is part of what was observed.
 *
 * Here rather than beside the route, because both sides need it and the whole
 * value of the comparison is that there is **one** implementation. The route
 * computes the stored row's digest and answers with it; the runner computes
 * the digest of what it sent and checks the two agree. Two implementations
 * could drift, and a drifted comparison either reports mismatches that are
 * not real or stops reporting the ones that are.
 *
 * It is still the server's digest that is stored. A submitter that sent its
 * own would be attesting to its own payload, which attests to nothing.
 */
export const observationPayloadDigest = (payload) => {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])]),
      );
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical(payload)), "utf8").digest("hex");
};
/**
 * The rows and summary counts for one report, or the stage the run fails at.
 *
 * Failures are stages rather than thrown errors because the caller stores them:
 * a run that could not produce a table still has to say so in the same shape,
 * and "no row today" has to be distinguishable from "nobody ran it".
 */
export const buildObservationPayload = (report) => {
  if (!report || typeof report !== "object" || !Array.isArray(report.classified)) {
    return { failure: { stage: "schema_invalid", problem: "report has no classified array" } };
  }
  if (report.classified.length > OBSERVATION_ROW_LIMIT) {
    return {
      failure: {
        stage: "row_count_exceeded",
        problem: `${report.classified.length} issues, limit ${OBSERVATION_ROW_LIMIT}`,
      },
    };
  }

  const rows = [];
  const seen = new Set();
  for (const issue of report.classified) {
    const id = String(issue?.number ?? "");
    if (!ISSUE_ID_PATTERN.test(id)) {
      return {
        failure: { stage: "schema_invalid", problem: `issue number ${id} is not an id` },
      };
    }
    if (seen.has(id)) {
      // The same number twice would double a count and halve a denominator.
      return { failure: { stage: "set_mismatch", problem: `issue ${id} appears twice` } };
    }
    seen.add(id);

    const normalisedTitle = normaliseIssueTitle(issue.title);
    if (normalisedTitle.problem) {
      return {
        failure: {
          stage: "schema_invalid",
          problem: `issue ${id}: ${normalisedTitle.problem}`,
        },
      };
    }

    if (!VERDICT_VALUES.includes(issue.verdict)) {
      return {
        failure: {
          stage: "schema_invalid",
          problem: `issue ${id}: verdict ${String(issue.verdict)} is not one the source produces`,
        },
      };
    }

    const signals = Array.isArray(issue.signals) ? issue.signals : [];
    const probe = emptyByBranch(null);
    const pricing = emptyByBranch(null);
    const byKind = { probe: emptyByBranch(null), pricing: emptyByBranch(null) };
    for (const branch of OBSERVED_BRANCHES) {
      byKind.probe[branch] = [];
      byKind.pricing[branch] = [];
    }

    for (const signal of signals) {
      const kind = signal?.kind;
      const known = KNOWN_SIGNAL_KEYS[kind];
      if (!known) {
        // A new signal kind is a new fact about the issue. Dropping it would
        // report less than the source said while looking complete.
        return {
          failure: {
            stage: "schema_invalid",
            problem: `issue ${id}: signal kind ${String(kind)} is not one this table knows`,
          },
        };
      }
      for (const key of Object.keys(signal)) {
        if (!known.has(key)) {
          return {
            failure: {
              stage: "schema_invalid",
              problem: `issue ${id}: ${kind} signal carries unknown field ${key}`,
            },
          };
        }
      }
      if (kind === "commits") continue;
      const branch = OBSERVED_BRANCHES.find((name) => signal.ref === name);
      if (!branch) {
        return {
          failure: {
            stage: "schema_invalid",
            problem: `issue ${id}: ${kind} signal names branch ${String(signal.ref)}`,
          },
        };
      }
      byKind[kind][branch].push(signal);
    }

    for (const branch of OBSERVED_BRANCHES) {
      probe[branch] = probeState(byKind.probe[branch]);
      pricing[branch] = pricingState(byKind.pricing[branch]);
    }

    const commitBranches = Array.isArray(issue.commitBranches)
      ? issue.commitBranches
      : [];
    const unknownCommitBranch = commitBranches.find(
      (branch) => !OBSERVED_BRANCHES.includes(branch)
    );
    if (unknownCommitBranch) {
      return {
        failure: {
          stage: "schema_invalid",
          problem: `issue ${id}: commitBranches names ${unknownCommitBranch}`,
        },
      };
    }

    const branchSubset = (value) => {
      const list = Array.isArray(value) ? value : [];
      const unknown = list.find((branch) => !OBSERVED_BRANCHES.includes(branch));
      if (unknown) return { problem: unknown };
      return { list: OBSERVED_BRANCHES.filter((branch) => list.includes(branch)) };
    };

    const resolvedOn = branchSubset(issue.resolvedOn);
    const missingFrom = branchSubset(issue.missingFrom);
    if (resolvedOn.problem || missingFrom.problem) {
      return {
        failure: {
          stage: "schema_invalid",
          problem: `issue ${id}: branch list names ${resolvedOn.problem ?? missingFrom.problem}`,
        },
      };
    }

    rows.push({
      id,
      title: normalisedTitle.title,
      verdict: issue.verdict,
      resolvedOn: resolvedOn.list,
      missingFrom: missingFrom.list,
      signals: {
        probe,
        pricing,
        commits: Object.fromEntries(
          OBSERVED_BRANCHES.map((branch) => [branch, commitBranches.includes(branch)])
        ),
      },
      // The sentence is dropped on purpose: it is free text from the probe, and
      // whether the source recorded a blocker is the whole fact this carries.
      blockedOnPresent: typeof issue.blockedOn === "string" && issue.blockedOn.length > 0,
    });
  }

  rows.sort((left, right) => Number(left.id) - Number(right.id));

  return {
    payload: {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      issues: rows,
      ...summariseObservation(rows),
    },
  };
};

/**
 * What one stored payload adds up to, for a screen to render.
 *
 * Recounted from the rows rather than read off the payload: `summariseObservation()`
 * exists so a reader can rederive what a payload claims and compare, and the route
 * already refuses a submission whose counts do not rederive. A disagreement here is
 * therefore a stored row that stopped matching its own rows, which is worth saying
 * rather than quietly showing one of the two.
 *
 * Every verdict the vocabulary has, in the label table's order and including the
 * zeroes: a distribution with the zeroes dropped cannot be compared against another
 * one, because "this verdict did not occur" and "this verdict is not in that build"
 * would look the same. The vocabulary comes from the label table so the screen can
 * only count verdicts it is also able to name.
 *
 * `null` when the payload has no shape to say it. An unknown count is not a zero.
 */
export const observationSummaryView = (payload) => {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.issues)) return null;
  let rederived;
  try {
    rederived = summariseObservation(payload.issues);
  } catch {
    return null;
  }
  const counted = rederived?.counts?.byVerdict;
  if (!isCountRecord(counted)) return null;
  const vocabulary = Object.keys(OBSERVATION_LABELS.verdict);
  // A row whose verdict is not in the vocabulary adds a key of its own, and
  // `undefined + 1` is NaN -- which is a number, so the shape check above lets
  // it through. The six known verdicts then all read zero beside a non-zero row
  // count, and an empty stored record agrees with them, so the screen would show
  // a measurement nobody made. The totals have to account for every row.
  const total = vocabulary.reduce((sum, verdict) => sum + (counted[verdict] ?? 0), 0);
  if (total !== payload.issues.length) return null;
  const stored = payload.counts?.byVerdict;
  return {
    issueCount: payload.issues.length,
    verdicts: vocabulary.map((verdict) => ({
      verdict,
      label: observationLabel("verdict", verdict),
      count: counted[verdict] ?? 0,
    })),
    blindSpots: rederived.blindSpots,
    storedCountsAgree:
      isCountRecord(stored) &&
      vocabulary.every((verdict) => (stored[verdict] ?? 0) === (counted[verdict] ?? 0)),
  };
};

/**
 * A record of counts, where a count is a count.
 *
 * `typeof NaN` is `"number"`, and NaN is exactly what an unknown verdict
 * produces, so `number` alone is not the check. Nor is any non-integer or
 * negative value something this ever wrote.
 */
const isCountRecord = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => Number.isInteger(entry) && entry >= 0);
/**
 * The counts, recomputed from the rows.
 *
 * Kept separate from `buildObservationPayload` so a reader of a stored payload
 * can recompute them from the rows it also stores and compare; a count that
 * cannot be rederived is a number nobody can check.
 */
export const summariseObservation = (rows) => {
  const byVerdict = Object.fromEntries(VERDICT_VALUES.map((verdict) => [verdict, 0]));
  let noSignalIssues = 0;
  let oneBranchOnly = 0;

  for (const row of rows) {
    byVerdict[row.verdict] += 1;
    const everySignalMissing = OBSERVED_BRANCHES.every(
      (branch) =>
        row.signals.probe[branch] === "none" && row.signals.pricing[branch] === "none"
    );
    if (everySignalMissing) noSignalIssues += 1;
    if (row.resolvedOn.length > 0 && row.resolvedOn.length < OBSERVED_BRANCHES.length) {
      oneBranchOnly += 1;
    }
  }

  return { counts: { byVerdict }, blindSpots: { noSignalIssues, oneBranchOnly } };
};

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value, keys, where, problems) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    problems.push(`${where}: keys ${actual.join(",")} are not exactly ${expected.join(",")}`);
    return false;
  }
  return true;
};

/**
 * Whether a payload is one this module could have produced.
 *
 * The runner builds a payload and the app route stores it, and in between the
 * payload crosses a network boundary where anything with the submission secret
 * could put something else. So the route re-validates with this function
 * rather than trusting the sender: every object's key set has to match exactly,
 * and every scalar has to be an enum, a bounded integer, a boolean or a
 * normalised title. There is no field a free string, a URL or an object key
 * could hide in.
 */
export const validateObservationPayload = (payload) => {
  const problems = [];
  if (!isPlainObject(payload)) return { problems: ["payload is not an object"] };

  exactKeys(payload, ["schemaVersion", "issues", "counts", "blindSpots"], "payload", problems);
  if (payload.schemaVersion !== OBSERVATION_SCHEMA_VERSION) {
    problems.push(`payload.schemaVersion is not ${OBSERVATION_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(payload.issues)) {
    problems.push("payload.issues is not an array");
    return { problems };
  }
  if (payload.issues.length > OBSERVATION_ROW_LIMIT) {
    problems.push(`payload.issues has more than ${OBSERVATION_ROW_LIMIT} rows`);
  }

  const seen = new Set();
  let previous = -1;
  for (const [index, row] of payload.issues.entries()) {
    const where = `payload.issues[${index}]`;
    if (!isPlainObject(row)) {
      problems.push(`${where} is not an object`);
      continue;
    }
    if (
      !exactKeys(
        row,
        ["id", "title", "verdict", "resolvedOn", "missingFrom", "signals", "blockedOnPresent"],
        where,
        problems
      )
    ) {
      continue;
    }
    if (typeof row.id !== "string" || !ISSUE_ID_PATTERN.test(row.id)) {
      problems.push(`${where}.id is not an issue id`);
    } else {
      if (seen.has(row.id)) problems.push(`${where}.id ${row.id} appears twice`);
      seen.add(row.id);
      const numeric = Number(row.id);
      if (numeric <= previous) problems.push(`${where}.id is out of ascending order`);
      previous = numeric;
    }
    const title = normaliseIssueTitle(row.title);
    if (title.problem) problems.push(`${where}.title ${title.problem}`);
    else if (title.title !== row.title) problems.push(`${where}.title is not normalised`);
    if (!VERDICT_VALUES.includes(row.verdict)) {
      problems.push(`${where}.verdict is not a source verdict`);
    }
    for (const key of ["resolvedOn", "missingFrom"]) {
      const list = row[key];
      if (
        !Array.isArray(list) ||
        list.some((branch) => !OBSERVED_BRANCHES.includes(branch)) ||
        new Set(list).size !== list.length ||
        // Promotion order, so two payloads describing the same thing compare equal.
        list.join(",") !== OBSERVED_BRANCHES.filter((branch) => list.includes(branch)).join(",")
      ) {
        problems.push(`${where}.${key} is not an ordered subset of the release branches`);
      }
    }
    if (typeof row.blockedOnPresent !== "boolean") {
      problems.push(`${where}.blockedOnPresent is not a boolean`);
    }
    if (!isPlainObject(row.signals)) {
      problems.push(`${where}.signals is not an object`);
      continue;
    }
    if (!exactKeys(row.signals, ["probe", "pricing", "commits"], `${where}.signals`, problems)) {
      continue;
    }
    const states = { probe: PROBE_STATES, pricing: PRICING_STATES };
    for (const kind of ["probe", "pricing"]) {
      const group = row.signals[kind];
      if (!isPlainObject(group)) {
        problems.push(`${where}.signals.${kind} is not an object`);
        continue;
      }
      if (!exactKeys(group, OBSERVED_BRANCHES, `${where}.signals.${kind}`, problems)) continue;
      for (const branch of OBSERVED_BRANCHES) {
        if (!states[kind].includes(group[branch])) {
          problems.push(`${where}.signals.${kind}.${branch} is not a ${kind} state`);
        }
      }
    }
    const commits = row.signals.commits;
    if (!isPlainObject(commits)) {
      problems.push(`${where}.signals.commits is not an object`);
    } else if (exactKeys(commits, OBSERVED_BRANCHES, `${where}.signals.commits`, problems)) {
      for (const branch of OBSERVED_BRANCHES) {
        if (typeof commits[branch] !== "boolean") {
          problems.push(`${where}.signals.commits.${branch} is not a boolean`);
        }
      }
    }
  }

  if (!isPlainObject(payload.counts) || !isPlainObject(payload.blindSpots)) {
    problems.push("payload.counts and payload.blindSpots have to be objects");
    return { problems };
  }

  // The counts are checked by recomputing them, not by range: a stored number
  // that disagrees with the rows beside it is the one failure mode that would
  // otherwise be invisible.
  if (problems.length === 0) {
    const recomputed = summariseObservation(payload.issues);
    if (JSON.stringify(recomputed) !== JSON.stringify({ counts: payload.counts, blindSpots: payload.blindSpots })) {
      problems.push("payload.counts or payload.blindSpots disagree with payload.issues");
    }
  }

  return problems.length > 0 ? { problems } : { ok: true };
};

/**
 * Every enum value a row can carry, paired with the label it is displayed as.
 *
 * Used by the completeness test and by the renderer: a value with no label is
 * shown as a failed section rather than as the raw enum, because the raw
 * vocabulary is what the labels exist to translate.
 */
export const observationLabel = (group, value) => {
  const labels = OBSERVATION_LABELS[group];
  if (!labels) return null;
  const key = typeof value === "boolean" ? String(value) : value;
  return Object.prototype.hasOwnProperty.call(labels, key) ? labels[key] : null;
};

/**
 * How long without a successful slot is a problem.
 *
 * One slot a day plus the hour its window is open leaves 25; 26 is that with an
 * hour to spare, so a single late-but-inside-the-window run does not raise an
 * incident and a wholly missed slot does.
 */
export const OBSERVATION_SILENCE_HOURS = 26;

/**
 * Whether the absence of recent observations is worth an incident.
 *
 * Five answers. `disabled` is the switch being unset, which is a state an
 * operator chose, and `recent` is the ordinary one.
 *
 * The other three exist because "no success yet" is not one situation. A switch
 * turned on a minute ago has no success and should not page anybody; a switch
 * turned on three days ago and still with no success is an agent that has never
 * once worked -- the service switch never set, the secret wrong, the first run
 * hung -- and that is the case a check keyed only on the last success would
 * never report, because there would never be a last success to go stale. So the
 * judgement needs an anchor that outlives the rows: `enabledSince`, the first
 * moment the app side was seen switched on.
 *
 * That anchor is also what keeps an ongoing outage reported. Rows are removed
 * after their retention period, so an agent silent for longer than that ends up
 * with no rows at all; keyed on the last success alone the alarm would stop
 * exactly when the silence got long enough to matter.
 *
 * `anchor_missing` is the switch being on with no anchor recorded yet. It is
 * reported rather than read as either silence or health: the caller writes the
 * anchor on the same pass, so it is a state that lasts one run.
 *
 * Typed in JSDoc because TypeScript reads this module from a .mjs file and
 * would otherwise take each parameter's type from its default.
 *
 * @param {{
 *   enabled: boolean,
 *   lastSuccessAt?: number | null,
 *   enabledSince?: number | null,
 *   now: number,
 *   silenceHours?: number,
 * }} input
 * @returns {{
 *   state: "disabled" | "anchor_missing" | "no_observation_yet" | "recent" | "silent",
 *   sinceHours: number | null,
 *   measuredFrom: "last_success" | "enabled_since" | null,
 * }}
 */
export const observationSilenceVerdict = ({
  enabled,
  lastSuccessAt,
  enabledSince = null,
  now,
  silenceHours = OBSERVATION_SILENCE_HOURS,
}) => {
  if (!enabled) return { state: "disabled", sinceHours: null, measuredFrom: null };

  const success = Number(lastSuccessAt);
  const anchor = Number(enabledSince);
  const haveSuccess = lastSuccessAt !== null && lastSuccessAt !== undefined && Number.isFinite(success);
  const haveAnchor = enabledSince !== null && enabledSince !== undefined && Number.isFinite(anchor);

  if (!haveSuccess && !haveAnchor) {
    return { state: "anchor_missing", sinceHours: null, measuredFrom: null };
  }

  // The later of the two when both exist, which is the last success: an anchor
  // cannot be after the first success it preceded. Taking the later one anyway
  // means a clock that disagrees cannot make the window look longer than it is.
  const from = haveSuccess && haveAnchor ? Math.max(success, anchor) : haveSuccess ? success : anchor;
  const measuredFrom = haveSuccess && from === success ? "last_success" : "enabled_since";

  const sinceHours = (Number(now) - from) / (60 * 60 * 1000);
  if (!Number.isFinite(sinceHours)) {
    return { state: "anchor_missing", sinceHours: null, measuredFrom: null };
  }
  // A reference point in the future is a clock that disagrees with the
  // database's, and reading it as "very recent" would silence the check for as
  // long as the disagreement lasted.
  if (sinceHours < 0) return { state: "silent", sinceHours, measuredFrom };
  if (sinceHours < silenceHours) {
    // Inside the window and nothing recorded yet: a switch just turned on.
    return {
      state: haveSuccess ? "recent" : "no_observation_yet",
      sinceHours,
      measuredFrom,
    };
  }
  return { state: "silent", sinceHours, measuredFrom };
};

/**
 * How many consecutive clean slots the staging window asks for
 * (docs/policy/product-research-agent.md §9).
 */
export const P1_WINDOW_SLOTS = 14;
/**
 * The production window, and the successes it asks for inside it
 * (docs/policy/product-research-agent.md §9).
 */
export const P2_WINDOW_SLOTS = 30;
export const P2_MIN_SUCCESSES = 27;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One entry per scheduled slot, newest first, including the slots with no row.
 *
 * A missing slot is the point of this: a list of stored rows cannot show a
 * night nothing ran, and that night is exactly what the window asks about. The
 * series is built backwards from `endSlot` a day at a time, so a gap becomes a
 * `missing` entry rather than two neighbouring rows that look consecutive.
 *
 * `rows` is whatever the table holds; anything outside the series is ignored,
 * and two rows for one slot cannot occur because the slot is unique -- if one
 * ever did, it is reported as `duplicate` rather than silently reduced to one.
 * The four states, named for TypeScript: a reader in TypeScript would
 * otherwise see `string` and could not tell this list from any other.
 *
 * @typedef {"ok" | "failed" | "missing" | "duplicate"} ObservationSlotState
 *
 * @param {{slot: Date | string, outcome?: string, failureStage?: string | null}[]} rows
 * @param {{endSlot: string, count: number}} options
 * @returns {{slot: string, state: ObservationSlotState, failureStage: string | null}[]}
 */
export const observationSlotSeries = (rows, { endSlot, count }) => {
  const bySlot = new Map();
  const duplicated = new Set();
  for (const row of rows ?? []) {
    const key = new Date(row.slot).toISOString();
    if (bySlot.has(key)) duplicated.add(key);
    else bySlot.set(key, row);
  }

  const end = Date.parse(endSlot);
  const series = [];
  for (let index = 0; index < count; index += 1) {
    const slot = new Date(end - index * DAY_MS).toISOString();
    const row = bySlot.get(slot);
    series.push({
      slot,
      state: duplicated.has(slot)
        ? "duplicate"
        : row === undefined
          ? "missing"
          : row.outcome === "ok"
            ? "ok"
            : "failed",
      failureStage: row?.failureStage ?? null,
    });
  }
  return series;
};

/**
 * The staging window, counted from the newest slot backwards.
 *
 * Any state other than `ok` ends the count, which is the policy's "the window
 * restarts from the beginning": counting around a broken slot would not be
 * fourteen consecutive anything. The judgement is reported, never applied --
 * the phase transition is the operator's to sign.
 */
export const p1WindowJudgement = (series, { windowSlots = P1_WINDOW_SLOTS } = {}) => {
  let consecutive = 0;
  let brokenAt = null;
  for (const entry of series) {
    if (entry.state === "ok") {
      consecutive += 1;
      continue;
    }
    brokenAt = { slot: entry.slot, state: entry.state };
    break;
  }
  return {
    windowSlots,
    consecutiveOk: consecutive,
    met: consecutive >= windowSlots,
    brokenAt,
  };
};

/**
 * The production window: successes out of the last N slots, not consecutively.
 *
 * Different question from P1 on purpose. P1 asks whether the thing works at
 * all, so one break restarts it; this asks whether it keeps working, so three
 * bad nights in thirty are tolerated and a fourth is not.
 *
 * A series shorter than the window is `insufficient_evidence`, not a failure
 * and not a pass: 27 of 30 cannot be read off 12 slots either way.
 */
export const p2WindowJudgement = (
  series,
  { windowSlots = P2_WINDOW_SLOTS, minSuccesses = P2_MIN_SUCCESSES } = {}
) => {
  const window = series.slice(0, windowSlots);
  const successes = window.filter((entry) => entry.state === "ok").length;
  const duplicates = window.filter((entry) => entry.state === "duplicate").length;
  return {
    windowSlots,
    minSuccesses,
    observedSlots: window.length,
    successes,
    duplicates,
    verdict:
      window.length < windowSlots
        ? "insufficient_evidence"
        : // A duplicate is an integrity failure, and the policy's window asks for
          // none: a window with one is not met however many successes it has.
          duplicates > 0 || successes < minSuccesses
          ? "not_met"
          : "met",
  };
};

/**
 * Which slot's rows a screen may display, and why not when it may not.
 *
 * The screen asks what the backlog looks like now, and only the slot that just
 * passed answers that. An earlier success's rows under a failed or missing slot
 * would be an earlier success's content on a screen reporting no update, which
 * the policy forbids (docs/policy/product-research-agent.md §2, condition 8).
 * Yesterday's observation is not wrong; it is not the answer to the question
 * the heading asks.
 *
 * The two absences are named separately because they look identical on an
 * empty screen and only one of them is a fault: nothing was ever recorded, or
 * the slot that just passed has no observation.
 *
 * @param {{slot: string, state: string}[]} series Newest first.
 * `everRecorded` is whether this agent has any row at all, successful or
 * not -- a caller passing only its successes would caption a table of
 * failures as nothing having been recorded.
 *
 * @param {{everRecorded?: boolean}} [options]
 * @returns {{slot: string, omitted: "none"}
 *   | {slot: null, omitted: "never_recorded" | "current_slot_not_recorded"}}
 */
export const displayableObservationSlot = (series, { everRecorded = false } = {}) => {
  const current = series?.[0];
  if (current !== undefined && current.state === "ok") {
    return { slot: current.slot, omitted: "none" };
  }
  return {
    slot: null,
    omitted: everRecorded ? "current_slot_not_recorded" : "never_recorded",
  };
};
