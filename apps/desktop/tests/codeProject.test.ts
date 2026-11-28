import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { Journal } from "../../tomverse-cli/src/session.js";
import {
  buildEnvironmentGroups, codeProjectInput, parseWslList, pickerOrder, sortCodeProjects,
  type CodeProject, type EnvironmentInput,
} from "../src/code-project-contract";
import { createCodeProjectHost, type CodeProjectHostDeps } from "../src/host/code-project-host";
import {
  addProject, canonicalProjectFolder, codeProjectFile, createProjectFolder, emptyCodeProjectFile, foldersFromHistory, newFolderIn,
  readCodeProjects, validFolderName, writeCodeProjects,
} from "../src/host/code-project-store";
import { codeHistoryScope } from "../src/host/history-scope";
import { bindProjectRoot } from "../src/host/project-root";

const folder = (prefix: string) => realpathSync.native(mkdtempSync(join(tmpdir(), `tvdesk-${prefix}-`)));
const project = (name: string, extra: Partial<CodeProject> = {}): CodeProject => ({
  id: crypto.randomUUID(), name, folder: join(tmpdir(), name), favorite: false, createdAt: 1, lastUsedAt: null,
  defaultLocation: "local", permissionMode: null, worktree: null, ...extra,
});
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("the register is one file per account, and a damaged or hand-edited file keeps only what still reads as a project", () => {
  const profile = folder("register");
  const a = codeProjectFile(profile, "account-a");
  assert.notEqual(a, codeProjectFile(profile, "account-b"));
  assert.notEqual(a, codeProjectFile(profile, null));
  assert.deepEqual(readCodeProjects(a), emptyCodeProjectFile());

  const root = folder("project");
  const data = emptyCodeProjectFile();
  const added = addProject(data, { folder: root }, 5, crypto.randomUUID());
  assert.ok(added.ok && added.created);
  writeCodeProjects(a, data);
  assert.deepEqual(readCodeProjects(a).projects.map(({ folder: path, name }) => [path, name]), [[root, basename(root)]]);

  writeFileSync(a, JSON.stringify({ migratedHistory: true, projects: [
    { id: crypto.randomUUID(), name: "relative", folder: "not/absolute" },
    { id: "not-an-id", name: "bad id", folder: root },
    { id: crypto.randomUUID(), name: "", folder: root },
    { id: crypto.randomUUID(), name: "ok", folder: root, defaultLocation: "mars", permissionMode: "allow_all", worktree: "yes", favorite: true },
    { id: crypto.randomUUID(), name: "same folder again", folder: root },
  ] }));
  const read = readCodeProjects(a);
  assert.equal(read.migratedHistory, true);
  assert.equal(read.projects.length, 1);
  // Unknown values fall back, and Allow all is never read back as a remembered mode.
  assert.deepEqual([read.projects[0]!.defaultLocation, read.projects[0]!.permissionMode, read.projects[0]!.worktree, read.projects[0]!.favorite], ["local", null, null, true]);
  writeFileSync(a, "{ not json");
  assert.deepEqual(readCodeProjects(a), emptyCodeProjectFile());
});

test("a project folder must be an existing absolute folder of this computer, and the same folder is one project", () => {
  const root = folder("canonical");
  assert.deepEqual(canonicalProjectFolder(root), { ok: true, folder: root });
  assert.deepEqual(canonicalProjectFolder("relative/path"), { ok: false, failure: "bad-folder" });
  assert.deepEqual(canonicalProjectFolder(""), { ok: false, failure: "bad-folder" });
  assert.deepEqual(canonicalProjectFolder(join(root, "missing")), { ok: false, failure: "missing-folder" });
  const file = join(root, "file.txt");
  writeFileSync(file, "x");
  assert.equal(canonicalProjectFolder(file).ok, false);
  if (process.platform === "win32") assert.deepEqual(canonicalProjectFolder("\\\\server\\share\\project"), { ok: false, failure: "bad-folder" });

  const data = emptyCodeProjectFile();
  const first = addProject(data, { folder: root }, 1, crypto.randomUUID());
  const again = addProject(data, { folder: root }, 2, crypto.randomUUID());
  assert.ok(first.ok && again.ok);
  assert.equal(again.project.id, first.project.id);
  assert.equal(again.created, false);
  assert.equal(data.projects.length, 1);
});

