// Where a long goal stands against its step checklist, counted from the
// Goal-Step line in each pull request body (AGENTS.md, "긴 목표는 단계에 묶어
// 둡니다"). Pure: no file, network or clock access -- the caller passes the
// goal checklist, the pull requests and `now`.
//
// Why it exists: on 2026-10-10..11 the AMUX v22 activation stalled while
// found bugs were fixed one after another, and Chat-01 ran to 62 pull
// requests, 40 of which named no step, so the operator kept re-checking
// where each stood. A session that has lost its way does not notice, so the
// position is counted from outside the session, from records it cannot
// reinterpret: the declarations it made and the merges that happened.
//
// It reports; it decides nothing. A declaration is the session's own claim
// and is not checked for truth. What is checked is the shape around it: side
// work piling up after the last finished step, a step that keeps absorbing
// pull requests without finishing, and time passing with work but no step.

/** Goal ids follow the workboard's ids, e.g. CHAT-01. */
export const GOAL_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;
export const GOAL_ID_MAX = 40;
/** `-` and `op` are the two reserved step words, never step ids. */
export const STEP_ID = /^[A-Za-z0-9._-]{1,32}$/;
const RESERVED_STEPS = new Set(["-", "op"]);

/**
 * Starting thresholds, from the supervisor draft policy. S0 had too few
 * declared pull requests to calibrate them; they are starting values.
 */
export const SIDE_WORK_CHAIN_N = 3;
export const STEP_CHURN_M = 6;
export const STEP_STALL_HOURS = 6;
export const REPOSITORY_WINDOW_DAYS = 7;

const DECLARATION_KEY = "Goal-Step:";
const DECLARATION = new RegExp(
  "^Goal-Step:\\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)/(-|op|[A-Za-z0-9._-]{1,32})(\\s+completes)?$"
);

/**
 * The one Goal-Step line in a pull request body, or why there is none.
 * Lines inside fenced code blocks are not declarations: a body that quotes
 * the grammar must not be read as using it.
 */
