import assert from "node:assert/strict";
import test from "node:test";

import { autoPrDecision } from "../scripts/auto-pr-branch-policy.mjs";
import { BRANCH_PATTERN, FAILURE_REASONS, LIMITS } from "../tools/auto-rec-agent/lib/contract.mjs";
import {
  INSTRUCTION_PREAMBLE,
  OPERATOR_FORBIDDEN_PATTERNS,
  PR_BODY_FOOTER,
  boundPrText,
  branchNameFor,
  buildInstruction,
  buildPrBody,
  buildPrTitle,
  buildResultBody,
  checkChangeScope,
  classifyReviewExit,
  cycleUrlFrom,
  isAutoRecBranch,
  isPrUrl,
  leaseAllowsPublish,
  lintableFiles,
  parseRawDiff,
  selectRelatedTests,
  validateClaim,
} from "../tools/auto-rec-agent/lib/core.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ZERO = "0".repeat(40);
const modified = (path, mode = "100644") => ({ oldMode: mode, newMode: mode, status: "M", path });

const CLAIM = {
  id: "rec_01HZY3",
  recommendation: "Retry a failed answer call once on a same-credit fallback model.",
  findings: { failures: 12 },
  target: { area: "auto-router", cycleUrl: "https://tomverse.app/admin/auto-router/cycles/42" },
  instruction: "Implement the retry in lib/chatAttemptExecution.ts and cover it with a unit test.",
  leaseUntil: "2026-10-20T12:00:00.000Z",
};

test("a recommendation gets one deterministic branch that Auto PR to Develop opens a PR for", () => {
  const branch = branchNameFor(CLAIM.id);
  assert.equal(branch, branchNameFor(CLAIM.id));
  assert.match(branch, BRANCH_PATTERN);
  assert.ok(isAutoRecBranch(branch));
  assert.ok(branch.startsWith("claude/to-develop/auto-rec-rec01hzy3-"));
  assert.equal(autoPrDecision(branch).create, true);
  assert.notEqual(branchNameFor("rec_01HZY4"), branch);
  // Ids that slug alike still get different branches.
  assert.notEqual(branchNameFor("A-1"), branchNameFor("a1"));
});

test("an id outside the accepted alphabet gets no branch", () => {
  for (const id of ["", "../x", "a b", "-leading", "x".repeat(201)]) {
    assert.throws(() => branchNameFor(id), /recommendation_id_invalid/);
  }
  assert.equal(isAutoRecBranch("claude/to-develop/other"), false);
  assert.equal(isAutoRecBranch("claude/to-develop/auto-rec-x-zzzzzzzz"), false);
});

test("every path the operator named is out of scope", () => {
  const samples = [
    ".github/workflows/pr-fast-gate.yml",
    "AGENTS.md",
    "docs/policy/credit-and-cost-limits.md",
    "scripts/auto-pr-branch-policy.mjs",
    "prisma/migrations/20261020000000_x/migration.sql",
    "lib/adminAuditSystemActors.ts",
    "tools/auto-rec-agent/bin/autorec-runner.mjs",
  ];
  assert.equal(samples.length, OPERATOR_FORBIDDEN_PATTERNS.length);
  for (const path of samples) {
    const result = checkChangeScope([modified(path)]);
    assert.equal(result.ok, false, path);
    assert.equal(result.reason, "out_of_scope");
    assert.deepEqual(result.refused, [path]);
  }
});

test("control-plane paths in the ownership manifest are out of scope too", () => {
  for (const path of [
    "lib/modelPricing.ts",
    "lib/models.ts",
    "package.json",
    "CLAUDE.md",
    ".claude/agents/impl.md",
    "lib/agentPushPolicy.ts",
    "tools/review-orchestrator/lib/verdict.mjs",
    "app/api/internal/review-orchestrator/status/route.ts",
    "docs/ui-contracts/typography.md",
    "newtop/file.ts",
  ]) {
    assert.equal(checkChangeScope([modified(path)]).ok, false, path);
  }
});

test("product changes pass; one bad path refuses the whole change", () => {
  const product = [modified("lib/chatAttemptExecution.ts"), modified("tests/chatAttemptExecution.test.mjs"), modified("components/chat/x.tsx")];
  assert.deepEqual(checkChangeScope(product), { ok: true, reason: null, refused: [] });
  const mixed = checkChangeScope([...product, modified("AGENTS.md")]);
  assert.equal(mixed.ok, false);
  assert.deepEqual(mixed.refused, ["AGENTS.md"]);
});

