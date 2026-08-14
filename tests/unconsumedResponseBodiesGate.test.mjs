import assert from "node:assert/strict";
import test from "node:test";

import {
  BLOCKING_TARGET,
  BROWSER_CAPABLE_RUNTIMES,
  isBlockable,
  selectBlocking,
  WAIVERS,
  waiverProblems,
} from "../scripts/check-unconsumed-response-bodies-core.mjs";

/**
 * The merge gate's scope.
 *
 * Every edge of it is a decision that can be argued with, so each one is
 * pinned: what it blocks, and — just as important — what it deliberately lets
 * through. A gate that quietly widened would start failing PRs on evidence it
 * does not have; one that quietly narrowed would go green on the regression it
 * exists to catch, and nobody would notice either from the exit code.
 */

const finding = (overrides) => ({
  file: "components/Thing.tsx",
  line: 10,
  kind: "leaks",
  runtime: "browser",
  target: BLOCKING_TARGET,
  request: '"/api/user/guest-usage"',
  note: "const res = await fetch(…); a path returns or throws unread",
  ...overrides,
});

test("a browser leak on the measured target blocks", () => {
  assert.equal(isBlockable(finding()), true);
});

test("`either` is in scope, because lib/ holds browser code too", () => {
  // The gap this closes: `--runtime=browser` alone exempts lib/useBuildInfo.ts
  // and lib/feedbackClient.ts, which run in the browser.
  assert.deepEqual([...BROWSER_CAPABLE_RUNTIMES], ["browser", "either"]);
  assert.equal(isBlockable(finding({ runtime: "either", file: "lib/x.ts" })), true);
});

test("a server-side leak does not block", () => {
  // Real and separate: undici's pool, which nothing here has measured.
  assert.equal(
    isBlockable(finding({ runtime: "server", file: "lib/providerMonitoring.ts" })),
    false
  );
});

test("a route that chooses its own caching does not block", () => {
  // Measured, and it completed. Blocking it would be broader than the evidence.
  assert.equal(isBlockable(finding({ target: "api_own_caching" })), false);
});

test("a cross-origin request does not block", () => {
  assert.equal(isBlockable(finding({ target: "cross_origin" })), false);
});

test("an unresolvable request URL does not block", () => {
  // A helper or variable URL cannot be shown to be on the measured target.
  assert.equal(isBlockable(finding({ target: "unresolved" })), false);
});

test("`escapes` does not block", () => {
  // Judgement deferred, not a verdict. Blocking would turn "cannot tell" into
  // "must fix", which is not what the classification means.
  assert.equal(isBlockable(finding({ kind: "escapes" })), false);
});

test("`consumed` does not block", () => {
  assert.equal(isBlockable(finding({ kind: "consumed" })), false);
});

test("a file this cannot parse blocks, in browser-capable code", () => {
  // Otherwise a parse failure reads as a clean file and the gate is not
  // fail-closed. Target is irrelevant here: nothing was classified at all.
  assert.equal(
    isBlockable(finding({ kind: "unparsed", target: "unresolved", line: 0 })),
    true
  );
  assert.equal(
    isBlockable(
      finding({ kind: "unparsed", target: "unresolved", runtime: "server" })
    ),
    false
  );
});

test("a waiver excuses exactly its own file and request", () => {
  const findings = [
    finding({ file: "components/A.tsx", request: '"/api/a"' }),
    finding({ file: "components/A.tsx", request: '"/api/b"' }),
    finding({ file: "components/B.tsx", request: '"/api/a"' }),
  ];
  const waivers = [
    {
      file: "components/A.tsx",
      request: '"/api/a"',
      reason: "documented",
      approvedBy: "@someone",
      approvedAt: "2026-08-14",
    },
  ];
  const { blocking, waived, staleWaivers } = selectBlocking(findings, waivers);
  assert.equal(waived.length, 1);
  assert.equal(waived[0].finding.file, "components/A.tsx");
  assert.equal(waived[0].finding.request, '"/api/a"');
  assert.deepEqual(
    blocking.map((item) => `${item.file} ${item.request}`),
    ['components/A.tsx "/api/b"', 'components/B.tsx "/api/a"']
  );
  assert.deepEqual(staleWaivers, []);
});

test("a waiver that matches nothing is itself a failure", () => {
  // An exception list that has drifted off its targets means the gate is
  // checking less than it claims, and nothing else would say so.
  const waivers = [
    {
      file: "components/Gone.tsx",
      request: '"/api/a"',
      reason: "documented",
      approvedBy: "@someone",
      approvedAt: "2026-08-14",
    },
  ];
  const { blocking, staleWaivers } = selectBlocking([], waivers);
  assert.deepEqual(blocking, []);
  assert.equal(staleWaivers.length, 1);
  assert.equal(staleWaivers[0].file, "components/Gone.tsx");
});

test("a waiver without a reason or an approver is refused", () => {
  assert.deepEqual(waiverProblems([]), []);
  const problems = waiverProblems([
    { file: "components/A.tsx", request: '"/api/a"', reason: "  " },
  ]);
  assert.ok(problems.some((problem) => problem.includes("reason")));
  assert.ok(problems.some((problem) => problem.includes("approvedBy")));
  assert.ok(problems.some((problem) => problem.includes("approvedAt")));
});

test("the shipped waiver list is empty and well-formed", () => {
  // The browser side was swept to zero before this gate existed. An entry here
  // is a decision that some response body may go unread, so it should be rare
  // enough that its absence is worth asserting.
  assert.deepEqual([...WAIVERS], []);
  assert.deepEqual(waiverProblems(), []);
});
