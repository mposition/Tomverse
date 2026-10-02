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
