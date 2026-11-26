import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Journal } from "../../tomverse-cli/src/session.js";
import { RemoteWorkspace } from "../../tomverse-cli/src/remote-workspace.js";
import { HAS_SH, makeFakeRemote } from "../../tomverse-cli/tests/remote-fixture.js";
import type { RemoteProjectInput } from "../src/remote-contract";
import { bindProjectRoot, assertProjectRoot, type ProjectRoot } from "../src/host/project-root";
import { createRemoteProjectHost } from "../src/host/remote-project-host";
import {
  ensureRemoteShadow, isRemoteShadow, readRemoteSettings, remoteOfPath, setRemoteShadowBase, sshEnvironmentForRuntime, sshRunnerFor, testRemote, withRecent, writeRemoteSettings,
} from "../src/host/remote-project";
import { inspectRemoteChange, openRemoteWorkspace, RemoteRunError, undoRemoteChange } from "../src/host/remote-worker";
import { scheduleShapeProblem } from "../src/schedule-policy";

const skip = !HAS_SH && "needs a POSIX sh (Git for Windows has one)";

const folder = (prefix: string) => realpathSync.native(mkdtempSync(join(tmpdir(), `tvdesk-${prefix}-`)));
const target = { destination: "devbox", folder: "/srv/app" };

test("the switch and the recent list are kept in the app's own folder, off by default, and a damaged file means off", () => {
  const directory = join(folder("settings"), "remote-projects");
  assert.deepEqual(readRemoteSettings(directory), { enabled: false, recent: [] });
  assert.deepEqual(readRemoteSettings(undefined), { enabled: false, recent: [] });
  writeRemoteSettings(directory, withRecent({ enabled: true, recent: [] }, target));
  assert.deepEqual(readRemoteSettings(directory), { enabled: true, recent: [target] });
  const again = withRecent(withRecent(readRemoteSettings(directory), { destination: "b", port: 2200, folder: "/x/y" }), target);
  assert.deepEqual(again.recent.map((item) => item.destination), ["devbox", "b"], "an entry moves to the front, never twice");
  let settings = again;
  for (let n = 0; n < 12; n += 1) settings = withRecent(settings, { destination: `h${n}`, folder: "/srv/p" });
  assert.equal(settings.recent.length, 8);
  // A recent entry that is no longer a valid target is dropped; "enabled" must be exactly true.
  writeFileSync(join(directory, "settings.json"), JSON.stringify({ enabled: "yes", recent: [{ destination: "-oProxyCommand=x", folder: "/srv/app" }, target, 5] }));
  assert.deepEqual(readRemoteSettings(directory), { enabled: false, recent: [target] });
  writeFileSync(join(directory, "settings.json"), "{ broken");
  assert.deepEqual(readRemoteSettings(directory), { enabled: false, recent: [] });
});

test("a remote project is a shadow folder of the app's own, and only the app's own shadow folders are remote", () => {
  const base = join(folder("shadow"), "Tomverse Desktop Remote Projects");
  setRemoteShadowBase(base);
  try {
    const shadow = ensureRemoteShadow(target);
    assert.equal(realpathSync(base), join(shadow, ".."));
    assert.deepEqual(remoteOfPath(shadow), target);
    assert.equal(ensureRemoteShadow(target), shadow, "the same target is the same folder");
    assert.notEqual(ensureRemoteShadow({ ...target, folder: "/srv/other" }), shadow);
    assert.notEqual(ensureRemoteShadow({ ...target, port: 2200 }), shadow);
    assert.equal(isRemoteShadow(shadow), true);
    // Binding the folder again (a saved task is found this way) finds the machine, and the project keeps its identity.
    const project = bindProjectRoot(shadow);
    assert.deepEqual(project.remote, target);
    assert.doesNotThrow(() => assertProjectRoot(project));
    // A marker in any other folder makes nothing remote: a repository cannot name a machine for the app to work on.
    const repo = folder("repo");
    writeFileSync(join(repo, ".tomverse-remote.json"), readFileSync(join(shadow, ".tomverse-remote.json")));
    assert.equal(remoteOfPath(realpathSync(repo)), null);
    assert.equal(bindProjectRoot(repo).remote, undefined);
    assert.equal(isRemoteShadow(repo), false);
    // A marker copied into another shadow folder does not move that folder to another machine.
    const other = ensureRemoteShadow({ destination: "other", folder: "/srv/else" });
    writeFileSync(join(other, ".tomverse-remote.json"), readFileSync(join(shadow, ".tomverse-remote.json")));
    assert.equal(remoteOfPath(other), null);
    // A folder inside a shadow folder is not one.
    mkdirSync(join(shadow, "inner"));
    assert.equal(remoteOfPath(join(shadow, "inner")), null);
    // A marker that names an invalid target is refused.
    writeFileSync(join(shadow, ".tomverse-remote.json"), JSON.stringify({ version: 1, destination: "-oProxyCommand=x", folder: "/srv/app" }));
    assert.equal(remoteOfPath(shadow), null);
  } finally {
    setRemoteShadowBase(undefined);
  }
  assert.equal(remoteOfPath(base), null, "without a base nothing is remote");
});

