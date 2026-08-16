import assert from "node:assert/strict";
import test from "node:test";

import {
  auditIssueBacklog,
  classifyIssue,
  isMergeSubject,
  ISSUE_PROBES,
  issueReferencesInCommit,
  modelIdsInIssueTitle,
  parseModelPricingSource,
  VERDICTS,
} from "../scripts/report-issue-backlog-core.mjs";

const branch = (overrides = {}) => ({
  readFile: () => null,
  pricedModelIds: new Set(),
  pendingPriceModelIds: new Set(),
  ...overrides,
});

/** Facts for a repository whose release branches all hold the same content. */
const facts = (state = {}, commitsByIssue = new Map()) => ({
  refs: ["develop", "main"],
  stateAt: () => branch(state),
  commitsByIssue,
});

/** Facts where each branch holds different content. */
const dividedFacts = (byBranch, commitsByIssue = new Map()) => ({
  refs: Object.keys(byBranch),
  stateAt: (ref) => branch(byBranch[ref]),
  commitsByIssue,
});

test("an issue number is read from a subject and a body", () => {
  assert.deepEqual(
    [
      ...issueReferencesInCommit({
        subject: "Record the published price (#246)",
        body: "Also closes #247.\nRefs #248.",
      }),
    ],
    [246, 247, 248]
  );
});

test("a colour literal is not an issue reference", () => {
  assert.equal(
    issueReferencesInCommit({ subject: "Use #ff0000 for the error state", body: "" })
      .size,
    0
  );
});

test("GitHub's merge wording is recognised", () => {
  assert.equal(isMergeSubject("Merge pull request #437 from mposition/x"), true);
  assert.equal(isMergeSubject("Merge branch 'develop' into main"), true);
  assert.equal(isMergeSubject("Reconcile the export fixture (#432)"), false);
});

test("model identifiers are read from both pricing issue titles", () => {
  assert.deepEqual(
    [...modelIdsInIssueTitle("Verify production pricing: claude-fable-5")],
    ["claude-fable-5"]
  );
  assert.deepEqual(
    [
      ...modelIdsInIssueTitle(
        "Move GLM-5.2 pricing from environment variables into MODEL_PRICING"
      ),
    ],
    ["glm-5.2"]
  );
  assert.equal(modelIdsInIssueTitle("Rewrite the drawer").size, 0);
});

test("the pricing source splits profiles from the pending register", () => {
  const parsed = parseModelPricingSource(
    [
      "export const MODEL_PRICING: readonly ModelPricingProfile[] = [",
      '    { modelId: "glm-5.2", provider: "zhipu" },',
      '    { modelId: "claude-fable-5", provider: "anthropic" },',
      "];",
      "",
      "export const PENDING_VERIFIED_PRICE_REGISTER: readonly PendingVerifiedPriceEntry[] =",
      "    [",
      '        { modelId: "kimi-k2.7-code", owner: "someone" },',
      "    ];",
    ].join("\n")
  );
  assert.deepEqual([...parsed.pricedModelIds].sort(), [
    "claude-fable-5",
    "glm-5.2",
  ]);
  assert.deepEqual([...parsed.pendingPriceModelIds], ["kimi-k2.7-code"]);
});

test("a comment naming the register does not move the split", () => {
  const parsed = parseModelPricingSource(
    [
      "export const MODEL_PRICING: readonly ModelPricingProfile[] = [",
      "    // Leaves PENDING_VERIFIED_PRICE_REGISTER with this.",
      '    { modelId: "mistral-large-3" },',
      "];",
      "export const PENDING_VERIFIED_PRICE_REGISTER = [",
      "];",
    ].join("\n")
  );
  assert.deepEqual([...parsed.pricedModelIds], ["mistral-large-3"]);
  assert.equal(parsed.pendingPriceModelIds.size, 0);
});

test("a priced model that has left the pending register is resolved", () => {
  const result = classifyIssue(
    { number: 244, title: "Verify production pricing: claude-fable-5" },
    facts({ pricedModelIds: new Set(["claude-fable-5"]) })
  );
  assert.equal(result.verdict, VERDICTS.RESOLVED_IN_CODE);
  assert.deepEqual(result.resolvedOn, ["develop", "main"]);
});