export function parseGoalStepDeclaration(body) {
  if (typeof body !== "string" || body.length === 0) return { kind: "missing" };
  const found = [];
  let fence = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const marker = line.match(/^(`{3,}|~{3,})/);
    if (marker) {
      if (fence === null) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      continue;
    }
    if (fence === null && line.startsWith(DECLARATION_KEY)) found.push(line);
  }
  if (found.length === 0) return { kind: "missing" };
  if (found.length > 1) return { kind: "invalid", reason: "more than one Goal-Step line" };
  const match = found[0].match(DECLARATION);
  if (!match) return { kind: "invalid", reason: "not <goal>/<step>, <goal>/<step> completes, <goal>/- or <goal>/op" };
  const [, goal, step, completes] = match;
  if (goal.length > GOAL_ID_MAX) return { kind: "invalid", reason: "goal id longer than 40 characters" };
  if (step === "-" || step === "op") {
    if (completes) return { kind: "invalid", reason: `${step} cannot complete a step` };
    return { kind: step === "-" ? "side" : "op", goal };
  }
  return { kind: completes ? "completes" : "step", goal, step };
}

const isInstant = (value) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

const onlyKeys = (object, allowed, where, problems) => {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) problems.push(`${where}: unknown field ${key}`);
  }
};

/**
 * A goal checklist, validated strictly. Returns { goal } or { problems }.
 * Unknown fields are refused rather than ignored: a misspelt `confirmedAt`
 * that was silently dropped would report a finished step as open.
 */
export function validateGoalSpec(spec) {
  const problems = [];
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    return { problems: ["a goal is an object"] };
  }
  onlyKeys(spec, ["goal", "title", "since", "steps"], "goal", problems);
  if (typeof spec.goal !== "string" || !GOAL_ID.test(spec.goal) || spec.goal.length > GOAL_ID_MAX) {
    problems.push("goal: an id like CHAT-01 (upper-case letters, digits and hyphens, at most 40)");
  }
  if (typeof spec.title !== "string" || spec.title.trim().length === 0 || spec.title.length > 120) {
    problems.push("title: 1 to 120 characters");
  }
  if (!isInstant(spec.since)) problems.push("since: a UTC instant such as 2026-10-10T00:00:00Z");
  if (!Array.isArray(spec.steps) || spec.steps.length === 0 || spec.steps.length > 100) {
    problems.push("steps: 1 to 100 steps");
  }
  const seen = new Set();
  for (const [index, step] of (Array.isArray(spec.steps) ? spec.steps : []).entries()) {
    const where = `steps[${index}]`;
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      problems.push(`${where}: an object`);
      continue;
    }
    onlyKeys(step, ["id", "title", "evidence", "base", "confirmedAt", "rejectedPrs"], where, problems);
    if (typeof step.id !== "string" || !STEP_ID.test(step.id) || RESERVED_STEPS.has(step.id)) {
      problems.push(`${where}.id: letters, digits, '.', '_' or '-' (1 to 32), not '-' or 'op'`);
    } else if (seen.has(step.id)) {
      problems.push(`${where}.id: ${step.id} appears twice`);
    } else {
      seen.add(step.id);
    }
    if (typeof step.title !== "string" || step.title.trim().length === 0 || step.title.length > 200) {
      problems.push(`${where}.title: 1 to 200 characters`);
    }
    if (step.evidence === "completing_pr_merged") {
      if (step.base !== undefined && step.base !== "develop" && step.base !== "main") {
        problems.push(`${where}.base: develop or main`);
      }
      if (step.confirmedAt !== undefined) problems.push(`${where}.confirmedAt: only for operator_confirmed`);
      if (step.rejectedPrs !== undefined &&
          !(Array.isArray(step.rejectedPrs) && step.rejectedPrs.every((n) => Number.isInteger(n) && n > 0))) {
        problems.push(`${where}.rejectedPrs: pull request numbers`);
      }
    } else if (step.evidence === "operator_confirmed") {
      if (step.base !== undefined) problems.push(`${where}.base: only for completing_pr_merged`);
      if (step.rejectedPrs !== undefined) problems.push(`${where}.rejectedPrs: only for completing_pr_merged`);
      if (step.confirmedAt !== undefined && !isInstant(step.confirmedAt)) {
        problems.push(`${where}.confirmedAt: a UTC instant`);
      }
    } else {
      problems.push(`${where}.evidence: completing_pr_merged or operator_confirmed`);
    }
  }
  if (problems.length > 0) return { problems };
  return {
    goal: {
      goal: spec.goal,
      title: spec.title.trim(),
      since: spec.since,
      steps: spec.steps.map((step) => ({
        id: step.id,
        title: step.title.trim(),
        evidence: step.evidence,
        base: step.evidence === "completing_pr_merged" ? step.base ?? "develop" : null,
        confirmedAt: step.confirmedAt ?? null,
        rejectedPrs: step.rejectedPrs ?? [],
      })),
    },
  };
}

/**
 * Goal specs from a checklist file: a JSON object, a JSON `{ "goals": [...] }`,
 * or Markdown whose ```goal-steps fenced blocks each hold one JSON goal (so a
 * workboard detail document can carry its own checklist).
 */
export function goalSpecsFromText(text, { markdown }) {
  const raw = [];
  if (markdown) {
    const block = /^(`{3,})goal-steps[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/gm;
    for (const match of text.matchAll(block)) raw.push(match[2]);
    if (raw.length === 0) return { problems: ["no ```goal-steps block in this file"] };
  } else {
    raw.push(text);
  }
  const goals = [];
  const problems = [];
  for (const [index, source] of raw.entries()) {
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      problems.push(`block ${index + 1}: not JSON (${error.message})`);
      continue;
    }
    const list = parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.goals)
      ? parsed.goals : [parsed];
    for (const spec of list) {
      const result = validateGoalSpec(spec);
      if (result.problems) problems.push(...result.problems.map((p) => `block ${index + 1}: ${p}`));
      else goals.push(result.goal);
    }
  }
  return problems.length > 0 ? { problems } : { goals };
}

/**
 * Pull requests in the shape this module reads, from either `gh pr list
 * --json number,title,body,baseRefName,headRefName,createdAt,mergedAt` or the
 * REST pulls API. Anything without a number is dropped.
 */
export function normalisePullRequests(list) {
  if (!Array.isArray(list)) return [];
  return list.flatMap((pr) => {
    if (!pr || !Number.isInteger(pr.number)) return [];
    return [{
      number: pr.number,
      title: typeof pr.title === "string" ? pr.title.slice(0, 200) : "",
      base: pr.baseRefName ?? pr.base?.ref ?? null,
      head: pr.headRefName ?? pr.head?.ref ?? "",
      createdAt: pr.createdAt ?? pr.created_at ?? null,
      mergedAt: pr.mergedAt ?? pr.merged_at ?? null,
      declaration: parseGoalStepDeclaration(pr.body ?? ""),
    }];
  });
}

const at = (value) => (value ? Date.parse(value) : NaN);
const after = (value, baseline) => Number.isFinite(at(value)) && at(value) > baseline;

/** One goal's position. `now` is a millisecond timestamp. */
export function goalPosition(goal, pullRequests, now) {
  const declared = pullRequests.filter((pr) => pr.declaration.goal === goal.goal);
  const steps = goal.steps.map((step) => {
    if (step.evidence === "operator_confirmed") {
      return { ...step, done: step.confirmedAt !== null, doneAt: step.confirmedAt, doneBy: step.confirmedAt ? "operator" : null };
    }
    const completing = declared
      .filter((pr) => pr.declaration.kind === "completes" && pr.declaration.step === step.id &&
        pr.base === step.base && pr.mergedAt && !step.rejectedPrs.includes(pr.number))
      .sort((a, b) => at(a.mergedAt) - at(b.mergedAt))[0];
    return completing
      ? { ...step, done: true, doneAt: completing.mergedAt, doneBy: `#${completing.number}` }
      : { ...step, done: false, doneAt: null, doneBy: null };
  });
  const finished = steps.filter((step) => step.done).sort((a, b) => at(b.doneAt) - at(a.doneAt));
  const last = finished[0] ?? null;
  const baseline = last ? at(last.doneAt) : at(goal.since);
  const mergedSince = declared.filter((pr) => after(pr.mergedAt, baseline));
  const stepPrs = {};
  for (const pr of mergedSince) {
    if (pr.declaration.kind === "step" || pr.declaration.kind === "completes") {
      stepPrs[pr.declaration.step] = (stepPrs[pr.declaration.step] ?? 0) + 1;
    }
  }
  const side = mergedSince.filter((pr) => pr.declaration.kind === "side").length;
  const op = mergedSince.filter((pr) => pr.declaration.kind === "op").length;
  const active = declared.some((pr) => after(pr.createdAt, baseline) || after(pr.mergedAt, baseline));
  const hours = (now - baseline) / 3_600_000;
  const open = new Set(steps.filter((step) => !step.done).map((step) => step.id));
  const churn = Object.entries(stepPrs).filter(([id, count]) => open.has(id) && count >= STEP_CHURN_M);
  const signals = {
    sideWorkChain: { value: side, threshold: SIDE_WORK_CHAIN_N, fired: side >= SIDE_WORK_CHAIN_N },
    stepStall: { value: Math.max(0, hours), threshold: STEP_STALL_HOURS, active, fired: active && hours >= STEP_STALL_HOURS },
    stepChurn: { steps: churn.map(([id, count]) => ({ id, count })), threshold: STEP_CHURN_M, fired: churn.length > 0 },
    operatorDisplacement: { value: op },
  };
  const state = declared.length === 0
    ? "insufficient_evidence"
    : signals.sideWorkChain.fired ? "drifting"
      : signals.stepStall.fired || signals.stepChurn.fired ? "attention" : "on_track";
  const lastDeclared = [...declared].sort((a, b) =>
    Math.max(at(b.createdAt) || 0, at(b.mergedAt) || 0) - Math.max(at(a.createdAt) || 0, at(a.mergedAt) || 0))[0] ?? null;
  return {
    goal: goal.goal,
    title: goal.title,
    state,
    completed: finished.length,
    total: steps.length,
    baselineAt: new Date(baseline).toISOString(),
    baselineFrom: last ? `step ${last.id}` : "goal start",
    steps,
    sinceBaseline: { stepPrs, side, op },
    declaredEver: declared.length,
    lastDeclared: lastDeclared ? { number: lastDeclared.number, title: lastDeclared.title } : null,
    signals,
  };
}

/** Branches that carry other work and are not asked to declare a step. */
export const EXEMPT_HEAD = /^(?:release|hotfix|dependabot|autofix|feedback-autofix[^/]*|visual-baseline)\/|(?:^|\/)hotfix\/|back-?merge/i;

/** How much of the recent merged work declares a step at all. */
export function repositoryDeclarationStats(pullRequests, now) {
  const since = now - REPOSITORY_WINDOW_DAYS * 86_400_000;
  const counted = pullRequests.filter((pr) => Number.isFinite(at(pr.mergedAt)) && at(pr.mergedAt) > since &&
    !EXEMPT_HEAD.test(pr.head));
  const invalid = counted.filter((pr) => pr.declaration.kind === "invalid");
  return {
    windowDays: REPOSITORY_WINDOW_DAYS,
    merged: counted.length,
    declared: counted.filter((pr) => !["missing", "invalid"].includes(pr.declaration.kind)).length,
    missing: counted.filter((pr) => pr.declaration.kind === "missing").length,
    invalid: invalid.map((pr) => ({ number: pr.number, reason: pr.declaration.reason })),
  };
}