test("the runtime is given only what ssh needs of the environment", () => {
  const forwarded = JSON.parse(sshEnvironmentForRuntime({ PATH: "/bin", HOME: "/home/me", SSH_AUTH_SOCK: "/tmp/agent", TOMVERSE_API_KEY: "tvk_secret", ELECTRON_RUN_AS_NODE: "1", GITHUB_TOKEN: "x", USERPROFILE: "C:\\Users\\me" })) as Record<string, string>;
  assert.deepEqual(Object.keys(forwarded).sort(), ["HOME", "PATH", "SSH_AUTH_SOCK", "USERPROFILE"]);
  assert.doesNotThrow(() => sshRunnerFor({ forwardedEnvironment: "not json" }));
});

test("a schedule of a project with no sandbox may not run with allow-all", () => {
  const off = { mode: "off" as const, available: false, writes: "none" as const };
  assert.equal(scheduleShapeProblem({ taskMode: "agent", permission: "allow_all", workspace: "worktree" }, { sandbox: off, gitProject: true }), "needs-sandbox");
  assert.equal(scheduleShapeProblem({ taskMode: "agent", permission: "allow_all", workspace: "folder" }, { sandbox: off, gitProject: false }), "needs-worktree");
});

test("the connection test names what is wrong and changes nothing", { skip }, async () => {
  const fake = makeFakeRemote();
  const found = await testRemote(fake.target, fake.runner);
  assert.equal(found.ok, true);
  assert.equal(found.ok && found.folder, fake.target.folder);
  const failures: Array<[string, string]> = [["badauth", "auth"], ["newhost", "host-key"], ["changedhost", "host-key-changed"], ["nohost", "name-not-found"], ["refused", "unreachable"]];
  for (const [destination, failure] of failures) {
    const result = await testRemote({ ...fake.target, destination }, fake.runner);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.failure, failure, destination);
  }
  const missing = await testRemote({ ...fake.target, folder: `${fake.target.folder}/nope` }, fake.runner);
  assert.equal(!missing.ok && missing.failure, "folder-missing");
  writeFileSync(join(fake.root, "f"), "x");
  const file = await testRemote({ ...fake.target, folder: `${fake.target.folder}/f` }, fake.runner);
  assert.equal(!file.ok && file.failure, "not-a-folder");
  const broad = await testRemote({ ...fake.target, folder: "/" }, fake.runner);
  assert.equal(!broad.ok && broad.failure, "folder-too-broad");
  const slow = makeFakeRemote({ destination: "slow" });
  assert.deepEqual(readdirSync(fake.root), ["f"], "nothing was written to the folder");
  const timedOut = await testRemote(slow.target, slow.runner, AbortSignal.timeout(500));
  assert.equal(timedOut.ok, false);
});

