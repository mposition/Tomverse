import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeLoad,
  independentVendorCount,
  pickReviewer,
  planAssignments,
  resolveAuthorVendor,
} from "../tools/review-orchestrator/lib/assign.mjs";
import { aggregate, parseReviewerOutput } from "../tools/review-orchestrator/lib/verdict.mjs";
import { globToRegExp, requiredReviewers, validateConfig } from "../tools/review-orchestrator/lib/config.mjs";
import { decodeRpc, tokenFromSshCommand } from "../tools/review-orchestrator/bin/review-orchestrator.mjs";
import { encodeRpc, repoNameFromRemote } from "../tools/review-orchestrator/client/review.mjs";
import { reviewerEnv } from "../tools/review-orchestrator/lib/service.mjs";
import { isInstructionPath } from "../tools/review-orchestrator/lib/git.mjs";
import { release, tryAcquire } from "../tools/review-orchestrator/lib/fsutil.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROVIDERS = [
  { id: "claude", vendor: "anthropic", enabled: true },
  { id: "codex", vendor: "openai", enabled: true },
  { id: "cursor", vendor: "xai", enabled: true },
  { id: "devin", vendor: "unknown", enabled: false },
];

test("author vendor: implied for claude and codex, required for cursor, never contradicted", () => {
  assert.equal(resolveAuthorVendor("claude"), "anthropic");
  assert.equal(resolveAuthorVendor("codex"), "openai");
  assert.equal(resolveAuthorVendor("cursor"), null);
  assert.equal(resolveAuthorVendor("cursor", "anthropic"), "anthropic");
  assert.equal(resolveAuthorVendor("claude", "openai"), null);
  assert.equal(resolveAuthorVendor("cursor", "unknown"), null);
  assert.equal(resolveAuthorVendor("Cursor; rm", "xai"), null);
});

test("a reviewer on the author's model vendor is never eligible, whatever its CLI", () => {
  const cursorOnClaude = [...PROVIDERS, { id: "cursor-sonnet", vendor: "anthropic", enabled: true }];
  for (let i = 0; i < 20; i += 1) {
    const pick = pickReviewer({ providers: cursorOnClaude, authorVendor: "anthropic", load: {} });
    assert.equal(pick.kind, "assign");
    assert.notEqual(pick.provider.vendor, "anthropic");
  }
  // Unknown or disabled vendors never count.
  assert.equal(independentVendorCount(PROVIDERS, "openai"), 2);
  assert.equal(independentVendorCount(PROVIDERS, "anthropic"), 2);
});

test("ordering: running first, then 24h count, then longest-idle, then id", () => {
  const authorVendor = "openai"; // claude and cursor eligible
  assert.equal(pickReviewer({ providers: PROVIDERS, authorVendor, load: {} }).provider.id, "claude");
  assert.equal(
    pickReviewer({ providers: PROVIDERS, authorVendor, load: { claude: { running: 0, recent24h: 3, lastAssignedAt: 1 } } })
      .provider.id,
    "cursor",
  );
  assert.equal(
    pickReviewer({
      providers: PROVIDERS,
      authorVendor,
      load: {
        claude: { running: 0, recent24h: 2, lastAssignedAt: 50 },
        cursor: { running: 0, recent24h: 2, lastAssignedAt: 10 },
      },
    }).provider.id,
    "cursor",
  );
  assert.equal(
    pickReviewer({
      providers: PROVIDERS,
      authorVendor,
      load: { claude: { running: 1, recent24h: 0, lastAssignedAt: 1 }, cursor: { running: 1, recent24h: 0, lastAssignedAt: 1 } },
    }).kind,
    "wait",
  );
  assert.equal(pickReviewer({ providers: PROVIDERS.slice(0, 1), authorVendor: "anthropic", load: {} }).kind, "impossible");
});

const job = (id, authorVendor, reviewers = 1) => ({
  job: { id, authorVendor },
  slots: Array.from({ length: reviewers }, (_, index) => ({ index, status: "queued" })),
});

test("a pass spreads work, caps each provider at one, and lets later jobs past a blocked one", () => {
  const decisions = planAssignments({
    jobs: [job("a", "openai"), job("b", "openai"), job("c", "openai"), job("d", "anthropic")],
    providers: PROVIDERS,
    load: {},
    now: 100,
  });
  assert.deepEqual(
    decisions.map((d) => `${d.jobId}:${d.provider}`),
    // a->claude, b->cursor, c waits (both busy), d (anthropic author) -> codex.
    ["a:claude", "b:cursor", "d:codex"],
  );
});

test("two reviewers on one job always come from two different vendors", () => {
  const decisions = planAssignments({ jobs: [job("a", "openai", 2)], providers: PROVIDERS, load: {}, now: 1 });
  assert.deepEqual(new Set(decisions.map((d) => d.vendor)), new Set(["anthropic", "xai"]));
  // With the second vendor busy, the second slot waits rather than doubling up.
  const waiting = planAssignments({
    jobs: [job("a", "openai", 2)],
    providers: PROVIDERS,
    load: { cursor: { running: 1, recent24h: 0, lastAssignedAt: 1 } },
    now: 1,
  });
  assert.deepEqual(waiting.map((d) => d.provider), ["claude"]);
});

test("load counts running slots and only the last 24 hours", () => {
  const day = 24 * 60 * 60 * 1000;
  const load = computeLoad(
    [{ slots: [
      { provider: "claude", status: "running", assignedAt: day * 2 },
      { provider: "claude", status: "done", assignedAt: day * 2 - 10 },
      { provider: "claude", status: "done", assignedAt: 1 },
    ] }],
    day * 2 + 5,
  );
  assert.deepEqual(load.claude, { running: 1, recent24h: 2, lastAssignedAt: day * 2 });
});