test("a priced model still in the pending register is not resolved", () => {
  const result = classifyIssue(
    { number: 244, title: "Verify production pricing: claude-fable-5" },
    facts({
      pricedModelIds: new Set(["claude-fable-5"]),
      pendingPriceModelIds: new Set(["claude-fable-5"]),
    })
  );
  assert.equal(result.verdict, VERDICTS.OPEN_WORK);
});

test("the provider prefix is optional on either side", () => {
  const result = classifyIssue(
    {
      number: 248,
      title: "Verify production pricing: perplexity/sonar-deep-research",
    },
    facts({ pricedModelIds: new Set(["sonar-deep-research"]) })
  );
  assert.equal(result.verdict, VERDICTS.RESOLVED_IN_CODE);
});

test("a differently numbered model is not mistaken for the one named", () => {
  const result = classifyIssue(
    { number: 247, title: "Verify production pricing: qwen3.7-max" },
    facts({ pricedModelIds: new Set(["qwen3.7-plus"]) })
  );
  assert.equal(result.verdict, VERDICTS.OPEN_WORK);
});

test("two prefixed models do not match on a shared tail", () => {
  const result = classifyIssue
    (
      { number: 900, title: "Verify production pricing: openai/sonar-deep-research" },
      facts({ pricedModelIds: new Set(["perplexity/sonar-deep-research"]) })
    );
  assert.equal(result.verdict, VERDICTS.OPEN_WORK);
});

test("#278 leaves the candidate list once the checker stops importing typescript", () => {
  const resolved = classifyIssue(
    { number: 278, title: "Free the encoding checker" },
    facts({ readFile: () => 'import path from "node:path";\nconst IDENT = /x/;\n' })
  );
  // Not `resolved_in_code`: the dependabot hold the issue also names waits on
  // Next.js, and the probe says so rather than claiming the issue is finished.
  assert.equal(resolved.verdict, VERDICTS.CODE_COMPLETE_REMAINDER);
  assert.match(resolved.remainder, /dependabot/i);

  const notYet = classifyIssue(
    { number: 278, title: "Free the encoding checker" },
    facts({ readFile: () => 'import ts from "typescript";\n' })
  );
  assert.equal(notYet.verdict, VERDICTS.OPEN_WORK);
});

test("a fix on develop but not main is reported as awaiting promotion", () => {
  const result = classifyIssue(
    { number: 278, title: "Free the encoding checker" },
    dividedFacts({
      develop: { readFile: () => 'import path from "node:path";\n' },
      main: { readFile: () => 'import ts from "typescript";\n' },
    })
  );
  assert.equal(result.verdict, VERDICTS.RESOLVED_NOT_ON_ALL_BRANCHES);
  assert.deepEqual(result.resolvedOn, ["develop"]);
  assert.deepEqual(result.missingFrom, ["main"]);
});

test("a probe that cannot read its evidence never reports resolved", () => {
  const result = classifyIssue(
    { number: 278, title: "Free the encoding checker" },
    facts({ readFile: () => null })
  );
  assert.equal(result.verdict, VERDICTS.OPEN_WORK);
  assert.equal(
    result.signals.some((signal) => signal.kind === "probe" && signal.unavailable),
    true
  );
});

test("a stated remainder keeps an issue out of the resolved list", () => {
  const result = classifyIssue(
    {
      number: 256,
      title: "Move GLM-5.2 pricing from environment variables into MODEL_PRICING",
    },
    facts({ pricedModelIds: new Set(["glm-5.2"]) })
  );
  assert.equal(result.verdict, VERDICTS.CODE_COMPLETE_REMAINDER);
  assert.match(result.remainder, /production/i);
});

test("every probe says what it looked at and carries a usable remainder", () => {
  for (const probe of ISSUE_PROBES) {
    assert.equal(
      typeof probe.looksAt,
      "string",
      `#${probe.issue} does not say what it looked at`
    );
    assert.equal(
      typeof probe.remainder === "string" || probe.remainder === undefined,
      true,
      `#${probe.issue} has a malformed remainder`
    );
  }
});

test("commits alone leave the issue for a person rather than resolving it", () => {
  const result = classifyIssue(
    { number: 300, title: "Something nothing probes" },
    facts(
      {},
      new Map([
        [
          300,
          [{ sha: "abc12345", subject: "Do the thing (#300)", branches: ["develop"] }],
        ],
      ])
    )
  );
  assert.equal(result.verdict, VERDICTS.LANDED_BUT_UNVERIFIED);
  assert.deepEqual(result.commitBranches, ["develop"]);
});