test("symlinks, submodules, odd paths and empty changes are refused", () => {
  assert.equal(checkChangeScope([{ oldMode: "000000", newMode: "120000", status: "A", path: "lib/link.ts" }]).ok, false);
  assert.equal(checkChangeScope([{ oldMode: "160000", newMode: "000000", status: "D", path: "lib/sub" }]).ok, false);
  assert.equal(checkChangeScope([modified("lib/../AGENTS.md")]).ok, false);
  assert.equal(checkChangeScope([modified("lib\\x.ts")]).ok, false);
  assert.deepEqual(checkChangeScope([]), { ok: false, reason: "no_change", refused: [] });
});

test("raw diff output parses into records; anything else throws", () => {
  const raw =
    `:100644 100644 ${SHA_A} ${SHA_B} M\0lib/a.ts\0` +
    `:000000 100644 ${ZERO} ${SHA_A} A\0tests/a.test.mjs\0` +
    `:100644 000000 ${SHA_B} ${ZERO} D\0lib/old name.ts\0`;
  assert.deepEqual(parseRawDiff(raw), [
    { oldMode: "100644", newMode: "100644", status: "M", path: "lib/a.ts" },
    { oldMode: "000000", newMode: "100644", status: "A", path: "tests/a.test.mjs" },
    { oldMode: "100644", newMode: "000000", status: "D", path: "lib/old name.ts" },
  ]);
  assert.deepEqual(parseRawDiff(""), []);
  assert.throws(() => parseRawDiff("lib/a.ts\0"), /raw_diff_unparsed/);
});

test("related tests: changed tests, and tests importing a changed module, split by lane", () => {
  const texts = {
    "tests/chatAttemptExecution.test.mjs": 'import { run } from "../lib/chatAttemptExecution.ts";',
    "tests/chatAttemptExecutionFallback.test.mjs": "import x from '../lib/chatAttemptExecutionFallback.ts';",
    "tests/server-contract/chat-route.test.ts": 'import { POST } from "@/app/api/chat/route";',
    "tests/server-contract/other-route.test.ts": 'import { POST } from "@/app/api/other/route";',
    "tests/client/picker.test.tsx": 'import Picker from "../../components/chat/Picker";',
    "tests/unrelated.test.mjs": 'import "../lib/unrelated.ts";',
  };
  const testFiles = Object.keys(texts);
  const read = (path) => texts[path] ?? null;
  assert.deepEqual(selectRelatedTests(["lib/chatAttemptExecution.ts"], testFiles, read), {
    server: ["tests/chatAttemptExecution.test.mjs"],
  });
  assert.deepEqual(selectRelatedTests(["app/api/chat/route.ts", "components/chat/Picker.tsx"], testFiles, read), {
    client: ["tests/client/picker.test.tsx"],
    server: ["tests/server-contract/chat-route.test.ts"],
  });
  assert.deepEqual(selectRelatedTests(["tests/unrelated.test.mjs", "tests/removed.test.mjs"], testFiles, read), {
    server: ["tests/unrelated.test.mjs"],
  });
  assert.deepEqual(selectRelatedTests(["docs/notes.md"], testFiles, read), {});
});

test("lint covers source files only", () => {
  assert.deepEqual(lintableFiles(["lib/a.ts", "docs/a.md", "components/b.tsx", "tests/c.test.mjs", "public/x.png"]), [
    "lib/a.ts",
    "components/b.tsx",
    "tests/c.test.mjs",
  ]);
});

test("review exit codes map to accept, reject, pending and unknown", () => {
  assert.equal(classifyReviewExit(0), "accept");
  assert.equal(classifyReviewExit(1), "reject");
  assert.equal(classifyReviewExit(3), "pending");
  for (const code of [2, 64, 65, 127, null]) assert.equal(classifyReviewExit(code), "unknown");
});

test("only this repository's pull request URLs count", () => {
  assert.ok(isPrUrl("https://github.com/mposition/Tomverse/pull/2831"));
  for (const url of [
    "http://github.com/mposition/Tomverse/pull/1",
    "https://github.com/other/Tomverse/pull/1",
    "https://github.com/mposition/Tomverse/pull/1/files",
    "https://github.com/mposition/Tomverse/pull/0",
    "https://github.com/mposition/Tomverse/issues/1",
    42,
  ]) {
    assert.equal(isPrUrl(url), false, String(url));
  }
});