test("verdict parsing fails closed and blocking findings override accept", () => {
  const block = (value) => `text\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
  assert.equal(parseReviewerOutput("").verdict, "unknown");
  assert.equal(parseReviewerOutput("looks good").reason, "no_verdict_block");
  assert.equal(parseReviewerOutput("```json\n{nope\n```").reason, "verdict_not_json");
  assert.equal(parseReviewerOutput(block({ verdict: "approve", findings: [] })).reason, "verdict_value_invalid");
  assert.equal(parseReviewerOutput(block({ verdict: "accept", findings: [{ severity: "huge", summary: "x" }] })).verdict, "unknown");
  assert.deepEqual(parseReviewerOutput(block({ verdict: "accept", findings: [] })), { verdict: "accept", findings: [] });
  const overridden = parseReviewerOutput(block({ verdict: "accept", findings: [{ severity: "major", summary: "bad" }] }));
  assert.equal(overridden.verdict, "reject");
  // The last block wins: a quoted example earlier in the answer is not the verdict.
  const two = `${block({ verdict: "reject", findings: [] })}\n${block({ verdict: "accept", findings: [] })}`;
  assert.equal(parseReviewerOutput(two).verdict, "accept");
});

test("aggregate: pending, then any reject, then any unknown, then accept", () => {
  assert.equal(aggregate([{ status: "done", verdict: "accept" }, { status: "running" }]), "pending");
  assert.equal(aggregate([{ status: "done", verdict: "unknown" }, { status: "done", verdict: "reject" }]), "reject");
  assert.equal(aggregate([{ status: "done", verdict: "unknown" }, { status: "done", verdict: "accept" }]), "unknown");
  assert.equal(aggregate([{ status: "done", verdict: "accept" }]), "accept");
});

test("the shipped example config validates and names the repository the client derives", async () => {
  const { readFileSync: read } = await import("node:fs");
  const raw = JSON.parse(read("tools/review-orchestrator/config.example.json", "utf8"));
  const config = validateConfig(raw);
  assert.ok(config.repos[repoNameFromRemote(config.repos.tomverse.url)]);
  assert.equal(config.providers.find((p) => p.id === "devin").enabled, false);
});

test("config fails closed on an enabled provider without a measured vendor", () => {
  const base = { stateDir: "/x", repos: { demo: { url: "u", mirror: "m" } } };
  assert.throws(
    () => validateConfig({ ...base, providers: [{ id: "devin", vendor: "unknown", enabled: true, command: "devin", args: [] }] }),
    /measured vendor/,
  );
  const config = validateConfig({ ...base, providers: PROVIDERS.map((p) => ({ ...p, command: "x", args: [] })), contractPaths: ["prisma/migrations/**", "lib/credit*"] });
  assert.deepEqual(requiredReviewers(config, 1, ["app/page.tsx"]), { reviewers: 1, touchesContract: false });
  assert.deepEqual(requiredReviewers(config, 1, ["prisma/migrations/2026/x.sql"]), { reviewers: 2, touchesContract: true });
  assert.equal(globToRegExp("lib/credit*").test("lib/creditLots.ts"), true);
  assert.equal(globToRegExp("lib/credit*").test("lib/credit/x.ts"), false);
});

test("rpc round-trips and the SSH command yields only its token", () => {
  const request = { command: "submit", scope: "spaces; and `quotes` $(nope)" };
  const token = encodeRpc(request);
  assert.deepEqual(decodeRpc(token), request);
  assert.equal(tokenFromSshCommand(`review-orchestrator rpc ${token}`), token);
  assert.throws(() => tokenFromSshCommand("rm -rf /"), /rpc_missing/);
  assert.throws(() => decodeRpc(encodeRpc({ command: "daemon" })), /rpc_command_invalid/);
  assert.throws(() => decodeRpc("a b"), /rpc_invalid/);
});

test("reviewers get an allowlisted environment, not the daemon's", () => {
  const env = reviewerEnv({ passEnv: ["CODEX_HOME"] }, { PATH: "/bin", GITHUB_TOKEN: "x", DATABASE_URL: "y", CODEX_HOME: "/c" });
  assert.deepEqual(env, { PATH: "/bin", CODEX_HOME: "/c" });
});

test("repo name comes from the origin URL", () => {
  assert.equal(repoNameFromRemote("https://github.com/mposition/Tomverse.git"), "tomverse");
  assert.equal(repoNameFromRemote("git@github.com:mposition/ai-chat-hub.git"), "ai-chat-hub");
});

test("instruction paths cover the files reviewer CLIs load on their own", () => {
  for (const p of ["AGENTS.md", "apps/x/AGENTS.md", "CLAUDE.md", ".claude/agents/r.md", ".codex/agents/a.toml", ".cursor/rules/x.mdc", ".cursorrules", ".github/copilot-instructions.md"]) {
    assert.equal(isInstructionPath(p), true, p);
  }
  for (const p of ["lib/agentAuthorityFiles.ts", ".github/workflows/ci.yml", "docs/agents.txt"]) {
    assert.equal(isInstructionPath(p), false, p);
  }
});

test("a lock is taken over only from a dead owner, and released only by its owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-orch-lock-"));
  try {
    const path = join(dir, "x.lock");
    const token = tryAcquire(path);
    assert.ok(token);
    assert.equal(tryAcquire(path), null); // live owner: this process
    release(path, "not-mine");
    assert.equal(tryAcquire(path), null);
    release(path, token);
    writeFileSync(path, "999999999 deadbeefdeadbeef\n"); // a pid that cannot exist
    const taken = tryAcquire(path);
    assert.ok(taken);
    assert.match(readFileSync(path, "utf8"), new RegExp(taken));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
