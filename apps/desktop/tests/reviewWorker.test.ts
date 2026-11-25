import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Gateway, Journal, Workspace, createSession, resolveLimits, type CatalogModel } from "../../tomverse-cli/src/runtime";
import { planPatch } from "../../tomverse-cli/src/patch";
import { applyPlannedPatch, type ToolContext } from "../../tomverse-cli/src/tools";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { bindProjectRoot } from "../src/host/project-root";
import { createReviewWorker, type ReviewWorkerDeps } from "../src/host/review-worker";
import type { WorkerCommand } from "../src/host/messages";

const model: CatalogModel = { id: "m", name: "M", provider: "p", tools: true, vision: false, reasoning: false, protocols: ["chat_completions"],
  contextWindowTokens: 100_000, maxOutputTokens: 4_000, creditsPerRequest: 1 };
const rows = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const endpoint = { base: "http://127.0.0.1:1/api/code/v1", origin: "http://127.0.0.1:1", basePath: "/api/code/v1" };

function saved(t: test.TestContext) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "tomverse-review-worker-")));
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));
  const root = join(temp, "project");
  const home = join(temp, "home");
  mkdirSync(root);
  writeFileSync(join(root, "a.txt"), rows(12));
  const workspace = new Workspace(root, [join(temp, "profile")]);
  const journal = createSession(home, { root, endpoint: endpoint as never, keyPrefix: "tvk_testkey00", model, readOnly: false, limits: resolveLimits("standard"), codeMode: "agent" });
  journal.state.checkpoints = [{ kind: "prompt", task: 0, messageIndex: 0, changeStart: 0, toolStart: 0, at: new Date().toISOString(), text: "Do it" }];
  const context = { readByteLimit: 0, workspace, journal, commandTimeoutMs: 0, commandEnv: [], signal: () => new AbortController().signal,
    onActivity: () => undefined, onCommandOutput: () => undefined } satisfies ToolContext;
  applyPlannedPatch(context, "call-1", planPatch(workspace, [{ path: "a.txt", action: "update", replacements: [{ old: "line 6\n", new: "line six\n" }] }]));
  journal.state.status = "completed";
  journal.commit();
  const id = journal.state.id;
  journal.release();
  const project = bindProjectRoot(root);
  const record = { storage: home, sessionId: id, project, scope: { home, legacyHome: home, root, base: endpoint.base, origin: endpoint.origin, keyIdentity: "k", keyPrefix: "tvk_testkey00" } };
  const opened: Journal[] = [];
  const events: string[] = [];
  const deps: ReviewWorkerDeps = {
    open: () => { const journal = Journal.open(home, id); opened.push(journal); return journal; },
    lock: () => { events.push("lock"); return () => events.push("unlock"); },
    busy: () => false, hold: () => () => events.push("release"),
    gateway: () => { throw new Error("no gateway here"); }, protectedRoots: (protectedRoot) => [protectedRoot],
  };
  return { root, record, deps, events, protectedRoot: join(temp, "profile") };
}

test("the runtime reads the last turn, reverts a hunk once, and refuses the same hunk the second time", (t) => {
  const { root, record, deps, events, protectedRoot } = saved(t);
  const worker = createReviewWorker(deps);
  const turn = worker.turnDiff({ type: "review-turn-diff", requestId: "r1", ...record, protectedRoot });
  assert.equal(turn.type, "review-turn");
  if (turn.type !== "review-turn") return;
  const file = turn.diff!.files[0]!;
  assert.deepEqual([file.path, file.hunks.length], ["a.txt", 1]);
  const revert = (id: string) => worker.revertHunk({ type: "review-revert-hunk", requestId: id, ...record, protectedRoot, path: file.path, status: file.status, hunk: file.hunks[0]! });
  const done = revert("r2");
  assert.deepEqual([done.type, done.type === "review-reverted" && done.result], ["review-reverted", "reverted"]);
  assert.equal(done.type === "review-reverted" && done.changes?.length, 2);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), rows(12));
  const again = revert("r3");
  assert.equal(again.type === "review-reverted" && again.result, "stale");
  assert.deepEqual(events, ["lock", "unlock", "lock", "unlock"]);
  // Every journal it opened was let go again.
  const reopened = Journal.open(record.storage, record.sessionId);
  reopened.release();
});

test("nothing is read or written while a task runs, and a project that moved is not written to", (t) => {
  const { record, deps, protectedRoot } = saved(t);
  const busy = createReviewWorker({ ...deps, busy: () => true });
  assert.deepEqual(busy.turnDiff({ type: "review-turn-diff", requestId: "r1", ...record, protectedRoot }), { type: "review-turn", requestId: "r1", diff: null, reason: "failed" });
  const hunk = { newStart: 1, newCount: 1, lines: [{ kind: "add" as const, text: "x" }], id: "i", header: "h", oldStart: 1, oldCount: 0 };
  assert.deepEqual(busy.revertHunk({ type: "review-revert-hunk", requestId: "r2", ...record, protectedRoot, path: "a.txt", status: "modified", hunk }),
    { type: "review-reverted", requestId: "r2", result: "unavailable" });
  const moved = { ...record, project: { ...record.project, identity: "0:0" } };
  const refused = createReviewWorker(deps).revertHunk({ type: "review-revert-hunk", requestId: "r3", ...moved, protectedRoot, path: "a.txt", status: "modified", hunk });
  assert.equal(refused.type === "review-reverted" && refused.result, "unavailable");
});

test("a review marks the runtime busy, takes the project lock, and sends the reviewers nothing that looks like the key", async (t) => {
  const { record, deps, events, protectedRoot } = saved(t);
  const prompts: string[] = [];
  const fake = await new FakeGateway({ script: (body) => {
    prompts.push(JSON.stringify(body.messages));
    return { text: '{"summary":"fine","findings":[]}' };
  } }).start();
  t.after(() => fake.stop());
  const client = new Gateway({ base: fake.base, origin: new URL(fake.base).origin, basePath: "/api/code/v1" } as never, TEST_KEY);
  const worker = createReviewWorker({ ...deps, gateway: () => client });
  const command: Extract<WorkerCommand, { type: "review-run" }> = {
    type: "review-run", requestId: "run-1", project: record.project, connection: { endpoint: fake.base, key: TEST_KEY }, protectedRoot, scope: "uncommitted",
    diffText: `diff --git a/a.txt b/a.txt\n+const key = "${TEST_KEY}";\n+const other = "tvk_aaaaaaaaaaaaaaaaaaaa";`, truncated: false,
    models: [{ id: "fake-coder", name: "Fake Coder" }, { id: "fake-small", name: "Fake Small" }],
  };
  const event = await worker.run(command);
  assert.equal(event.type, "review-finished");
  if (event.type !== "review-finished") return;
  assert.equal(event.status, "done");
  assert.deepEqual(event.results.map((result) => [result.modelName, result.status]), [["Fake Coder", "ok"], ["Fake Small", "ok"]]);
  assert.deepEqual(events, ["lock", "unlock", "release"]);
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    assert.ok(!prompt.includes(TEST_KEY) && !prompt.includes("tvk_aaaaaaaaaaaaaaaaaaaa"), "a credential reached a reviewer");
    assert.match(prompt, /\[credential removed\]/);
  }
  const busy = await createReviewWorker({ ...deps, busy: () => true }).run(command);
  assert.deepEqual(busy, { type: "review-finished", requestId: "run-1", status: "unavailable", results: [] });
});
