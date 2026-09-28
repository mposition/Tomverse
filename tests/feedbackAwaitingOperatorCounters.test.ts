import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  EMPTY_ADMIN_NAVIGATION_COUNTS,
  adminNavigationBadge,
} from "../lib/adminNavigationBadges";
import { TOKEN_VERIFICATION_STATUS } from "../lib/errorReportContract";
import {
  FEEDBACK_AWAITING_OPERATOR_STATUSES,
  FEEDBACK_STATUSES,
  isFeedbackAwaitingOperator,
  isTerminalFeedbackStatus,
} from "../lib/feedbackLifecycleCore";
import { initialFeedbackStatus } from "../lib/feedbackTraceAutoReview";

/**
 * Every "is there support work?" surface counts the same thing.
 *
 * On 2026-09-28 a customer's report was stored, emailed to the operator and
 * listed in the inbox, while the sidebar badge, the overview, the work queue,
 * the SLA panel and the inbox header all read zero. Each of them counted
 * `status: "open"`, and a report whose trace the server had verified arrives
 * as `reviewing` (lib/feedbackTraceAutoReview.ts). The reports the server had
 * confirmed were exactly the ones nothing announced.
 *
 * These tests pin the coupling that broke: whatever status a report arrives
 * in, the counters see it -- and no surface goes back to naming `open`.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

test("a report awaits an operator until it is closed", () => {
  assert.deepEqual([...FEEDBACK_AWAITING_OPERATOR_STATUSES], ["open", "reviewing"]);
  assert.equal(isFeedbackAwaitingOperator("open"), true);
  assert.equal(isFeedbackAwaitingOperator("reviewing"), true);
  assert.equal(isFeedbackAwaitingOperator("resolved"), false);
  assert.equal(isFeedbackAwaitingOperator("closed"), false);
  // A value that is not a status at all is not work anyone can act on.
  assert.equal(isFeedbackAwaitingOperator("archived"), false);
});

test("every status is either awaiting or closed, with nothing in between", () => {
  // Derived, not listed: a status added to FEEDBACK_STATUSES later is counted
  // unless it is made terminal on purpose.
  for (const status of FEEDBACK_STATUSES) {
    assert.notEqual(
      isFeedbackAwaitingOperator(status),
      isTerminalFeedbackStatus(status),
      `${status} must be exactly one of awaiting or closed`
    );
  }
});

test("both statuses a new report can arrive in are counted", () => {
  // A verified trace starts the report in review...
  const verified = initialFeedbackStatus({
    verification: TOKEN_VERIFICATION_STATUS.verified,
    traceId: "0f3b722e-fdca-459d-8a33-5cc9e541a38f",
  });
  assert.equal(verified, "reviewing");
  assert.equal(
    isFeedbackAwaitingOperator(verified),
    true,
    "the reports the server confirmed are the ones that must be counted"
  );

  // ...and everything else starts open.
  for (const verification of [null, TOKEN_VERIFICATION_STATUS.missingToken]) {
    const status = initialFeedbackStatus({ verification, traceId: "trace-1" });
    assert.equal(isFeedbackAwaitingOperator(status), true, `${verification}`);
  }
  assert.equal(
    isFeedbackAwaitingOperator(initialFeedbackStatus({ verification: null, traceId: null })),
    true
  );
});

test("Support counts a report and its waiting auto-fix case once, the work queue counts every report", () => {
  // Three unclosed reports; one of them has a case waiting on an operator, so
  // Support counts the case in its place. The work queue lists reports only.
  const counts = {
    ...EMPTY_ADMIN_NAVIGATION_COUNTS,
    openFeedback: 3,
    supportFeedback: 2,
    autoFixActionCases: 1,
    openPrivacyRequests: 1,
  };
  assert.equal(adminNavigationBadge("support", counts), 4);
  assert.equal(adminNavigationBadge("workQueue", counts), 4);

  // A reviewing report with no case -- the 2026-09-28 report -- lights Support.
  assert.equal(
    adminNavigationBadge("support", {
      ...EMPTY_ADMIN_NAVIGATION_COUNTS,
      openFeedback: 1,
      supportFeedback: 1,
      autoFixActionCases: 0,
      openPrivacyRequests: 0,
    }),
    1
  );
});

test("the Support count leaves out exactly the reports whose case is counted beside it", () => {
  const source = read("lib/adminNavigationCounts.ts");
  assert.match(
    source,
    /NOT:\s*\{\s*autoFixCase:\s*\{\s*is:\s*\{\s*state:\s*\{\s*in:\s*\[\.\.\.AUTOFIX_OPERATOR_ACTION_STATES\]/,
    "supportFeedback must exclude the same states autoFixActionCases counts"
  );
});

const sourceFiles = (directory: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
};

/** The argument text of every call `prisma.feedback.<method>(...)`, found by
 * balancing parentheses rather than by a pattern, so `select` before `where`,
 * multi-line objects and nested calls all come out whole. */