test("the host: with the switch off nothing starts ssh; on, a target is checked, tested, opened and remembered", { skip }, async () => {
  const fake = makeFakeRemote();
  const settingsDirectory = join(folder("host-settings"), "remote-projects");
  const base = join(folder("host-shadow"), "shadows");
  setRemoteShadowBase(base);
  let opened: ProjectRoot | null = null;
  let busy = false;
  let sandbox = false;
  let calls = 0;
  const host = createRemoteProjectHost({
    settingsDirectory: () => settingsDirectory,
    runner: () => (request) => { calls += 1; return fake.runner(request); },
    sandboxOn: () => sandbox,
    canChange: () => !busy,
    open: async (project) => { opened = project; return true; },
    current: () => (opened?.remote ? { project: opened, target: opened.remote } : null),
    changed: () => undefined,
  });
  const run = (input: RemoteProjectInput) => host.run(input);
  const typed = { destination: fake.target.destination, folder: fake.target.folder };
  try {
    assert.equal(host.enabled(), false);
    assert.equal((await run({ action: "read" })).view.enabled, false);
    for (const input of [{ action: "test", target: typed }, { action: "open", target: typed }, { action: "reconnect" }] as RemoteProjectInput[]) {
      const reply = await run(input);
      assert.equal(!reply.result?.ok && reply.result?.failure, "disabled");
    }
    assert.equal(calls, 0, "ssh was never started");
    assert.equal(opened, null);

    // Turning it on: refused while a task runs, remembered across the host.
    busy = true;
    assert.equal((await run({ action: "set-enabled", enabled: true })).result?.ok, false);
    busy = false;
    assert.equal((await run({ action: "set-enabled", enabled: true })).view.enabled, true);
    assert.equal(host.enabled(), true);
    assert.equal(readRemoteSettings(settingsDirectory).enabled, true);

    // A bad target is refused before ssh.
    const bad = await run({ action: "test", target: { destination: "-oProxyCommand=calc", folder: fake.target.folder } });
    assert.equal(!bad.result?.ok && bad.result?.failure, "invalid-target");
    assert.equal((await run({ action: "test", target: { ...typed, port: "70000" } })).result?.ok, false);
    assert.equal((await run({ action: "test", target: { ...typed, folder: "relative/path" } })).result?.ok, false);
    assert.equal(calls, 0);

    const tested = await run({ action: "test", target: typed });
    assert.equal(tested.result?.ok, true);
    assert.equal(opened, null, "a test opens nothing");
    assert.equal((await run({ action: "test", target: { ...typed, destination: "badauth" } })).result?.ok, false);

    // Open: the project is a shadow folder that knows its machine, and the folder is the machine's own real path.
    sandbox = true;
    const reply = await run({ action: "open", target: { ...typed, port: String(2222) } });
    assert.equal(reply.result?.ok, true, JSON.stringify(reply.result));
    assert.ok(opened);
    const project = opened as ProjectRoot;
    assert.equal(project.remote?.destination, "devbox");
    assert.equal(project.remote?.port, 2222);
    assert.equal(project.remote?.folder, (await new RemoteWorkspace(fake.target, fake.runner).connect()).root, "the folder is the one the machine itself names");
    assert.deepEqual(readRemoteSettings(settingsDirectory).recent.map((item) => item.destination), ["devbox"]);
    assert.deepEqual(reply.view.current, { label: "devbox:2222", folder: project.remote!.folder, state: "connected" });
    assert.equal(reply.view.sandboxOutside, true);
    assert.deepEqual(host.snapshot(), { label: "devbox:2222", folder: project.remote!.folder, state: "connected", sandboxOutside: true });

    // The open project goes away when a task is running; a lost connection is shown, and a reconnect brings it back.
    busy = true;
    assert.equal(!(await run({ action: "open", target: typed })).result?.ok, true);
    busy = false;
    host.markLost();
    assert.equal(host.snapshot()?.state, "lost");
    const reconnected = await run({ action: "reconnect" });
    assert.equal(reconnected.result?.ok, true);
    assert.equal(host.snapshot()?.state, "connected");
    fake.failNext("reset", 1);
    const failed = await run({ action: "reconnect" });
    assert.equal(failed.result?.ok, false);
    assert.equal(host.snapshot()?.state, "lost");
    // Turning it off keeps the record but stops everything.
    await run({ action: "set-enabled", enabled: false });
    assert.equal(host.enabled(), false);
    const callsBefore = calls;
    assert.equal(!(await run({ action: "reconnect" })).result?.ok, true);
    assert.equal(calls, callsBefore);
  } finally {
    setRemoteShadowBase(undefined);
  }
});

const projectFor = (fake: ReturnType<typeof makeFakeRemote>): ProjectRoot => ({ path: "/unused", identity: "1:1", remote: fake.target });

test("the runtime reaches a remote project only while the switch is on, and says which of the two went wrong", { skip }, async () => {
  const fake = makeFakeRemote();
  const settings = join(folder("run-settings"), "remote-projects");
  const fixtureEnv = { TOMVERSE_DESKTOP_REMOTE_SETTINGS: settings, TOMVERSE_DESKTOP_SSH_FIXTURE: JSON.stringify({ file: process.execPath, args: [new URL("../../tomverse-cli/tests/fake-ssh.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")] }) };
  await assert.rejects(openRemoteWorkspace(projectFor(fake), { env: fixtureEnv, fixtureAllowed: true }), (error) => error instanceof RemoteRunError && error.notice === "remoteDisabled");
  writeRemoteSettings(settings, { enabled: true, recent: [] });
  const remote = await openRemoteWorkspace(projectFor(fake), { env: fixtureEnv, fixtureAllowed: true });
  assert.equal(remote.state, "connected");
  assert.equal(remote.root, (await new RemoteWorkspace(fake.target, fake.runner).connect()).root);
  // A stand-in for ssh is honoured only where fixtures are allowed: otherwise the person's own ssh is used (here: none of that name on the machine).
  await assert.rejects(openRemoteWorkspace({ ...projectFor(fake), remote: { ...fake.target, destination: "badauth" } }, { env: fixtureEnv, fixtureAllowed: false, signal: AbortSignal.timeout(20_000) }));
  await assert.rejects(openRemoteWorkspace({ path: "/x", identity: "1:1" }, { env: fixtureEnv, fixtureAllowed: true }), (error) => error instanceof RemoteRunError && error.notice === "remoteUnavailable");
  // A project record whose target is not valid is refused here too.
  await assert.rejects(openRemoteWorkspace({ ...projectFor(fake), remote: { destination: "-oProxyCommand=x", folder: "/srv/app" } }, { env: fixtureEnv, fixtureAllowed: true }));
  rmSync(settings, { recursive: true, force: true });
});