test("a new folder is one plain name made directly inside the folder the person picked", async () => {
  for (const bad of ["", " a", "a ", "a.", "..", ".", "a/b", "a\\b", "con", "NUL.txt", "a:b", "a*b", "a\u0000b", "x".repeat(81)]) {
    assert.equal(validFolderName(bad), false, JSON.stringify(bad));
  }
  for (const good of ["app", "my project", "프로젝트", "a.b", ".hidden"]) assert.equal(validFolderName(good), true, good);

  const parent = folder("parent");
  assert.deepEqual(newFolderIn(parent, "../escape"), { ok: false, failure: "invalid-name" });
  assert.deepEqual(newFolderIn(parent, "nested/child"), { ok: false, failure: "invalid-name" });
  assert.deepEqual(newFolderIn(join(parent, "missing"), "app"), { ok: false, failure: "missing-folder" });
  assert.deepEqual(newFolderIn(parent, "app"), { ok: true, folder: join(parent, "app") });

  const made = await createProjectFolder(parent, "plain", false);
  assert.deepEqual(made, { ok: true, folder: join(parent, "plain") });
  assert.equal(existsSync(join(parent, "plain")), true);
  assert.equal(existsSync(join(parent, "plain", ".git")), false);
  assert.deepEqual(await createProjectFolder(parent, "plain", false), { ok: false, failure: "exists" });
  assert.equal(existsSync(join(parent, "escape")), false);
});

test("git init runs only when asked, in the new folder", { skip: !hasGit && "needs git" }, async () => {
  const parent = folder("git-parent");
  const made = await createProjectFolder(parent, "repo", true);
  assert.ok(made.ok);
  assert.equal(made.gitInit, "done");
  assert.equal(existsSync(join(parent, "repo", ".git")), true);
});

test("history folders of this account's own namespace become projects, and another account's or a worktree's do not", () => {
  const profile = folder("history-profile");
  const root = folder("history-root");
  const gone = folder("history-gone");
  const connection = { endpoint: "http://127.0.0.1:1/api/code/v1", key: "tvk_abcdefgh_" + "A".repeat(43) };
  const homeFor = (accountId: string | null, path: string) => codeHistoryScope(profile, accountId, bindProjectRoot(path), connection);
  const save = (home: string, path: string) => Journal.create(home, {
    workspace: { root: path }, endpointOrigin: "http://127.0.0.1:1", keyPrefix: "tvk_abcdefgh", readOnly: false,
    model: { requested: "m", pinned: "m", pinnedFrom: "user", contextWindowTokens: 1000, maxOutputTokens: 100 },
    limits: { maxRequests: 5, timeoutMs: 60_000, commandTimeoutMs: 60_000 },
  });
  save(homeFor("mine", root).home, root);
  save(homeFor("someone-else", gone).home, gone);
  // A session in a namespace that is not the hash of its folder (a worktree's journal, a renamed folder) is not a project.
  mkdirSync(join(profile, "code", "0".repeat(64)), { recursive: true });
  save(join(profile, "code", "0".repeat(64)), root);

  const scopes = (accountId: string | null) => (path: string) => { const scope = homeFor(accountId, path); return [scope.home, scope.legacyHome]; };
  assert.deepEqual(foldersFromHistory(profile, scopes("mine")), [root]);
  assert.deepEqual(foldersFromHistory(profile, scopes("someone-else")), [gone]);
  assert.deepEqual(foldersFromHistory(profile, scopes("nobody")), []);
});

test("favourites sort first, then the most recently used, then by name", () => {
  const list = [
    project("zeta", { lastUsedAt: 30 }), project("alpha", { lastUsedAt: null }), project("beta", { lastUsedAt: 10, favorite: true }),
    project("gamma", { lastUsedAt: 50, favorite: true }), project("delta", { lastUsedAt: 30 }), project("Epsilon", { lastUsedAt: null }),
  ];
  assert.deepEqual(sortCodeProjects(list).map(({ name }) => name), ["gamma", "beta", "delta", "zeta", "alpha", "Epsilon"]);
  assert.deepEqual(list.map(({ name }) => name).slice(0, 2), ["zeta", "alpha"], "the input is not reordered");
});

const names = { cloudAuto: "Auto", cloudDefault: "Default", local: "Local", cloud: "Cloud", wsl: "WSL", ssh: "SSH" };
const base = (extra: Partial<EnvironmentInput> = {}): EnvironmentInput => ({
  platform: "linux", projects: [], selectedId: null, query: "", cloudOffered: true, selectedIsGit: true, remoteOpen: false, wsl: null,
  remoteEnabled: false, remoteRecent: [], names, ...extra,
});

