import assert from "node:assert/strict";
import test from "node:test";
import { SUPPORTED_LANGUAGES } from "../../../lib/language";
import { desktopCodeReviewCopy } from "../../../locales/desktopCodeReview";
import { createReviewActions, findHunk, type ReviewHostDeps, type ReviewTarget, type ReviewWorkerCommand } from "../src/host/review-host";
import { diffTexts } from "../src/host/review-diff";
import {
  MAX_REVIEW_MODELS, parseReviewCommand, reviewInput, serializeFindingForFix, serializeReviewComments, type ReviewDiff, type ReviewModelResult,
} from "../src/review-contract";
import type { WorkerEvent } from "../src/host/messages";
import type { ProjectRoot } from "../src/host/project-root";

const rows = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const project: ProjectRoot = { path: "/work/project", identity: "1:2" };
const target: ReviewTarget = {
  taskId: "s-20261126-000000-abcdef",
  record: { storage: "/profile/code/x", sessionId: "s-20261126-000000-abcdef", project,
    scope: { home: "/profile/code/x", legacyHome: "/profile/code/y", root: project.path, base: "http://x/api", origin: "http://x", keyIdentity: "k", keyPrefix: "tvk_testkey00" } },
  worktreeBase: { ref: "refs/heads/main", commit: "a".repeat(40) },
};
const diff: ReviewDiff = {
  scope: "uncommitted",
  files: [diffTexts("src/a.ts", rows(20), rows(20).replace("line 5\n", "line five\n")), diffTexts("empty.txt", "", "")],
};
const hunk = diff.files[0]!.hunks[0]!;

function setup(options: { ready?: boolean[]; confirm?: boolean; event?: WorkerEvent | "unconfirmed" | "unavailable"; models?: string[] } = {}) {
  const log = { requests: [] as ReviewWorkerCommand[], dialogs: [] as Array<{ title: string; message: string; detail: string }>, reads: [] as unknown[],
    reverted: [] as string[], cancelled: [] as string[] };
  const ready = [...(options.ready ?? [])];
  const deps: ReviewHostDeps = {
    target: () => target, ready: () => ready.shift() ?? true,
    models: () => (options.models ?? ["fake-coder", "fake-small", "smart-adaptive"]).map((id) => ({ id, name: id.toUpperCase() })),
    connection: () => ({ endpoint: "http://x/api", key: "tvk_testkey000000000000" }), protectedRoot: () => "/profile", language: () => "en",
    request: async (command) => { log.requests.push(command); return options.event ?? "unavailable"; },
    confirm: async (copy) => { log.dialogs.push(copy); return options.confirm ?? true; },
    cancel: (id) => log.cancelled.push(id),
    afterRevert: (taskId) => log.reverted.push(taskId),
    readScope: async (...args) => { log.reads.push(args.slice(1)); return { status: "ok", diff }; },
    newId: (() => { let n = 0; return () => `request-${++n}`; })(),
  };
  return { review: createReviewActions(deps), log };
}

test("the bridge takes typed actions only: no path, no extra field, at most four distinct models", () => {
  const base = { action: "revert-hunk", scope: "uncommitted", hunkId: "0123456789abcdef" } as const;
  assert.ok(reviewInput.parse(base));
  for (const bad of [
    { ...base, path: "src/a.ts" }, { ...base, hunkId: "../../etc/passwd" }, { ...base, scope: "all" }, { action: "diff", scope: "branch", base: "main" },
    { action: "diff", scope: "branch", base: "refs/heads/../../x" }, { action: "run", scope: "branch", modelIds: [] },
    { action: "run", scope: "branch", modelIds: ["a", "a"] }, { action: "run", scope: "branch", modelIds: Array.from({ length: MAX_REVIEW_MODELS + 1 }, (_, i) => `m${i}`) },
    { action: "run", scope: "branch", modelIds: ["a"], diffText: "send this instead" },
  ]) assert.throws(() => reviewInput.parse(bad), JSON.stringify(bad));
  assert.ok(reviewInput.parse({ action: "diff", scope: "branch", base: "refs/heads/release/1.2" }));
});