test("merge subjects alone are not treated as the work landing", () => {
  const result = classifyIssue(
    { number: 437, title: "A number that collides with a pull request" },
    facts(
      {},
      new Map([
        [
          437,
          [
            {
              sha: "9d9052c0",
              subject: "Merge pull request #437 from mposition/x",
              branches: ["develop", "main"],
            },
          ],
        ],
      ])
    )
  );
  assert.equal(result.verdict, VERDICTS.OPEN_WORK);
  assert.match(
    result.signals.find((signal) => signal.kind === "commits").detail,
    /pull request rather than this issue/
  );
});

test("only genuinely open work is offered as a candidate", () => {
  const report = auditIssueBacklog({
    issues: [
      { number: 244, title: "Verify production pricing: claude-fable-5" },
      {
        number: 256,
        title: "Move GLM-5.2 pricing from environment variables into MODEL_PRICING",
      },
      { number: 278, title: "Free the encoding checker" },
      { number: 300, title: "Something nothing probes" },
      { number: 301, title: "Genuinely untouched" },
    ],
    facts: dividedFacts(
      {
        develop: {
          readFile: () => 'import path from "node:path";\n',
          pricedModelIds: new Set(["claude-fable-5", "glm-5.2"]),
          pendingPriceModelIds: new Set(),
        },
        main: {
          readFile: () => 'import ts from "typescript";\n',
          pricedModelIds: new Set(["claude-fable-5", "glm-5.2"]),
          pendingPriceModelIds: new Set(),
        },
      },
      new Map([
        [300, [{ sha: "abc12345", subject: "Do it (#300)", branches: ["develop"] }]],
      ])
    ),
  });

  assert.deepEqual(
    report.candidates.map((issue) => issue.number),
    [301]
  );
  assert.deepEqual(
    report.staleOpen.map((issue) => issue.number),
    [244, 256]
  );
  assert.deepEqual(
    report.awaitingPromotion.map((issue) => issue.number),
    [278]
  );
  assert.deepEqual(
    report.needsReview.map((issue) => issue.number),
    [300]
  );
});

/* -------------------------------------------------------------------------- */
/* Blocked                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `candidates` answers "what may I pick up next", so an issue whose first step
 * is reading production must not appear in it.
 *
 * #636 is the case this was added for: the decision is approved and the code
 * site is known, but blocking fixed-amount promotion creation before knowing
 * which codes are live could interrupt a running campaign. Offered as
 * `open_work`, a session would start it and then either stall or guess.
 */

test("an unresolved probe that names a blocker is not open work", () => {
  const result = classifyIssue(
    {
      number: 636,
      title: "Deprecate creation of fixed-amount billing promotions",
    },
    facts({ readFile: () => "export const promotionSchema = {};" })
  );
  assert.equal(result.verdict, VERDICTS.BLOCKED);
  assert.match(result.blockedOn, /production inventory/i);
});

test("a blocked issue is kept out of the candidate list", () => {
  const audit = auditIssueBacklog({
    issues: [
      {
        number: 636,
        title: "Deprecate creation of fixed-amount billing promotions",
      },
      { number: 999, title: "Something with no probe at all" },
    ],
    facts: facts({ readFile: () => "export const promotionSchema = {};" }),
  });
  assert.deepEqual(
    audit.candidates.map((item) => item.number),
    [999]
  );
  assert.deepEqual(
    audit.blocked.map((item) => item.number),
    [636]
  );
});

test("resolving the work clears the blocker rather than reporting both", () => {
  // What an issue was once waiting for is history once it is done. Carrying
  // `blockedOn` into a resolved verdict would read as "done, but still stuck".
  const result = classifyIssue(
    {
      number: 636,
      title: "Deprecate creation of fixed-amount billing promotions",
    },
    facts({
      readFile: () =>
        "// percentage-only: refuse discountAmountCents on create\n",
    })
  );
  assert.notEqual(result.verdict, VERDICTS.BLOCKED);
  assert.equal(result.blockedOn, undefined);
});

test("every probe that declares a blocker explains what it is waiting for", () => {
  for (const probe of ISSUE_PROBES) {
    if (!probe.blockedOn) continue;
    assert.ok(
      probe.blockedOn.length > 40,
      `#${probe.issue} must say what the blocker is, not just that there is one`
    );
  }
});