test("the picker groups Local projects, Cloud, WSL and SSH, and says why a row cannot be used", () => {
  const a = project("alpha");
  const b = project("beta", { favorite: true });
  const groups = buildEnvironmentGroups(base({ projects: [a, b], selectedId: a.id }));
  assert.deepEqual(groups.local.map((row) => [row.project.name, row.selected]), [["beta", false], ["alpha", true]]);
  assert.deepEqual(groups.cloud.map((row) => [row.id, row.disabled]), [["auto", undefined], ["default", undefined]]);
  assert.equal(groups.wsl, null, "WSL is a Windows-only group");
  assert.deepEqual(groups.ssh, []);

  const reasons = (input: Partial<EnvironmentInput>) => buildEnvironmentGroups(base({ projects: [a], ...input })).cloud.map((row) => row.disabled);
  assert.deepEqual(reasons({ selectedId: a.id, cloudOffered: false }), ["cloud-not-offered", "cloud-not-offered"]);
  assert.deepEqual(reasons({ selectedId: null }), ["cloud-no-project", "cloud-no-project"]);
  assert.deepEqual(reasons({ selectedId: a.id, selectedIsGit: false }), ["cloud-not-git", "cloud-not-git"]);
  assert.deepEqual(reasons({ selectedId: a.id, selectedIsGit: null }), [undefined, undefined], "not yet known is not a refusal");
  assert.deepEqual(reasons({ selectedId: a.id, remoteOpen: true }), ["cloud-remote-project", "cloud-remote-project"]);
  // The server's switch comes first: a person on an account without Cloud is told that, not that the project is not a repository.
  assert.deepEqual(reasons({ selectedId: a.id, cloudOffered: false, selectedIsGit: false }), ["cloud-not-offered", "cloud-not-offered"]);
});

test("WSL rows exist only on Windows and stay off because Code does not run inside a distribution", () => {
  const ready = buildEnvironmentGroups(base({ platform: "win32", wsl: { state: "ready", distributions: ["Ubuntu", "Debian"] } }));
  assert.deepEqual(ready.wsl?.rows.map((row) => [row.id, row.disabled]), [["Ubuntu", "wsl-no-support"], ["Debian", "wsl-no-support"]]);
  assert.equal(ready.wsl?.disabled, "wsl-no-support");
  const missing = buildEnvironmentGroups(base({ platform: "win32", wsl: { state: "unavailable" } }));
  assert.deepEqual(missing.wsl, { disabled: "wsl-unavailable", rows: [] });
  assert.equal(buildEnvironmentGroups(base({ platform: "darwin", wsl: { state: "ready", distributions: ["Ubuntu"] } })).wsl, null);
  // Nothing in the WSL group can be reached by the keyboard.
  assert.deepEqual(pickerOrder(ready).filter((row) => row.kind === "wsl"), []);
});

test("SSH rows are the recent remote projects, only while remote projects are on, and search filters every group", () => {
  const recent = [{ destination: "me@devbox", folder: "/srv/app" }, { destination: "ci@runner", port: 2222, folder: "/work" }];
  assert.deepEqual(buildEnvironmentGroups(base({ remoteRecent: recent })).ssh, []);
  const on = buildEnvironmentGroups(base({ remoteEnabled: true, remoteRecent: recent }));
  assert.deepEqual(on.ssh.map((row) => [row.label, row.port, row.folder]), [["me@devbox", undefined, "/srv/app"], ["ci@runner", 2222, "/work"]]);

  const a = project("billing-api", { folder: join(tmpdir(), "x1") });
  const b = project("website", { folder: join(tmpdir(), "x2") });
  const filtered = buildEnvironmentGroups(base({ projects: [a, b], remoteEnabled: true, remoteRecent: recent, query: "  BILL " }));
  assert.deepEqual(filtered.local.map((row) => row.project.name), ["billing-api"]);
  assert.deepEqual(filtered.ssh, []);
  assert.deepEqual(filtered.cloud, [], "'bill' matches neither Cloud row");
  assert.deepEqual(buildEnvironmentGroups(base({ remoteEnabled: true, remoteRecent: recent, query: "runner" })).ssh.map((row) => row.destination), ["ci@runner"]);
  assert.deepEqual(buildEnvironmentGroups(base({ query: "cloud" })).cloud.length, 2, "the group title is searched too");
  assert.deepEqual(buildEnvironmentGroups(base({ projects: [a], query: "x1" })).local.length, 1, "the folder is searched too");
});