test("the diff comes from the scope's own source, and the panel is told when there is nothing to review", async () => {
  const { review, log } = setup({ ready: [true], event: { type: "review-turn", requestId: "r", diff: { scope: "last-turn", files: [] } } });
  assert.deepEqual(await review({ action: "diff", scope: "branch", base: "refs/heads/main" }), { status: "ok", diff });
  assert.deepEqual(log.reads, [[ "branch", { base: "refs/heads/main", worktreeBase: target.worktreeBase } ]]);
  assert.deepEqual(await review({ action: "diff", scope: "last-turn" }), { status: "ok", diff: { scope: "last-turn", files: [] } });
  assert.deepEqual([log.requests[0]!.type, log.requests[0]!.requestId, (log.requests[0] as { protectedRoot: string }).protectedRoot], ["review-turn-diff", "request-1", "/profile"]);
  const busy = setup({ ready: [false] });
  assert.deepEqual(await busy.review({ action: "diff", scope: "last-turn" }), { status: "unavailable", reason: "busy" });
  assert.equal(busy.log.requests.length, 0);
  const none = createReviewActions({ ...setupDeps(), target: () => null });
  assert.deepEqual(await none({ action: "diff", scope: "uncommitted" }), { status: "unavailable", reason: "no-task" });
  assert.deepEqual(await none({ action: "run", scope: "uncommitted", modelIds: ["fake-coder"] }), { status: "unavailable" });
});

function setupDeps(): ReviewHostDeps {
  return {
    target: () => target, ready: () => true, models: () => [], connection: () => null, protectedRoot: () => "/profile", language: () => "en",
    request: async () => "unavailable", confirm: async () => false, cancel: () => undefined, afterRevert: () => undefined,
    readScope: async () => ({ status: "unavailable", reason: "not-git" }),
  };
}

test("a hunk is reverted only after the person confirms it, and the worker is given the hunk the host itself read", async () => {
  const event: WorkerEvent = { type: "review-reverted", requestId: "r", result: "reverted", changes: [{ id: "c1", path: "src/a.ts", kind: "update", current: "applied" }] };
  const { review, log } = setup({ event });
  assert.deepEqual(await review({ action: "revert-hunk", scope: "uncommitted", hunkId: hunk.id }), { status: "reverted" });
  assert.equal(log.dialogs.length, 1);
  assert.match(log.dialogs[0]!.detail, /^src\/a\.ts\n@@ -2,7 \+2,7 @@\n\+1 −1\n/);
  const command = log.requests[0] as Extract<ReviewWorkerCommand, { type: "review-revert-hunk" }>;
  assert.deepEqual([command.type, command.path, command.status, command.hunk.id, command.sessionId, command.storage], ["review-revert-hunk", "src/a.ts", "modified", hunk.id, target.taskId, "/profile/code/x"]);
  assert.deepEqual(log.reverted, [target.taskId]);
  // The same file at another place, or an id the diff does not have, is not the hunk the person saw.
  const stale = await review({ action: "revert-hunk", scope: "uncommitted", hunkId: "0".repeat(16) });
  assert.deepEqual(stale, { status: "stale" });
  assert.equal(log.requests.length, 1);
});

test("declining the dialog, or the app becoming busy while it was open, writes nothing", async () => {
  const declined = setup({ confirm: false });
  assert.deepEqual(await declined.review({ action: "revert-hunk", scope: "uncommitted", hunkId: hunk.id }), { status: "cancelled" });
  assert.equal(declined.log.requests.length, 0);
  const busy = setup({ ready: [true, false] });
  assert.deepEqual(await busy.review({ action: "revert-hunk", scope: "uncommitted", hunkId: hunk.id }), { status: "unavailable" });
  assert.equal(busy.log.requests.length, 0);
  const idle = setup({ ready: [false] });
  assert.deepEqual(await idle.review({ action: "revert-hunk", scope: "uncommitted", hunkId: hunk.id }), { status: "unavailable" });
  assert.equal(idle.log.dialogs.length, 0);
  for (const result of ["stale", "unavailable", "unconfirmed"] as const) {
    const refused = setup({ event: { type: "review-reverted", requestId: "r", result } });
    assert.deepEqual(await refused.review({ action: "revert-hunk", scope: "uncommitted", hunkId: hunk.id }), { status: result });
    assert.deepEqual(refused.log.reverted, []);
  }
  assert.deepEqual(await setup({ event: "unconfirmed" }).review({ action: "revert-hunk", scope: "uncommitted", hunkId: hunk.id }), { status: "unconfirmed" });
});