test("a change of a remote task is shown from the remote file and put back there, and an unreachable machine offers nothing", { skip }, async () => {
  const fake = makeFakeRemote();
  const settings = join(folder("undo-settings"), "remote-projects");
  writeRemoteSettings(settings, { enabled: true, recent: [] });
  const fixtureEnv = { TOMVERSE_DESKTOP_REMOTE_SETTINGS: settings, TOMVERSE_DESKTOP_SSH_FIXTURE: JSON.stringify({ file: process.execPath, args: [new URL("../../tomverse-cli/tests/fake-ssh.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")] }) };
  const previous = { ...process.env };
  Object.assign(process.env, fixtureEnv);
  try {
    writeFileSync(join(fake.root, "a.txt"), "one\n");
    const ws = fake.workspace;
    await ws.connect();
    const [edit] = await ws.planPatch([{ path: "a.txt", action: "update", replacements: [{ old: "one", new: "two" }] }]);
    const journal = Journal.create(folder("journal"), {
      workspace: { root: folder("local-shadow") }, endpointOrigin: "http://127.0.0.1:1", keyPrefix: "tvk_abcdefgh",
      readOnly: false, model: { requested: "m", pinned: "m", pinnedFrom: "user", contextWindowTokens: 1000, maxOutputTokens: 100 },
      limits: { maxRequests: 5, timeoutMs: 60_000, commandTimeoutMs: 60_000 },
    });
    const before = readFileSync(join(fake.root, "a.txt"));
    const written = await ws.writeFile(edit!);
    const { sha256 } = await import("../../tomverse-cli/src/session.js");
    journal.state.changes.push({
      changeId: "c1", toolCallId: "t1", path: "a.txt", kind: "update",
      preimage: { sha256: edit!.preimage, backup: journal.saveBackup("c1", before), identity: edit!.binding.file },
      postimage: { sha256: edit!.postimage, backup: journal.saveBackup("c1", edit!.afterBytes!, "post"), identity: written.ident },
      directory: written.folderIdent, state: "applied", appliedAt: new Date().toISOString(),
    });
    journal.commit();
    assert.equal(sha256(readFileSync(join(fake.root, "a.txt"))), edit!.postimage);
    const project = projectFor(fake);
    const shown = await inspectRemoteChange(journal, "c1", project, { clean: (text) => text, unknown: false, fixtureAllowed: true });
    assert.equal(shown?.current, "as_written");
    assert.equal(shown?.canUndo, true);
    assert.match(shown?.text ?? "", /two/);
    assert.equal(await inspectRemoteChange(journal, "nope", project, { clean: (text) => text, unknown: false, fixtureAllowed: true }), null);
    // Somebody changes the file: it is shown as changed and cannot be put back.
    writeFileSync(join(fake.root, "a.txt"), "someone else\n");
    fake.sh("mv a.txt b.txt && cp b.txt a.txt");
    const changed = await inspectRemoteChange(journal, "c1", project, { clean: (text) => text, unknown: false, fixtureAllowed: true });
    assert.equal(changed?.current, "changed_since");
    assert.equal(changed?.canUndo, false);
    assert.equal(await undoRemoteChange(journal, "c1", project, { fixtureAllowed: true }), "conflict");
    assert.equal(readFileSync(join(fake.root, "a.txt"), "utf8"), "someone else\n");
    // Back as written: the undo restores the earlier text on the remote machine.
    writeFileSync(join(fake.root, "a.txt"), edit!.afterBytes!);
    fake.sh("mv a.txt c.txt && cp c.txt a.txt && rm c.txt b.txt");
    const second = journal.state.changes[0]!;
    second.postimage.identity = (await ws.resolve("a.txt", "read")).ident;
    journal.commit();
    assert.equal(await undoRemoteChange(journal, "c1", project, { fixtureAllowed: true }), "undone");
    assert.equal(readFileSync(join(fake.root, "a.txt"), "utf8"), "one\n");
    assert.equal(journal.state.changes[0]!.state, "undone");
    // The machine cannot be reached: nothing about the file is claimed and no undo is offered.
    const unreachable = { ...project, remote: { ...fake.target, destination: "refused" } };
    const gone = await inspectRemoteChange(journal, "c1", unreachable, { clean: (text) => text, unknown: false, fixtureAllowed: true });
    assert.equal(gone?.canUndo, false);
    assert.equal(await undoRemoteChange(journal, "c1", unreachable, { fixtureAllowed: true }), "unavailable");
    journal.release();
  } finally {
    for (const key of Object.keys(fixtureEnv)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