test("the keyboard walks Local, Cloud and SSH in order and skips rows that are switched off", () => {
  const a = project("alpha");
  const on = pickerOrder(buildEnvironmentGroups(base({ projects: [a], selectedId: a.id, remoteEnabled: true, remoteRecent: [{ destination: "me@box", folder: "/x" }] })));
  assert.deepEqual(on.map((row) => row.kind), ["project", "cloud", "cloud", "ssh"]);
  const off = pickerOrder(buildEnvironmentGroups(base({ projects: [a], selectedId: a.id, selectedIsGit: false })));
  assert.deepEqual(off.map((row) => row.kind), ["project"]);
});

test("WSL list output is read from UTF-16 with or without the byte-order mark, and from plain text", () => {
  const utf16 = (text: string, bom: boolean) => {
    const body = Buffer.from(text, "utf16le");
    return new Uint8Array(bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body);
  };
  assert.deepEqual(parseWslList(utf16("Ubuntu\r\nDebian\r\n\r\n", true)), ["Ubuntu", "Debian"]);
  assert.deepEqual(parseWslList(utf16("Ubuntu-22.04\r\ndocker-desktop\r\n", false)), ["Ubuntu-22.04", "docker-desktop"]);
  assert.deepEqual(parseWslList(new TextEncoder().encode("Ubuntu\nDebian\nUbuntu\n")), ["Ubuntu", "Debian"]);
  assert.deepEqual(parseWslList(utf16("", true)), []);
  assert.deepEqual(parseWslList("A\u0000B\r\n"), ["AB"]);
  assert.equal(parseWslList(Array.from({ length: 40 }, (_, index) => `d${index}`).join("\n")).length, 20);
});

test("the project IPC refuses anything that is not a typed action with a project id", () => {
  assert.equal(codeProjectInput.safeParse({ action: "add-existing" }).success, true);
  assert.equal(codeProjectInput.safeParse({ action: "add-existing", folder: "C:\\x" }).success, false, "no path comes from the window");
  assert.equal(codeProjectInput.safeParse({ action: "select", id: "../x" }).success, false);
  assert.equal(codeProjectInput.safeParse({ action: "create-new", name: " ", initGit: true }).success, false);
  assert.equal(codeProjectInput.safeParse({ action: "create-new", name: "app", initGit: "yes" }).success, false);
  assert.equal(codeProjectInput.safeParse({ action: "set-location", id: crypto.randomUUID(), location: "ssh" }).success, true);
  assert.equal(codeProjectInput.safeParse({ action: "set-location", id: crypto.randomUUID(), location: "wsl" }).success, false);
});

function hostWith(extra: Partial<CodeProjectHostDeps> = {}) {
  const profile = folder("host-profile");
  const file = codeProjectFile(profile, "account");
  let current: string | null = null;
  let permission: "read_only" | "ask" | "auto_review" | "allow_all" = "ask";
  const picks: string[] = [];
  const opened: string[] = [];
  let clock = 100;
  const deps: CodeProjectHostDeps = {
    file: () => file, now: () => ++clock, newId: () => crypto.randomUUID(), canChange: () => true,
    pickFolder: async () => picks.shift() ?? null,
    open: async (path) => { opened.push(path); current = path; },
    current: () => current, permission: () => permission, setPermission: (mode) => { permission = mode; },
    historyFolders: () => [], wslList: async () => null, platform: "linux", changed: () => undefined, ...extra,
  };
  return { host: createCodeProjectHost(deps), file, picks, opened, permission: () => permission, setPermission: (mode: typeof permission) => { permission = mode; },
    current: () => current, setCurrent: (path: string | null) => { current = path; } };
}

