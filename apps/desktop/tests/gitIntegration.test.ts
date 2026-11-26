import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { ApprovalRequest } from "../src/contract";
import { createGitIntegration } from "../src/host/git-integration";

const scratch = mkdtempSync(join(tmpdir(), "tomverse-git-integration-"));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, args.join(" ") + ": " + result.stderr);
  return result.stdout.trim();
}

function setup(name: string) {
  const work = join(scratch, name);
  const bare = join(scratch, name + "-remote");
  mkdirSync(work);
  mkdirSync(bare);
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(work, "init", "-q", "-b", "main");
  for (const [key, value] of [["user.name", "T"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"]]) git(work, "config", key, value!);
  writeFileSync(join(work, "a.txt"), "a\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "initial");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "-q", "origin", "main");
  git(work, "remote", "set-head", "origin", "main");
  git(work, "checkout", "-q", "-b", "feature");
  writeFileSync(join(work, "f.txt"), "f\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "feature work");
  const shown: ApprovalRequest[] = [];
  let busy = false;
  let pending = false;
  const integration = createGitIntegration({
    userData: join(scratch, name + "-data"), fixtureProfile: null,
    target: () => ({ folder: work, managed: false }), busy: () => busy, canAsk: () => !pending,
    showApproval: (request) => { shown.push(request); pending = true; },
    clearPending: () => { pending = false; },
    savedLinks: () => [], linkPull: async () => undefined, readPublic: async () => null, afterBranchChange: () => undefined,
  });
  return { work, bare, shown, integration, setBusy: (value: boolean) => { busy = value; } };
}

const remote = (bare: string) => git(bare, "for-each-ref", "refs/heads/");
async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(condition(), "timed out waiting for the approval card");
}

test("A push opens one approval card, and only the approval window's answer lets it run", async () => {
  const { bare, shown, integration } = setup("user");
  const run = integration.handle({ type: "publish" });
  await until(() => shown.length === 1);
  assert.equal(shown[0]?.git?.kind, "publish");
  assert.equal(shown[0]?.git?.origin, "user");
  assert.equal(shown[0]?.canRemember, false);
  assert.equal(remote(bare).includes("feature"), false, "nothing is pushed while the card is open");
  assert.equal(integration.decide({ id: "someone-else", action: "once" }), false);
  assert.equal(integration.decide({ id: shown[0]!.id, action: "once" }), true);
  const result = await run;
  assert.equal((result as { status: string }).status, "ok");
  assert.match(remote(bare), /refs\/heads\/feature/);
  assert.equal(integration.decide({ id: shown[0]!.id, action: "once" }), false, "an answer is used once");
});

test("A card that is denied, closed or dismissed pushes nothing, and a git card cannot be remembered", async () => {
  const { bare, shown, integration } = setup("denied");
  for (const answer of ["deny", "run", "dismiss"] as const) {
    const before = shown.length;
    const run = integration.handle({ type: "publish" });
    await until(() => shown.length === before + 1);
    if (answer === "dismiss") integration.dismiss(); else integration.decide({ id: shown.at(-1)!.id, action: answer });
    assert.deepEqual(await run, { status: "error", code: "denied" });
  }
  assert.equal(remote(bare).includes("feature"), false);
});

test("The person's own actions wait while a task or another approval is active, and the renderer cannot send its own approval", async () => {
  const { setBusy, integration, shown } = setup("busy");
  setBusy(true);
  assert.deepEqual(await integration.handle({ type: "publish" }), { status: "error", code: "busy" });
  assert.deepEqual(await integration.handle({ type: "commit", message: "x", paths: ["f.txt"] }), { status: "error", code: "busy" });
  await assert.rejects(integration.handle({ type: "publish", approved: true }));
  await assert.rejects(integration.handle({ type: "approve", id: "x" }));
  assert.equal(shown.length, 0);
});

test("The agent's push is off by default; once switched on it opens the same card and cannot answer it", async () => {
  const { bare, shown, integration, setBusy } = setup("agent");
  setBusy(true);
  assert.deepEqual(await integration.agent({ kind: "publish" }), { status: "disabled" });
  assert.deepEqual(await integration.handle({ type: "agent-actions" }), { enabled: false });
  assert.deepEqual(await integration.handle({ type: "agent-actions", enabled: true }), { enabled: true });
  const run = integration.agent({ kind: "publish" });
  await until(() => shown.length === 1);
  assert.equal(shown[0]?.git?.origin, "agent");
  assert.equal(remote(bare).includes("feature"), false);
  integration.decide({ id: shown[0]!.id, action: "once" });
  const result = await run;
  assert.equal(result.status, "published");
  assert.match(remote(bare), /refs\/heads\/feature/);
  assert.deepEqual(await integration.agent({ kind: "publish", approved: true }), { status: "error" });
});

test("An agent's push or commit while another card is open or a task is not idle opens no card and runs nothing", async () => {
  const { work, bare, shown, integration } = setup("agent-busy");
  writeFileSync(join(work, "g.txt"), "g\n");
  assert.deepEqual(await integration.handle({ type: "agent-actions", enabled: true }), { enabled: true });
  const first = integration.agent({ kind: "publish" });
  await until(() => shown.length === 1);
  // A second request while the first card is waiting is refused at once: there is never a queue of cards the person might click through.
  assert.deepEqual(await integration.agent({ kind: "publish" }), { status: "denied", code: "denied" });
  assert.deepEqual(await integration.agent({ kind: "commit", message: "x", paths: ["g.txt"] }), { status: "denied", code: "denied" });
  assert.equal(shown.length, 1);
  // A card that is answered with anything but "once" (here: allow for this run) does not approve, and nothing is remembered for the next push.
  integration.decide({ id: shown[0]!.id, action: "run" });
  assert.deepEqual(await first, { status: "denied", code: "denied" });
  assert.equal(remote(bare).includes("feature"), false);
  const second = integration.agent({ kind: "publish" });
  await until(() => shown.length === 2);
  integration.dismiss();
  assert.deepEqual(await second, { status: "denied", code: "denied" });
  assert.equal(remote(bare).includes("feature"), false, "a push asks again every time");
});