test("a review shows how many models will get the diff, then runs them and merges what they found", async () => {
  const results: ReviewModelResult[] = [
    { modelId: "fake-coder", modelName: "FAKE-CODER", status: "ok", findings: [{ file: "src/a.ts", line: 5, endLine: null, severity: "high", description: "Wrong value", suggestion: null }] },
    { modelId: "fake-small", modelName: "FAKE-SMALL", status: "ok", findings: [{ file: "src/a.ts", line: 5, endLine: null, severity: "low", description: "wrong  value", suggestion: null }] },
  ];
  const { review, log } = setup({ event: { type: "review-finished", requestId: "r", status: "done", results } });
  const outcome = await review({ action: "run", scope: "uncommitted", modelIds: ["fake-coder", "fake-small"] });
  assert.equal(outcome.status, "done");
  if (outcome.status !== "done") return;
  assert.deepEqual(outcome.findings.map((item) => [item.severity, item.models]), [["high", ["FAKE-CODER", "FAKE-SMALL"]]]);
  assert.equal(log.dialogs.length, 1);
  assert.match(log.dialogs[0]!.message, /2 model\(s\)/);
  assert.match(log.dialogs[0]!.detail, /^FAKE-CODER, FAKE-SMALL\nEach may use up to 8 requests/);
  const command = log.requests[0] as Extract<ReviewWorkerCommand, { type: "review-run" }>;
  assert.deepEqual([command.type, command.scope, command.models, command.truncated], ["review-run", "uncommitted", [{ id: "fake-coder", name: "FAKE-CODER" }, { id: "fake-small", name: "FAKE-SMALL" }], false]);
  assert.match(command.diffText, /^diff --git a\/src\/a\.ts b\/src\/a\.ts\n@@ -2,7 \+2,7 @@/);
  assert.match(command.diffText, /\+line five/);
  assert.equal(command.connection.key, "tvk_testkey000000000000");
});