test("adding an existing folder registers it once, opens it, and a folder that is already listed is only opened", async () => {
  const t = hostWith();
  const root = folder("add");
  t.picks.push(root, root);
  const first = await t.host.run({ action: "add-existing" });
  assert.ok(first.result.ok);
  assert.equal(first.result.changed, true);
  const view = t.host.view();
  assert.deepEqual(view.items.map((item) => item.name), [basename(root)]);
  assert.equal(view.selectedId, view.items[0]!.id);
  assert.equal(view.items[0]!.lastUsedAt !== null, true);
  const second = await t.host.run({ action: "add-existing" });
  assert.ok(second.result.ok);
  assert.equal(second.result.changed, false, "the same project again keeps what hangs on it");
  assert.deepEqual(t.opened, [root], "and the open project is not opened a second time");
  assert.equal(t.host.view().items.length, 1);
  // The mode in force stays when the open project is chosen again.
  t.setPermission("allow_all");
  t.picks.push(root);
  assert.ok((await t.host.run({ action: "add-existing" })).result.ok);
  assert.equal(t.permission(), "allow_all");
  t.setPermission("ask");
  assert.deepEqual(await t.host.run({ action: "add-existing" }), { result: { ok: false, failure: "cancelled" } });
  t.picks.push(join(root, "missing"));
  assert.deepEqual((await t.host.run({ action: "add-existing" })).result, { ok: false, failure: "missing-folder" });
});

test("a new project is created inside the picked parent only, with the name as the folder name", async () => {
  const t = hostWith();
  const parent = folder("new-parent");
  t.picks.push(parent);
  const reply = await t.host.run({ action: "create-new", name: "fresh", initGit: false });
  assert.ok(reply.result.ok);
  assert.equal(existsSync(join(parent, "fresh")), true);
  assert.equal(t.current(), join(parent, "fresh"));
  assert.equal(t.host.view().items[0]!.name, "fresh");
  t.picks.push(parent);
  assert.deepEqual((await t.host.run({ action: "create-new", name: "fresh", initGit: false })).result, { ok: false, failure: "exists" });
  assert.equal(t.host.view().items.length, 1);
  assert.deepEqual((await t.host.run({ action: "create-new", name: "a/b", initGit: false })).result, { ok: false, failure: "invalid-name" });
  assert.equal(existsSync(join(parent, "a")), false);
  // The dialog is closed without a choice: nothing is made.
  assert.deepEqual((await t.host.run({ action: "create-new", name: "later", initGit: false })).result, { ok: false, failure: "cancelled" });
  assert.equal(existsSync(join(parent, "later")), false);
});

test("rename, favourite, default location and the Worktree choice are saved, and removing a project leaves its folder alone", async () => {
  const t = hostWith();
  const root = folder("edit");
  writeFileSync(join(root, "keep.txt"), "mine");
  t.picks.push(root);
  const added = await t.host.run({ action: "add-existing" });
  assert.ok(added.result.ok && added.result.id);
  const id = added.result.id!;
  assert.ok((await t.host.run({ action: "rename", id, name: "Billing" })).result.ok);
  assert.ok((await t.host.run({ action: "favorite", id, favorite: true })).result.ok);
  assert.ok((await t.host.run({ action: "set-location", id, location: "local" })).result.ok);
  assert.deepEqual((await t.host.run({ action: "set-location", id, location: "cloud" })).result, { ok: false, failure: "failed" }, "a default that cannot be applied is not saved");
  assert.ok((await t.host.run({ action: "set-worktree", id, worktree: false })).result.ok);
  const saved = readCodeProjects(t.file).projects[0]!;
  assert.deepEqual([saved.name, saved.favorite, saved.defaultLocation, saved.worktree], ["Billing", true, "local", false]);

  assert.deepEqual((await t.host.run({ action: "rename", id: crypto.randomUUID(), name: "x" })).result, { ok: false, failure: "not-found" });
  assert.ok((await t.host.run({ action: "remove", id })).result.ok);
  assert.deepEqual(readCodeProjects(t.file).projects, []);
  assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "mine");
});

test("a project whose folder moved can be pointed at its new folder, but not at another project's folder", async () => {
  const t = hostWith();
  const one = folder("one");
  const two = folder("two");
  const moved = folder("moved");
  t.picks.push(one, two);
  const first = await t.host.run({ action: "add-existing" });
  const second = await t.host.run({ action: "add-existing" });
  assert.ok(first.result.ok && second.result.ok);
  t.picks.push(two);
  assert.deepEqual((await t.host.run({ action: "relocate", id: first.result.ok ? first.result.id! : "" })).result, { ok: false, failure: "exists" });
  t.picks.push(moved);
  assert.ok((await t.host.run({ action: "relocate", id: first.result.ok ? first.result.id! : "" })).result.ok);
  assert.ok(readCodeProjects(t.file).projects.some((item) => item.folder === moved));
});