const feedbackCallArguments = (source: string, methods: readonly string[]) => {
  const out: Array<{ method: string; argument: string }> = [];
  const opener = new RegExp(`prisma\\.feedback\\.(${methods.join("|")})\\(`, "g");
  for (const match of source.matchAll(opener)) {
    let depth = 1;
    let index = (match.index ?? 0) + match[0].length;
    const start = index;
    while (index < source.length && depth > 0) {
      if (source[index] === "(") depth += 1;
      else if (source[index] === ")") depth -= 1;
      index += 1;
    }
    out.push({ method: match[1], argument: source.slice(start, index - 1) });
  }
  return out;
};

test("no feedback count or list is scoped to the open status alone", () => {
  // Counting and listing reads only: findFirst/findUnique fetch one known
  // report, where naming a single status can be exactly right.
  const methods = ["count", "findMany", "aggregate", "groupBy"] as const;
  const offenders: string[] = [];
  for (const path of ["app", "lib", "components"].flatMap((d) => sourceFiles(join(ROOT, d)))) {
    for (const { method, argument } of feedbackCallArguments(readFileSync(path, "utf8"), methods)) {
      // "open" named anywhere in the call -- `status: "open"` or
      // `status: { in: ["open"] }` alike -- without the shared definition.
      if (/"open"/.test(argument) && !/FEEDBACK_AWAITING_OPERATOR_STATUSES/.test(argument)) {
        offenders.push(`${relative(ROOT, path)}: prisma.feedback.${method}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "count or list unclosed feedback with FEEDBACK_AWAITING_OPERATOR_STATUSES"
  );
});

test("the extractor finds the shapes the old counters had", () => {
  // Guards the guard: if the extractor stopped seeing these, the rule above
  // would pass on anything.
  const shapes = [
    `prisma.feedback.count({ where: { status: "open" } })`,
    `prisma.feedback.count({\n  select: { _all: true },\n  where: { status: "open" },\n})`,
    `prisma.feedback.findMany({ where: { status: { in: ["open"] } }, take: 5 })`,
  ];
  for (const shape of shapes) {
    const [call] = feedbackCallArguments(shape, ["count", "findMany"]);
    assert.ok(call, shape);
    assert.match(call.argument, /"open"/, shape);
  }
});

/** The body of a named top-level arrow or function, from its name to the next
 * top-level declaration. */
const declaration = (source: string, name: string) => {
  const start = source.search(new RegExp(`(const|function)\\s+${name}\\b`));
  assert.ok(start >= 0, `${name} is gone; this test cannot see it`);
  const next = source.slice(start + name.length).search(/\n(export\s+)?(const|function|async function)\s/);
  return next < 0 ? source.slice(start) : source.slice(start, start + name.length + next);
};

test("the two in-memory counters filter by the shared definition", () => {
  const sla = declaration(read("lib/adminConsoleData.ts"), "feedbackSlaRows");
  assert.match(sla, /isFeedbackAwaitingOperator\(/);
  assert.doesNotMatch(sla, /status\s*===\s*"open"/);

  const panel = read("components/admin/FeedbackInboxPanel.tsx");
  const openCountLine = panel.split("\n").find((line) => /const openCount\s*=/.test(line));
  assert.ok(openCountLine, "the inbox header count moved; this test cannot see it");
  assert.match(openCountLine, /isFeedbackAwaitingOperator\(/);
});
