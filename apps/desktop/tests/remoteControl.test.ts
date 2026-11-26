import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ApprovalRequest, Decision, Task } from "../src/contract";
import {
  REMOTE_FAST_POLL_MS, REMOTE_SLOW_POLL_MS, approvalDigest, createRemoteControl, remoteAnswerable, remoteSnapshot,
  type RemoteCard, type RemoteTaskSource,
} from "../src/host/remote-control";

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const KEY = "tvk_live_connectedcodekey123456";

const commandCard = (display = "npm test", over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: uuid(), root: "/work/app", tool: "run_command", canRemember: true,
  command: { mode: "shell", file: "npm", args: ["test"], cwd: "/work/app", display, env: ["DEPLOY_TOKEN"], timeoutMs: 60_000 },
  ...over,
});
const fileCard = (paths: string[] = ["src/login.ts"]): ApprovalRequest => ({
  id: uuid(), root: "/work/app", tool: "apply_patch", canRemember: true,
  files: paths.map((path) => ({ path, action: "update", eol: "lf", bom: false, preimage: "aa11", postimage: "bb22",
    before: "const apiKey = 'old-file-content';", after: "const apiKey = 'new-file-content';" })),
});
const task = (entries: Task["entries"] = [], changes = 0): Task => ({
  id: "s-20261126-101010-abcdef", root: "/work/app", title: "Fix the login form", status: "running", entries,
  changes: Array.from({ length: changes }, (_, index) => ({ id: String(index), path: `f${index}.ts`, kind: "update", current: "x" })),
  checks: [], transmission: [],
});

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Reply = { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number } | Error;