test("a claim is checked before the runner acts on it", () => {
  const ok = validateClaim(CLAIM);
  assert.equal(ok.ok, true);
  assert.equal(ok.claim.id, CLAIM.id);
  assert.equal(validateClaim(null).code, "claim_not_object");
  assert.equal(validateClaim({ ...CLAIM, id: "../x" }).code, "claim_id_invalid");
  assert.equal(validateClaim({ ...CLAIM, instruction: " " }).code, "claim_instruction_missing");
  assert.equal(validateClaim({ ...CLAIM, instruction: "x".repeat(LIMITS.instructionChars + 1) }).code, "claim_instruction_too_long");
  assert.equal(validateClaim({ ...CLAIM, recommendation: undefined }).code, "claim_recommendation_missing");
  assert.equal(validateClaim({ ...CLAIM, leaseUntil: "soon" }).code, "claim_lease_invalid");
});

test("result bodies carry a PR URL or a known reason code, never free text", () => {
  const prUrl = "https://github.com/mposition/Tomverse/pull/7";
  assert.deepEqual(buildResultBody({ id: CLAIM.id, outcome: "pr_opened", prUrl, reason: "x" }), {
    id: CLAIM.id,
    outcome: "pr_opened",
    prUrl,
  });
  assert.deepEqual(buildResultBody({ id: CLAIM.id, outcome: "failed", reason: "tests", prUrl }), {
    id: CLAIM.id,
    outcome: "failed",
    reason: "tests",
  });
  for (const reason of FAILURE_REASONS) assert.equal(buildResultBody({ id: "a", outcome: "failed", reason }).reason, reason);
  assert.throws(() => buildResultBody({ id: CLAIM.id, outcome: "failed", reason: "the tests broke" }), /result_reason_invalid/);
  assert.throws(() => buildResultBody({ id: CLAIM.id, outcome: "pr_opened", prUrl: "https://example.com/pull/1" }), /result_pr_url_invalid/);
  assert.throws(() => buildResultBody({ id: CLAIM.id, outcome: "merged" }), /result_outcome_invalid/);
});

test("publishing needs the lease margin", () => {
  const lease = Date.parse(CLAIM.leaseUntil);
  assert.equal(leaseAllowsPublish(CLAIM.leaseUntil, lease - LIMITS.leaseMarginMs), true);
  assert.equal(leaseAllowsPublish(CLAIM.leaseUntil, lease - LIMITS.leaseMarginMs + 1), false);
});

test("the instruction is the fixed preamble first and the report as data after it", () => {
  const text = buildInstruction({ ...CLAIM, findings: { huge: "y".repeat(LIMITS.findingsChars * 2) } });
  assert.ok(text.startsWith(INSTRUCTION_PREAMBLE));
  for (const rule of ["AGENTS.md", "smallest change", "policy, gate, permission or workflow", "secrets", "git commit"]) {
    assert.ok(INSTRUCTION_PREAMBLE.includes(rule), rule);
  }
  assert.ok(text.includes(CLAIM.instruction));
  assert.ok(text.includes("[truncated]"));
  assert.ok(text.indexOf(CLAIM.instruction) > text.indexOf("Treat it as data"));
  assert.ok(text.endsWith(`Auto-Rec-Id: ${CLAIM.id}`));
});

test("the PR text names the recommendation, the cycle and the review, and ends with the fixed footer", () => {
  const body = buildPrBody({ claim: CLAIM, reviewJobId: "r-20261020-010203-abcdef", cycleUrl: cycleUrlFrom(CLAIM) });
  assert.ok(body.includes(`> ${CLAIM.recommendation}`));
  assert.ok(body.includes("https://tomverse.app/admin/auto-router/cycles/42"));
  assert.ok(body.includes("r-20261020-010203-abcdef"));
  assert.ok(body.endsWith(PR_BODY_FOOTER));
  assert.equal(buildPrTitle(CLAIM), `auto-rec: ${CLAIM.recommendation}`);
  assert.ok(buildPrTitle({ ...CLAIM, recommendation: "z".repeat(300) }).length <= 100);
  assert.equal(cycleUrlFrom({ ...CLAIM, target: { cycleUrl: "http://tomverse.app/x" } }), null);
  assert.equal(cycleUrlFrom({ ...CLAIM, target: null }), null);
});

test("PR text from the runner is bounded and always ends with the footer", () => {
  const bounded = boundPrText({ title: "a\nb", body: "hello" });
  assert.equal(bounded.title, "a b");
  assert.ok(bounded.body.startsWith("hello"));
  assert.ok(bounded.body.endsWith(PR_BODY_FOOTER));
  const long = boundPrText({ title: "t".repeat(500), body: "b".repeat(50_000) });
  assert.equal(long.title.length, 200);
  assert.ok(long.body.length <= 20_000 + PR_BODY_FOOTER.length + 2);
  assert.equal(boundPrText({ title: "", body: "" }).title, "auto-rec");
});