test("no run starts for a model the catalogue lacks, an empty diff, a declined dialog, or a second action at once", async () => {
  const unknown = setup();
  assert.deepEqual(await unknown.review({ action: "run", scope: "uncommitted", modelIds: ["fake-coder", "no-such-model"] }), { status: "unavailable" });
  assert.deepEqual(unknown.log.dialogs, []);
  const emptyDeps = setupDeps();
  const empty = createReviewActions({ ...emptyDeps, models: () => [{ id: "m", name: "M" }], connection: () => ({ endpoint: "http://x", key: "k" }),
    readScope: async () => ({ status: "ok", diff: { scope: "uncommitted", files: [diffTexts("empty.txt", "", "")] } }) });
  assert.deepEqual(await empty({ action: "run", scope: "uncommitted", modelIds: ["m"] }), { status: "empty" });
  const declined = setup({ confirm: false });
  assert.deepEqual(await declined.review({ action: "run", scope: "uncommitted", modelIds: ["fake-coder"] }), { status: "cancelled" });
  assert.equal(declined.log.requests.length, 0);
  // While a review runs, a second run or a revert is refused, and cancel reaches the running request.
  let release: (event: WorkerEvent) => void = () => undefined;
  const slow = setup();
  const deps: ReviewHostDeps = { ...setupDeps(), models: () => [{ id: "m", name: "M" }], connection: () => ({ endpoint: "http://x", key: "k" }),
    readScope: async () => ({ status: "ok", diff }), cancel: (id) => slow.log.cancelled.push(id), newId: () => "run-1",
    request: () => new Promise((resolve) => { release = resolve; }), confirm: async () => true };
  const actions = createReviewActions(deps);
  const first = actions({ action: "run", scope: "uncommitted", modelIds: ["m"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await actions({ action: "run", scope: "uncommitted", modelIds: ["m"] }), { status: "unavailable" });
  assert.deepEqual(await actions({ action: "revert-hunk", scope: "uncommitted", hunkId: hunk.id }), { status: "unavailable" });
  assert.deepEqual(await actions({ action: "cancel" }), { status: "ok" });
  assert.deepEqual(slow.log.cancelled, ["run-1"]);
  release({ type: "review-finished", requestId: "run-1", status: "cancelled", results: [] });
  assert.deepEqual(await first, { status: "cancelled" });
});

test("a hunk is found by its id and only in a file whose lines are shown", () => {
  assert.equal(findHunk(diff, hunk.id)?.file.path, "src/a.ts");
  assert.equal(findHunk(diff, "f".repeat(16)), null);
  const omitted = { ...diff, files: [{ ...diff.files[0]!, omitted: "secret" as const }] };
  assert.equal(findHunk(omitted, hunk.id), null);
});

test("the review command is read only as exactly that, with an optional scope", () => {
  assert.deepEqual(parseReviewCommand("/review"), { scope: null });
  assert.deepEqual(parseReviewCommand("  /review turn  "), { scope: "last-turn" });
  assert.deepEqual(parseReviewCommand("/Review BRANCH"), { scope: "branch" });
  assert.deepEqual(parseReviewCommand("/review changes"), { scope: "uncommitted" });
  assert.deepEqual(parseReviewCommand("/review sometime"), { scope: null });
  for (const text of ["review", "/reviewer", "/review the auth change please", "please /review", "/review a b", ""]) assert.equal(parseReviewCommand(text), null, text);
});

test("comments become the next instruction with file, lines and the code they are about, and findings become a fix request", () => {
  const text = serializeReviewComments([
    { path: ".\\src\\a.ts", startLine: 12, endLine: 14, side: "new", snippet: "const a = `x`;\n```\nb();", text: "  Why is this not awaited? " },
    { path: "src/b.ts", startLine: 3, endLine: 3, side: "old", snippet: "removed();", text: "Keep this." },
  ]);
  assert.equal(text, [
    "Review comments on the current changes. Address each one:", "",
    "1. src/a.ts:12-14", "````", "const a = `x`;", "```", "b();", "````", "Comment: Why is this not awaited?", "",
    "2. src/b.ts:3 (removed lines)", "```", "removed();", "```", "Comment: Keep this.",
  ].join("\n"));
  assert.equal(serializeReviewComments([]), "");
  const fix = serializeFindingForFix({ file: "src/a.ts", line: 12, endLine: 15, severity: "high", description: "Loops forever.", suggestion: "Check the length.", models: ["A", "B"] });
  assert.match(fix, /^Fix this review finding \(high, reported by A, B\):\nsrc\/a\.ts:12-15\nLoops forever\.\nSuggested direction: Check the length\./);
  assert.match(serializeFindingForFix({ file: "x.ts", line: null, endLine: null, severity: "low", description: "d", suggestion: null, models: [] }), /^Fix this review finding \(low, reported by a reviewer\):\nx\.ts\nd\n/);
});

test("every language has the review strings, with the same placeholders", () => {
  const english = desktopCodeReviewCopy.en;
  for (const language of SUPPORTED_LANGUAGES) {
    const copy = desktopCodeReviewCopy[language];
    assert.deepEqual(Object.keys(copy).sort(), Object.keys(english).sort(), language);
    for (const key of Object.keys(english) as Array<keyof typeof english>) {
      const placeholders = (text: string) => (text.match(/\{[a-z]+\}/g) ?? []).sort();
      assert.deepEqual(placeholders(copy[key]), placeholders(english[key]), `${language}.${key}`);
      assert.ok(copy[key].trim().length > 0, `${language}.${key}`);
    }
  }
});