function setup(options: { enabled?: boolean } = {}) {
  const userData = mkdtempSync(join(tmpdir(), "tomverse-remote-"));
  let now = 1_000_000;
  let account: { accountId: string; origin: string; key?: string; authorize(): Promise<string> } | null = {
    accountId: "account-a", origin: "https://tomverse.test", key: KEY, authorize: async () => "desktop-access-token",
  };
  const foreground = uuid();
  let tasks: RemoteTaskSource[] = [];
  let card: RemoteCard | null = null;
  const answers: Decision[] = [];
  const stops: string[] = [];
  const followUps: Array<{ key: string; text: string }> = [];
  let confirm = true;
  const calls: Call[] = [];
  const replies: Reply[] = [];
  const transport = (async (url: URL | string, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    calls.push({ url: String(url), method: init?.method ?? "GET", headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const reply = replies.shift() ?? { status: 200, body: { ok: true, deviceId: "device-1", commands: [] } };
    if (reply instanceof Error) throw reply;
    now += reply.delayMs ?? 0;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: reply.headers });
  }) as typeof fetch;
  const control = createRemoteControl({
    userData,
    account: () => account,
    tasks: () => tasks,
    card: () => card,
    answer: (decision) => {
      if (!card || card.request.id !== decision.id) return false;
      answers.push(decision);
      card = null;
      return true;
    },
    stop: (key) => { stops.push(key); return true; },
    followUp: async (key, text) => { followUps.push({ key, text }); return true; },
    confirmEnable: async () => confirm,
    transport,
    now: () => now,
    every: () => ({ stop() {} }),
  });
  control.start();
  const settle = async () => {
    for (let index = 0; index < 20 && control.busy(); index += 1) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  const step = async (ms = 0) => { now += ms; control.tick(); await settle(); };
  const running = (over: Partial<RemoteTaskSource> = {}): RemoteTaskSource => ({
    key: foreground, kind: "foreground", title: "Fix the login form", status: "running", task: task(), canStop: true, canFollowUp: true, ...over,
  });
  return {
    control, userData, calls, replies, answers, stops, followUps, foreground, running, step,
    syncs: () => calls.filter((call) => call.method === "POST"),
    setTasks: (value: RemoteTaskSource[]) => { tasks = value; },
    setCard: (value: RemoteCard | null) => { card = value; },
    setAccount: (value: typeof account) => { account = value; },
    setConfirm: (value: boolean) => { confirm = value; },
    async enable() { const view = await control.command({ action: "set", enabled: options.enabled ?? true }); return view; },
    done: () => rmSync(userData, { recursive: true, force: true }),
  };
}

const commandFor = (card: ApprovalRequest, over: Record<string, unknown> = {}) => ({
  id: uuid(), kind: "approval", deviceId: "device-1", taskKey: "", approvalId: card.id, digest: approvalDigest(card), decision: "once", ageMs: 100, ...over,
});

test("a remote answer reaches only the request open on the PC, once", async (t) => {
  const s = setup();
  t.after(s.done);
  await s.enable();
  const open = commandCard();
  s.setTasks([s.running({ status: "approval" })]);
  s.setCard({ request: open, taskKey: s.foreground });
  await s.step();
  const reported = s.syncs()[0]!.body as { snapshot: { approval: { id: string; digest: string; remote: boolean } } };
  assert.equal(reported.snapshot.approval.id, open.id);
  assert.equal(reported.snapshot.approval.digest, approvalDigest(open));
  assert.equal(reported.snapshot.approval.remote, true);

  const other = commandCard("npm run lint");
  const answer = commandFor(open, { taskKey: s.foreground });
  s.replies.push({ status: 200, body: { ok: true, deviceId: "device-1", commands: [
    commandFor(other, { taskKey: s.foreground }),                                   // a request this PC does not have open
    commandFor(open, { taskKey: s.foreground, digest: "f".repeat(64) }),            // the request changed since it was reported
    commandFor(open, { taskKey: s.foreground, deviceId: "device-2" }),             // another device's answer
    commandFor(open, { taskKey: s.foreground, ageMs: 2 * 60_000 + 1 }),            // too old
    answer,
    answer,                                                                          // the same answer again
    commandFor(open, { taskKey: s.foreground, decision: "deny" }),                 // a second answer for the same request
  ] } });
  await s.step(REMOTE_FAST_POLL_MS);
  assert.deepEqual(s.answers, [{ id: open.id, action: "once" }]);
  await s.step(1_000);
  const acks = (s.syncs().at(-1)!.body as { acks: Array<{ result: string; reason?: string }> }).acks;
  assert.deepEqual(acks.map((ack) => ack.reason ?? ack.result), ["not_open", "changed", "device", "expired", "applied", "duplicate", "duplicate"]);
});

test("an answer that was young at the server and old on arrival is not applied", async (t) => {
  const s = setup();
  t.after(s.done);
  await s.enable();
  const open = commandCard();
  s.setTasks([s.running({ status: "approval" })]);
  s.setCard({ request: open, taskKey: s.foreground });
  await s.step();
  // The server handed it over ten seconds before its two minutes ran out; the reply took fifteen to arrive.
  s.replies.push({ status: 200, delayMs: 15_000, body: { ok: true, deviceId: "device-1", commands: [
    commandFor(open, { taskKey: s.foreground, ageMs: 2 * 60_000 - 10_000 }),
  ] } });
  await s.step(REMOTE_FAST_POLL_MS);
  assert.deepEqual(s.answers, []);
  await s.step(1_000);
  const acks = (s.syncs().at(-1)!.body as { acks: Array<{ result: string; reason?: string }> }).acks;
  assert.deepEqual(acks.map((ack) => ack.reason ?? ack.result), ["expired"]);
});

test("requests answered at the PC are never applied from another device", async (t) => {
  const s = setup();
  t.after(s.done);
  await s.enable();
  const pcOnly: ApprovalRequest[] = [
    commandCard("git push origin main"),
    commandCard("curl -X POST https://example.com/upload"),
    commandCard("npm publish"),
    commandCard("cat ~/.ssh/id_rsa"),
    commandCard("deploy --token ghp_abcdefghijklmnopqrstuvwxyz0123"),
    commandCard("npm test\nnpm run build"),
    commandCard("x".repeat(301)),
    fileCard(Array.from({ length: 11 }, (_, index) => `src/file${index}.ts`)),
    { ...commandCard(), command: undefined, web: { url: "https://example.com/?q=secret", host: "example.com" } },
    { ...commandCard(), command: undefined, browser: { action: "click", origin: "http://localhost:3000", url: "http://localhost:3000/", selector: "#go" } },
    { ...commandCard(), command: undefined, mcp: { server: "github", tool: "create_issue", scope: "user", args: "{}" } },
    { ...commandCard(), command: undefined, git: { kind: "push" } as unknown as ApprovalRequest["git"] },
    { id: uuid(), root: "/work/app", tool: "unknown", canRemember: false },
  ];
  for (const request of pcOnly) assert.equal(remoteAnswerable(request, KEY), false, JSON.stringify(request).slice(0, 120));
  assert.equal(remoteAnswerable(commandCard("npm test -- --watch=false"), KEY), true);
  assert.equal(remoteAnswerable(fileCard(["src/a.ts", "README.md"]), KEY), true);

  s.setTasks([s.running({ status: "approval" })]);
  for (const request of pcOnly) {
    s.setCard({ request, taskKey: s.foreground });
    s.replies.push({ status: 200, body: { ok: true, deviceId: "device-1", commands: [] } });
    await s.step(REMOTE_SLOW_POLL_MS);
    const approval = (s.syncs().at(-1)!.body as { snapshot: { approval: { remote: boolean } | null } }).snapshot.approval;
    assert.equal(approval?.remote ?? false, false);
    s.replies.push({ status: 200, body: { ok: true, deviceId: "device-1", commands: [commandFor(request, { taskKey: s.foreground })] } });
    await s.step(REMOTE_SLOW_POLL_MS);
  }
  assert.deepEqual(s.answers, []);
  // "Allow for this run" is not something another device can say: such a reply is refused whole.
  const open = commandCard();
  s.setCard({ request: open, taskKey: s.foreground });
  s.replies.push({ status: 200, body: { ok: true, deviceId: "device-1", commands: [commandFor(open, { taskKey: s.foreground, decision: "run" })] } });
  await s.step(REMOTE_SLOW_POLL_MS);
  assert.deepEqual(s.answers, []);
  assert.equal(s.control.view().status, "error");
});

test("the report carries no file contents, command output, environment values or credentials", () => {
  const card = fileCard(["src/login.ts"]);
  const entries: Task["entries"] = [
    { role: "user", text: "Use my key sk-proj-abcdefghijklmnopqrstuvwx to call the API" },
    { role: "assistant", text: "```ts\nconst apiKey = 'file-content-line';\n```\nI changed the form." },
    { role: "event", text: `Ran npm test with ${KEY} and Authorization: Bearer abcdefghijklmnop` },
    { role: "assistant", text: "password=hunter2 is in .env; " + "y".repeat(400) },
  ];
  const snapshot = remoteSnapshot([{
    key: uuid(), kind: "foreground", title: `Deploy with ${KEY} please`, status: "approval", task: task(entries, 3), canStop: true, canFollowUp: false,
  }], { request: card, taskKey: "" }, KEY);
  // The card names a task that is not in the report, so it is not reported.
  assert.equal(snapshot.approval, null);
  const withCard = remoteSnapshot([{ key: "00000000-0000-4000-8000-000000009999", kind: "foreground", title: "t", status: "approval",
    task: task(entries), canStop: true, canFollowUp: false }], { request: card, taskKey: "00000000-0000-4000-8000-000000009999" }, KEY);
  const command = commandCard("API_KEY=abcdef123456 npm test");
  const withCommand = remoteSnapshot([{ key: "00000000-0000-4000-8000-000000009998", kind: "parallel", title: "t", status: "approval",
    task: null, canStop: true, canFollowUp: false }], { request: command, taskKey: "00000000-0000-4000-8000-000000009998" }, KEY);
  const json = JSON.stringify([snapshot, withCard, withCommand]);
  for (const leaked of [KEY, "sk-proj-abcdefghijklmnopqrstuvwx", "file-content", "old-file-content", "new-file-content", "aa11", "bb22",
    "hunter2", "abcdefghijklmnop", "abcdef123456", "DEPLOY_TOKEN", "Use my key"]) {
    assert.equal(json.includes(leaked), false, leaked);
  }
  assert.deepEqual(withCard.approval?.files, [{ path: "src/login.ts", action: "update" }]);
  assert.equal(withCard.approval?.remote, true);
  assert.equal(withCommand.approval?.target, "API_KEY=[removed] npm test");
  // A command line that had to be redacted is not shown whole, so it is answered at the PC.
  assert.equal(withCommand.approval?.remote, false);
  assert.equal(snapshot.tasks[0]!.title, "Deploy with [credential removed] please");
  assert.equal(snapshot.tasks[0]!.changes, 3);
  assert.ok(snapshot.tasks[0]!.progress.length <= 4);
  assert.ok(snapshot.tasks[0]!.progress.every((line) => line.length <= 160));
  assert.equal(snapshot.tasks[0]!.progress[0], "I changed the form.");
});

test("nothing is sent while the switch is off or nothing runs, and the report stops when the tasks end", async (t) => {
  const s = setup();
  t.after(s.done);
  s.setTasks([s.running()]);
  await s.step(60_000);
  assert.equal(s.calls.length, 0, "off: nothing is sent");
  assert.equal(s.control.view().status, "off");

  s.setConfirm(false);
  assert.equal((await s.enable()).enabled, false, "turning it on asks first");
  s.setConfirm(true);
  s.setTasks([]);
  assert.equal((await s.enable()).enabled, true);
  await s.step(60_000);
  assert.equal(s.calls.length, 0, "on, nothing runs: nothing is sent");
  assert.equal(s.control.view().status, "idle");
  assert.equal(s.control.view().page, "https://tomverse.test/remote");

  s.setTasks([s.running()]);
  await s.step();
  assert.equal(s.syncs().length, 1);
  assert.equal(s.calls[0]!.url, "https://tomverse.test/api/desktop/remote/sync");
  assert.equal(s.calls[0]!.headers.Authorization, "Bearer desktop-access-token");
  assert.equal(s.calls[0]!.headers.Origin, "tomverse://desktop");
  await s.step(REMOTE_SLOW_POLL_MS - 1_000);
  assert.equal(s.syncs().length, 1, "unchanged: no new report before the slow interval");
  await s.step(1_000);
  assert.equal(s.syncs().length, 2);
  // A request that may be answered from elsewhere opens: reported at once, then polled quickly.
  s.setCard({ request: commandCard(), taskKey: s.foreground });
  await s.step(1_000);
  assert.equal(s.syncs().length, 3);
  await s.step(REMOTE_FAST_POLL_MS);
  assert.equal(s.syncs().length, 4);
  s.setCard(null);

  s.setTasks([]);
  await s.step(1_000);
  assert.equal(s.syncs().length, 5);
  assert.deepEqual((s.syncs().at(-1)!.body as { snapshot: { tasks: unknown[] } }).snapshot.tasks, [], "the last report says nothing runs");
  await s.step(60_000);
  await s.step(60_000);
  assert.equal(s.syncs().length, 5, "then nothing is sent");

  // The server does not offer it: it is asked again only much later.
  s.setTasks([s.running()]);
  s.replies.push({ status: 503, body: { ok: false, code: "NOT_AVAILABLE" } });
  await s.step(1_000);
  assert.equal(s.control.view().status, "unavailable");
  await s.step(5 * 60_000);
  assert.equal(s.syncs().length, 6);
  await s.step(5 * 60_000);
  assert.equal(s.syncs().length, 7);

  // A failure backs off.
  s.replies.push(new Error("offline"), new Error("offline"));
  await s.step(REMOTE_SLOW_POLL_MS);
  const failedAt = s.syncs().length;
  await s.step(4_000);
  assert.equal(s.syncs().length, failedAt);
  await s.step(1_000);
  assert.equal(s.syncs().length, failedAt + 1);
  await s.step(9_000);
  assert.equal(s.syncs().length, failedAt + 1);
  await s.step(1_000);
  assert.equal(s.syncs().length, failedAt + 2);
  assert.equal(s.control.view().status, "connected");
});

test("the switch belongs to one account, and turning it off or signing out removes the report", async (t) => {
  const s = setup();
  t.after(s.done);
  await s.enable();
  assert.deepEqual(JSON.parse(readFileSync(join(s.userData, "remote-control.json"), "utf8")), { accountId: "account-a", enabled: true });
  s.setTasks([s.running()]);
  await s.step();
  assert.equal(s.syncs().length, 1);

  s.setAccount({ accountId: "account-b", origin: "https://tomverse.test", authorize: async () => "other-token" });
  await s.step(60_000);
  assert.equal(s.syncs().length, 1, "another account starts with it off");
  assert.equal(s.control.view().enabled, false);

  s.setAccount({ accountId: "account-a", origin: "https://tomverse.test", key: KEY, authorize: async () => "desktop-access-token" });
  await s.step();
  assert.equal(s.syncs().length, 2);
  await s.control.command({ action: "set", enabled: false });
  assert.equal(s.calls.at(-1)!.method, "DELETE");
  await s.step(60_000);
  assert.equal(s.syncs().length, 2);

  await s.enable();
  await s.step();
  const before = s.calls.length;
  // By the time it signs out the main process offers no account any more; the sign-out's own token is used.
  s.setAccount(null);
  await s.control.signingOut("signing-out-token");
  assert.equal(s.calls.length, before + 1);
  assert.equal(s.calls.at(-1)!.method, "DELETE");
  assert.equal(s.calls.at(-1)!.headers.Authorization, "Bearer signing-out-token");
  await assert.rejects(s.control.command({ action: "open", url: "https://evil.test" }));
});

test("stop and follow-up reach only a running task that can take them", async (t) => {
  const s = setup();
  t.after(s.done);
  await s.enable();
  const lane = uuid();
  s.setTasks([s.running(), s.running({ key: lane, kind: "parallel", canFollowUp: false })]);
  await s.step();
  s.replies.push({ status: 200, body: { ok: true, deviceId: "device-1", commands: [
    { id: uuid(), kind: "stop", deviceId: "device-1", taskKey: lane, ageMs: 10 },
    { id: uuid(), kind: "stop", deviceId: "device-1", taskKey: uuid(), ageMs: 10 },
    { id: uuid(), kind: "follow_up", deviceId: "device-1", taskKey: s.foreground, text: "  Also update the tests.  ", ageMs: 10 },
    { id: uuid(), kind: "follow_up", deviceId: "device-1", taskKey: lane, text: "Not this one.", ageMs: 10 },
  ] } });
  await s.step(REMOTE_SLOW_POLL_MS);
  assert.deepEqual(s.stops, [lane]);
  assert.deepEqual(s.followUps, [{ key: s.foreground, text: "Also update the tests." }]);
  await s.step(1_000);
  const acks = (s.syncs().at(-1)!.body as { acks: Array<{ result: string; reason?: string }> }).acks;
  assert.deepEqual(acks.map((ack) => ack.reason ?? ack.result), ["applied", "not_open", "applied", "unavailable"]);
});