test("choosing a project is refused while a task runs, and a folder that vanished says so", async () => {
  let running = false;
  const t = hostWith({ canChange: () => !running });
  const root = folder("busy");
  t.picks.push(root);
  const added = await t.host.run({ action: "add-existing" });
  assert.ok(added.result.ok);
  const id = added.result.ok ? added.result.id! : "";
  running = true;
  assert.deepEqual((await t.host.run({ action: "select", id })).result, { ok: false, failure: "busy" });
  assert.deepEqual((await t.host.run({ action: "add-existing" })).result, { ok: false, failure: "busy" });
  running = false;
  const data = readCodeProjects(t.file);
  data.projects[0]!.folder = join(root, "gone");
  writeCodeProjects(t.file, data);
  const gone = hostWith({ file: () => t.file, canChange: () => true });
  assert.deepEqual((await gone.host.run({ action: "select", id })).result, { ok: false, failure: "missing-folder" });
});

test("a project remembers the permission mode last picked in it, and a conversation there starts with it", async () => {
  const t = hostWith();
  const a = folder("perm-a");
  const b = folder("perm-b");
  t.picks.push(a, b);
  const first = await t.host.run({ action: "add-existing" });
  const second = await t.host.run({ action: "add-existing" });
  assert.ok(first.result.ok && second.result.ok);
  const idA = first.result.ok ? first.result.id! : "";
  const idB = second.result.ok ? second.result.id! : "";

  // In project B (open now) the person picks Read only; Allow all would be remembered as Ask.
  t.host.rememberPermission("read_only");
  assert.equal(readCodeProjects(t.file).projects.find((item) => item.id === idB)!.permissionMode, "read_only");
  t.host.rememberPermission("allow_all");
  assert.equal(readCodeProjects(t.file).projects.find((item) => item.id === idB)!.permissionMode, "ask");
  t.host.rememberPermission("read_only");

  // Project A has none yet: it keeps the mode in force, except that Allow all never follows to another project.
  t.setPermission("auto_review");
  assert.ok((await t.host.run({ action: "select", id: idA })).result.ok);
  assert.equal(t.permission(), "auto_review");
  t.setPermission("allow_all");
  assert.ok((await t.host.run({ action: "select", id: idB })).result.ok);
  assert.equal(t.permission(), "read_only", "B's own mode wins");
  assert.ok((await t.host.run({ action: "select", id: idA })).result.ok);
  assert.equal(t.permission(), "read_only", "A took the mode from the last pick, which was read only");
  t.setPermission("allow_all");
  t.host.rememberPermission("allow_all");
  const c = folder("perm-c");
  t.picks.push(c);
  assert.ok((await t.host.run({ action: "add-existing" })).result.ok);
  assert.equal(t.permission(), "ask", "Allow all is switched back to Ask in a project that has no mode of its own");
});

test("the folders of earlier history move into the register once", async () => {
  const history = [folder("history-a"), folder("history-b")];
  let calls = 0;
  const t = hostWith({ historyFolders: () => { calls += 1; return history; } });
  assert.deepEqual(t.host.view().items.map((item) => item.folder).sort(), [...history].sort());
  t.host.view();
  assert.equal(calls, 1);
  await t.host.run({ action: "remove", id: t.host.view().items[0]!.id });
  assert.equal(t.host.view().items.length, 1, "a removed project does not come back");
  // Before the account can be read nothing is moved and nothing is marked as moved.
  const waiting = hostWith({ historyFolders: () => null });
  assert.deepEqual(waiting.host.view().items, []);
  assert.equal(readCodeProjects(waiting.file).migratedHistory, false);
});

test("WSL distributions are read only on Windows", async () => {
  const encode = (text: string) => new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
  const windows = hostWith({ platform: "win32", wslList: async () => encode("Ubuntu\r\nDebian\r\n") });
  assert.deepEqual((await windows.host.run({ action: "wsl" })).wsl, { state: "ready", distributions: ["Ubuntu", "Debian"] });
  const missing = hostWith({ platform: "win32", wslList: async () => null });
  assert.deepEqual((await missing.host.run({ action: "wsl" })).wsl, { state: "unavailable" });
  const linux = hostWith({ wslList: async () => { throw new Error("must not run"); } });
  assert.deepEqual((await linux.host.run({ action: "wsl" })).wsl, { state: "unsupported" });
});
