import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { PatchError } from "../src/patch.js";
import { createSshRunner } from "../src/remote-ssh.js";
import { RemoteError } from "../src/remote-target.js";
import { planRemoteCommand, RemoteWorkspace } from "../src/remote-workspace.js";
import { PathError } from "../src/workspace.js";
import { dashShim, HAS_SH, makeFakeRemote, remotePath } from "./remote-fixture.js";

const skip = !HAS_SH && "needs a POSIX sh (Git for Windows has one)";

const remoteError = (code: string) => (error: unknown) => error instanceof RemoteError && error.code === code;

const connected = async (options: Parameters<typeof makeFakeRemote>[0] = {}) => {
    const remote = makeFakeRemote(options);
    await remote.workspace.connect();
    return remote;
};

test("connect finds the real folder on the remote machine and every ssh call is made with BatchMode and the target as its own argument", { skip }, async () => {
    const remote = makeFakeRemote({ destination: "me@devbox", port: 2222 });
    const probe = await remote.workspace.connect();
    assert.equal(probe.root, remote.target.folder);
    assert.ok(probe.home.startsWith("/"));
    assert.equal(remote.workspace.state, "connected");
    assert.equal(remote.workspace.label, "me@devbox:2222");
    for (const call of remote.calls()) {
        assert.equal(call.destination, "me@devbox");
        assert.ok(call.options.some(([flag, value]) => flag === "-o" && value === "BatchMode=yes"));
        assert.deepEqual(call.options.find(([flag]) => flag === "-p"), ["-p", "2222"]);
        assert.match(call.command, /^sh -c '/);
    }
});

test("connect says what is wrong in words the person can act on", { skip }, async () => {
    const cases: Array<[string, string, RegExp]> = [
        ["badauth", "auth", /terminal[\s\S]*never asks/],
        ["newhost", "host-key", /never accepts an unknown host/],
        ["changedhost", "host-key-changed", /intercepting/],
        ["nohost", "name-not-found", /could not be found/],
        ["refused", "unreachable", /cannot be reached/],
    ];
    for (const [destination, code, message] of cases) {
        const remote = makeFakeRemote({ destination });
        await assert.rejects(remote.workspace.connect(), (error) => remoteError(code)(error) && message.test((error as Error).message), destination);
        assert.equal(remote.workspace.state, "idle", "a failed connect leaves nothing half connected");
    }
    const slow = makeFakeRemote({ destination: "slow", timeouts: { connectMs: 600 } });
    await assert.rejects(slow.workspace.connect(), remoteError("timeout"));
    const missingSsh = new RemoteWorkspace({ destination: "devbox", folder: "/srv/app" }, createSshRunner({ file: "definitely-not-an-ssh-program-tomverse" }));
    await assert.rejects(missingSsh.connect(), remoteError("ssh-missing"));
});

test("connect refuses a folder that is missing, is a file, is the home folder, is the root or sits in a credential folder", { skip }, async () => {
    const remote = makeFakeRemote();
    writeFileSync(join(remote.root, "a-file"), "x");
    const at = (folder: string) => new RemoteWorkspace({ destination: "devbox", folder }, remote.runner);
    await assert.rejects(at(`${remote.target.folder}/nope`).connect(), remoteError("folder-missing"));
    await assert.rejects(at(`${remote.target.folder}/a-file`).connect(), remoteError("not-a-folder"));
    const home = remote.sh("cd \"$HOME\" && pwd -P").trim();
    await assert.rejects(at(home).connect(), remoteError("folder-too-broad"));
    mkdirSync(join(remote.root, ".ssh"));
    // A name that goes through a credential folder is refused when the target is parsed; a link into one is refused by the real path.
    remote.sh("mkdir -p inner && ln -s ../.ssh inner/keys");
    await assert.rejects(at(`${remote.target.folder}/inner/keys`).connect(), remoteError("folder-too-broad"));
});

test("a path is resolved on the remote machine: inside is fine, outside and links out are refused, links in are read but never written", { skip }, async () => {
    const remote = await connected();
    const { workspace: ws } = remote;
    mkdirSync(join(remote.root, "src"));
    writeFileSync(join(remote.root, "src", "a.txt"), "hello\n");
    const outside = join(remote.base, "..", `outside-${Date.now()}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "top secret\n");
    remote.sh(`ln -s "${remotePath(outside)}" out-link && ln -s src/a.txt in-link && ln -s ../../ src/up-link`);

    const ok = await ws.resolve("src/a.txt", "read");
    assert.equal(ok.relative, "src/a.txt");
    assert.equal(ok.exists, true);
    assert.equal(ok.kind, "file");
    assert.match(ok.ident ?? "", /^\d+:\d+:\d+$/);

    for (const bad of ["../x", "src/../../x", "/etc/passwd", `${remote.target.folder}/../x`]) {
        await assert.rejects(ws.resolve(bad, "read"), (error) => error instanceof PathError && /outside the workspace/.test(error.message), bad);
    }
    await assert.rejects(ws.resolve("out-link/secret.txt", "read"), (error) => error instanceof PathError && /through a link/.test(error.message));
    await assert.rejects(ws.resolve("out-link", "read"), PathError);
    await assert.rejects(ws.resolve("src/up-link/x", "read"), PathError);
    // A link that stays inside reads as the file it points to, and a write through it is refused.
    const through = await ws.resolve("in-link", "read");
    assert.equal(through.relative, "src/a.txt");
    assert.equal(through.linked, true);
    await assert.rejects(ws.resolve("in-link", "write"), (error) => error instanceof PathError && /is a link/.test(error.message));
    // A path that does not exist yet resolves to where it would be, bound to the nearest folder around it.
    const fresh = await ws.resolve("src/deep/er/new.txt", "write");
    assert.equal(fresh.exists, false);
    assert.equal(fresh.kind, "none");
    assert.equal(fresh.folder, `${ws.root}/src`);
    // What cannot be a path.
    await assert.rejects(ws.resolve("", "read"), PathError);
    await assert.rejects(ws.resolve("a\nb", "read"), PathError);
    await assert.rejects(ws.resolve("a\0b", "read"), PathError);
    await assert.rejects(ws.resolve("src\\a.txt", "read"), (error) => error instanceof PathError && /Use \//.test(error.message));
});

test("credential files are never read or changed in a remote project, by their own name or by a link with an ordinary one", { skip }, async () => {
    const remote = await connected();
    const { workspace: ws } = remote;
    for (const name of [".env", ".env.local", "id_rsa", "deploy.pem", "credentials.json", "secrets.yaml", ".npmrc", ".netrc"]) {
        writeFileSync(join(remote.root, name), "TOKEN=abc\n");
        await assert.rejects(ws.resolve(name, "read"), (error) => error instanceof PathError && /credentials/.test(error.message), name);
        await assert.rejects(ws.resolve(name, "write"), PathError, name);
    }
    mkdirSync(join(remote.root, ".git"));
    writeFileSync(join(remote.root, ".git", "config"), "[remote]\n");
    await assert.rejects(ws.resolve(".git/config", "read"), PathError);
    mkdirSync(join(remote.root, ".aws"));
    await assert.rejects(ws.resolve(".aws/credentials", "write"), PathError);
    // The real name decides: an ordinary name that points to .env is the credential file.
    remote.sh("ln -s .env harmless.txt");
    await assert.rejects(ws.resolve("harmless.txt", "read"), (error) => error instanceof PathError && /credentials/.test(error.message));
    // A new file with a credential name is refused too.
    await assert.rejects(ws.resolve("config/.env.production", "write"), PathError);
    // Listing and search leave them out.
    writeFileSync(join(remote.root, "plain.txt"), "TOKEN=abc\n");
    const listed = await ws.listFiles(".", 100);
    assert.deepEqual(listed.files, ["plain.txt"]);
    const found = await ws.searchText({ pattern: "TOKEN", maxResults: 50 });
    assert.deepEqual(found.matches, ["plain.txt:1:TOKEN=abc"]);
});

test("files are read whole, with the identity they have, and a file too large is refused", { skip }, async () => {
    const remote = await connected();
    const { workspace: ws } = remote;
    const bytes = Buffer.concat([Buffer.from("héllo\r\n"), Buffer.from([0, 1, 2, 255, 10]), Buffer.from("tail")]);
    writeFileSync(join(remote.root, "b.bin"), bytes);
    writeFileSync(join(remote.root, "empty.txt"), "");
    const resolved = await ws.resolve("b.bin", "read");
    const read = await ws.readFile(resolved.absolute);
    assert.ok(read.bytes.equals(bytes), "binary and non-ASCII bytes arrive exactly");
    assert.equal(read.ident, resolved.ident);
    assert.equal((await ws.readFile((await ws.resolve("empty.txt", "read")).absolute)).bytes.length, 0);
    await assert.rejects(ws.readFile(resolved.absolute, 4), (error) => error instanceof PathError && /too large/.test(error.message));
    await assert.rejects(ws.readFile(`${ws.root}/missing.txt`), remoteError("not-found"));
    await assert.rejects(ws.readFile(`${ws.root}/../x`), remoteError("outside-root"));
    writeFileSync(join(remote.base, "..", `side-${Date.now()}.txt`), "x");
});

test("listing skips generated folders, search finds text on the machine, and both report what was cut", { skip }, async () => {
    const remote = await connected();
    const { workspace: ws } = remote;
    for (const [path, text] of [["src/a.ts", "const needle = 1;\nconst Other = 2;\n"], ["src/b.ts", "NEEDLE in caps\n"], ["node_modules/pkg/index.js", "needle\n"], ["build/out.js", "needle\n"], ["README.md", "no match here\n"], ["dir with space/c.txt", "needle (1)\n"]] as const) {
        mkdirSync(join(remote.root, path, ".."), { recursive: true });
        writeFileSync(join(remote.root, path), text);
    }
    const listed = await ws.listFiles(".", 100);
    assert.deepEqual(listed.files, ["README.md", "dir with space/c.txt", "src/a.ts", "src/b.ts"]);
    assert.deepEqual((await ws.listFiles("src", 100)).files, ["src/a.ts", "src/b.ts"]);
    assert.deepEqual((await ws.listFiles("src/a.ts", 100)).files, ["src/a.ts"]);
    assert.deepEqual((await ws.listFiles(".", 2)), { files: ["README.md", "dir with space/c.txt"], truncated: true });
    await assert.rejects(ws.listFiles("nope", 10), PathError);
    // A folder named like a skipped one is listed when asked for by name.
    assert.deepEqual((await ws.listFiles("build", 10)).files, ["build/out.js"]);

    const literal = await ws.searchText({ pattern: "needle", maxResults: 50 });
    assert.deepEqual(literal.matches.sort(), ["dir with space/c.txt:1:needle (1)", "src/a.ts:1:const needle = 1;", "src/b.ts:1:NEEDLE in caps"].sort());
    const exact = await ws.searchText({ pattern: "needle", caseSensitive: true, maxResults: 50 });
    assert.deepEqual(exact.matches.sort(), ["dir with space/c.txt:1:needle (1)", "src/a.ts:1:const needle = 1;"].sort());
    const regex = await ws.searchText({ pattern: "^const (n|O)\\w+", regex: true, caseSensitive: true, maxResults: 50 });
    assert.deepEqual(regex.matches.sort(), ["src/a.ts:1:const needle = 1;", "src/a.ts:2:const Other = 2;"].sort());
    // A pattern is text, never an option or a shell word.
    assert.deepEqual((await ws.searchText({ pattern: "-n", maxResults: 5 })).matches, []);
    assert.deepEqual((await ws.searchText({ pattern: "needle (1)", maxResults: 5 })).matches, ["dir with space/c.txt:1:needle (1)"]);
    assert.deepEqual((await ws.searchText({ pattern: "$(touch pwned)", maxResults: 5 })).matches, []);
    assert.equal(existsSync(join(remote.root, "pwned")), false);
    const capped = await ws.searchText({ pattern: "needle", maxResults: 1 });
    assert.equal(capped.matches.length, 1);
    assert.equal(capped.truncated, true);
    await assert.rejects(ws.searchText({ pattern: "a\nb", maxResults: 5 }), PathError);
    assert.deepEqual((await ws.searchText({ pattern: "needle", path: "README.md", maxResults: 5 })).matches, []);
});

test("git's own list is used in a repository: ignored files stay out, untracked ones are in", { skip }, async () => {
    const remote = await connected();
    try {
        remote.sh("git init -q . && git config user.email a@b.c && git config user.name t");
    } catch {
        return; // no git on this machine: nothing to check
    }
    writeFileSync(join(remote.root, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(remote.root, "ignored.txt"), "x");
    writeFileSync(join(remote.root, "tracked.txt"), "x");
    remote.sh("git add tracked.txt .gitignore && git commit -q -m one");
    writeFileSync(join(remote.root, "untracked.txt"), "x");
    assert.deepEqual((await remote.workspace.listFiles(".", 50)).files, [".gitignore", "tracked.txt", "untracked.txt"]);
});

const plan = async (remote: Awaited<ReturnType<typeof connected>>, edits: Parameters<RemoteWorkspace["planPatch"]>[0]) => remote.workspace.planPatch(edits);

test("a patch is planned from the remote file and written in one rename: create, update (mode kept), delete", { skip }, async () => {
    const remote = await connected();
    const { workspace: ws } = remote;
    // A script with a shebang: Git for Windows' sh only reports an executable mode for a file that looks like one.
    writeFileSync(join(remote.root, "run.sh"), "#!/bin/sh\necho one\n");
    remote.sh("chmod 755 run.sh");
    writeFileSync(join(remote.root, "old.txt"), "bye\n");
    const [update, create, remove] = await plan(remote, [
        { path: "run.sh", action: "update", replacements: [{ old: "one", new: "two" }] },
        { path: "new/dir/file.txt", action: "create", content: "fresh\n" },
        { path: "old.txt", action: "delete" },
    ]);
    assert.equal(update!.beforeText, "#!/bin/sh\necho one\n");
    assert.equal(update!.afterText, "#!/bin/sh\necho two\n");
    assert.equal(update!.absolute, `${ws.root}/run.sh`);
    assert.equal(create!.binding.folder, ws.root, "a new folder is bound to the nearest existing one");
    assert.equal(create!.binding.file, null);
    const written = await ws.writeFile(update!);
    assert.equal(readFileSync(join(remote.root, "run.sh"), "utf8"), "#!/bin/sh\necho two\n");
    assert.match(written.ident, /:755$/, "the file's mode is kept");
    assert.match(remote.sh("stat -c %a run.sh 2>/dev/null || stat -f %Lp run.sh").trim(), /^755$/);
    await ws.writeFile(create!);
    assert.equal(readFileSync(join(remote.root, "new", "dir", "file.txt"), "utf8"), "fresh\n");
    await ws.removeFile(remove!);
    assert.equal(existsSync(join(remote.root, "old.txt")), false);
    // Nothing temporary is left behind.
    const left = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? left(join(folder, entry.name)) : /tomverse-/.test(entry.name) ? [entry.name] : []);
    assert.deepEqual(left(remote.root), []);
});

test("a write only goes ahead on the file that was approved: a changed file, a created one and a swapped folder are refused untouched", { skip }, async () => {
    const remote = await connected();
    const { workspace: ws } = remote;
    writeFileSync(join(remote.root, "a.txt"), "original\n");
    const [edit] = await plan(remote, [{ path: "a.txt", action: "update", replacements: [{ old: "original", new: "edited" }] }]);
    // Somebody else changes the file between the approval and the write.
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(join(remote.root, "a.txt"), "someone else was here\n");
    remote.sh("mv a.txt b.txt && cp b.txt a.txt");
    await assert.rejects(ws.writeFile(edit!), remoteError("changed"));
    assert.equal(readFileSync(join(remote.root, "a.txt"), "utf8"), "someone else was here\n");
    // A create where something now exists.
    const [create] = await plan(remote, [{ path: "c.txt", action: "create", content: "mine\n" }]);
    writeFileSync(join(remote.root, "c.txt"), "theirs\n");
    await assert.rejects(ws.writeFile(create!), remoteError("exists"));
    assert.equal(readFileSync(join(remote.root, "c.txt"), "utf8"), "theirs\n");
    // The folder the approval was bound to is replaced by another one.
    mkdirSync(join(remote.root, "d"));
    writeFileSync(join(remote.root, "d", "e.txt"), "e\n");
    const [inFolder] = await plan(remote, [{ path: "d/e.txt", action: "update", replacements: [{ old: "e", new: "E" }] }]);
    remote.sh("mv d d-old && mkdir d && cp d-old/e.txt d/e.txt");
    await assert.rejects(ws.writeFile(inFolder!), remoteError("changed"));
    assert.equal(readFileSync(join(remote.root, "d", "e.txt"), "utf8"), "e\n");
    // A delete of a file that changed.
    writeFileSync(join(remote.root, "f.txt"), "f\n");
    const [remove] = await plan(remote, [{ path: "f.txt", action: "delete" }]);
    remote.sh("rm f.txt && echo g > f.txt");
    await assert.rejects(ws.removeFile(remove!), remoteError("changed"));
    assert.equal(existsSync(join(remote.root, "f.txt")), true);
});

test("a write that does not arrive complete leaves the existing file as it was and no temporary file", { skip }, async () => {
    const remote = makeFakeRemote();
    writeFileSync(join(remote.root, "keep.txt"), "the old content\n");
    const ws = new RemoteWorkspace(remote.target, async (request) => remote.runner({ ...request, stdin: request.stdin ? request.stdin.subarray(0, 3) : request.stdin }));
    await ws.connect();
    const [edit] = await ws.planPatch([{ path: "keep.txt", action: "update", replacements: [{ old: "old", new: "NEW" }] }]);
    await assert.rejects(ws.writeFile(edit!), remoteError("write-incomplete"));
    assert.equal(readFileSync(join(remote.root, "keep.txt"), "utf8"), "the old content\n");
    assert.deepEqual(readdirSync(remote.root), ["keep.txt"]);
    const [create] = await ws.planPatch([{ path: "n/new.txt", action: "create", content: "something long enough\n" }]);
    await assert.rejects(ws.writeFile(create!), remoteError("write-incomplete"));
    assert.equal(existsSync(join(remote.root, "n", "new.txt")), false);
    assert.deepEqual(readdirSync(join(remote.root, "n")), [], "only the empty folder the write made");
});

test("planning refuses what the local rules refuse: a link, a folder, a duplicate, text that cannot be shown", { skip }, async () => {
    const remote = await connected();
    mkdirSync(join(remote.root, "dir"));
    writeFileSync(join(remote.root, "f.txt"), "x\n");
    remote.sh("ln -s f.txt l.txt");
    await assert.rejects(plan(remote, [{ path: "l.txt", action: "update", replacements: [{ old: "x", new: "y" }] }]), PathError);
    await assert.rejects(plan(remote, [{ path: "dir", action: "delete" }]), (error) => error instanceof PatchError && /not a regular file/.test(error.message));
    await assert.rejects(plan(remote, [{ path: "f.txt", action: "delete" }, { path: "f.txt", action: "delete" }]), (error) => error instanceof PatchError && /twice/.test(error.message));
    await assert.rejects(plan(remote, [{ path: "g.txt", action: "create", content: "bad‮text" }]), PatchError);
    await assert.rejects(plan(remote, [{ path: "f.txt", action: "create", content: "x" }]), (error) => error instanceof PatchError && /already exists/.test(error.message));
    await assert.rejects(plan(remote, [{ path: "../f.txt", action: "create", content: "x" }]), PathError);
    await assert.rejects(plan(remote, []), PatchError);
});

const commandPlan = (remote: Awaited<ReturnType<typeof connected>>, input: Parameters<typeof planRemoteCommand>[0], cwd = remote.workspace.root) => planRemoteCommand(input, cwd, 30_000);
const run = (remote: Awaited<ReturnType<typeof connected>>, input: Parameters<typeof planRemoteCommand>[0], signal = new AbortController().signal, cwd?: string) => {
    const out: string[] = [];
    return remote.workspace.exec(commandPlan(remote, input, cwd), signal, (stream, text) => out.push(`${stream}:${text}`)).then((result) => ({ result, out }));
};

test("a command runs on the remote machine in the project folder with its own exit code, output and error text", { skip }, async () => {
    const remote = await connected();
    mkdirSync(join(remote.root, "sub"));
    const shell = await run(remote, { command: "pwd; echo out; echo err >&2; exit 7" });
    assert.equal(shell.result.exitCode, 7);
    assert.equal(shell.result.stdout, `${remote.workspace.root}\nout\n`);
    assert.equal(shell.result.stderr, "err\n");
    assert.deepEqual(shell.out.filter((line) => line.startsWith("stderr:")), ["stderr:err\n"]);
    const argv = await run(remote, { argv: ["sh", "-c", 'printf "%s|" "$@"', "sh", "a b", "$HOME", "it's", "; id"] });
    assert.equal(argv.result.stdout, "a b|$HOME|it's|; id|");
    assert.equal(argv.result.exitCode, 0);
    const sub = await run(remote, { command: "pwd" }, undefined, `${remote.workspace.root}/sub`);
    assert.equal(sub.result.stdout, `${remote.workspace.root}/sub\n`);
    // Text that looks like the start marker is only output.
    const marker = await run(remote, { command: "printf '@tv-start\\nmore'" });
    assert.equal(marker.result.stdout, "@tv-start\nmore");
    // Standard input is closed.
    const input = await run(remote, { command: "cat; echo done" });
    assert.equal(input.result.stdout, "done\n");
    const missing = await run(remote, { argv: ["no-such-program-tomverse"] });
    assert.equal(missing.result.exitCode, 127);
    assert.equal(remote.workspace.state, "connected", "a failing command is not a failing connection");
});

test("a command's folder is checked on the remote machine too", { skip }, async () => {
    const remote = await connected();
    remote.sh(`ln -s "${remotePath(remote.base)}/.." out-link`);
    const plan = commandPlan(remote, { command: "pwd" }, `${remote.workspace.root}/out-link`);
    await assert.rejects(remote.workspace.exec(plan, new AbortController().signal), remoteError("outside-root"));
    const gone = commandPlan(remote, { command: "pwd" }, `${remote.workspace.root}/nowhere`);
    await assert.rejects(remote.workspace.exec(gone, new AbortController().signal), remoteError("not-found"));
    assert.equal(remote.workspace.state, "connected");
});

test("the command plan is the same check as a local one: one form only, a real timeout, nothing the approval cannot show", () => {
    const base = { argv: ["ls"] };
    assert.equal(planRemoteCommand(base, "/srv/app", 30_000).timeoutMs, 30_000);
    assert.equal(planRemoteCommand({ ...base, timeoutSeconds: 5 }, "/srv/app", 30_000).timeoutMs, 5_000);
    assert.equal(planRemoteCommand({ ...base, timeoutSeconds: 99_999 }, "/srv/app", 30_000).timeoutMs, 30 * 60_000);
    const shell = planRemoteCommand({ command: "ls | wc -l" }, "/srv/app", 30_000);
    assert.deepEqual([shell.mode, shell.shell, shell.display, shell.envNames], ["shell", "sh", "ls | wc -l", []]);
    assert.throws(() => planRemoteCommand({}, "/srv/app", 1), /exactly one/);
    assert.throws(() => planRemoteCommand({ argv: ["ls"], command: "ls" }, "/srv/app", 1), /exactly one/);
    assert.throws(() => planRemoteCommand({ ...base, timeoutSeconds: -1 }, "/srv/app", 1), /positive/);
    assert.throws(() => planRemoteCommand({ argv: ["echo", "a‮b"] }, "/srv/app", 1), /bidi/);
    assert.throws(() => planRemoteCommand({ command: "echo ​" }, "/srv/app", 1), /invisible|bidi/);
    assert.throws(() => planRemoteCommand({ command: "echo a\0b" }, "/srv/app", 1));
    assert.equal(planRemoteCommand({ command: "sleep 100", background: true }, "/srv/app", 30_000).timeoutMs, 0);
});

test("a command that is too slow is ended on the remote machine, not only here", { skip }, async () => {
    const remote = await connected();
    const pidFile = join(remote.root, "slow.pid");
    const started = Date.now();
    const plan = planRemoteCommand({ command: `echo $$ > slow.pid; exec sleep 60`, timeoutSeconds: 1 }, remote.workspace.root, 30_000);
    const result = await remote.workspace.exec(plan, new AbortController().signal);
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 15_000);
    const pid = readFileSync(pidFile, "utf8").trim();
    await waitUntil(() => !alive(remote, pid));
    assert.equal(alive(remote, pid), false, "the command on the remote machine is gone");
});

test("stopping the task ends the remote command", { skip }, async () => {
    const remote = await connected();
    const stop = new AbortController();
    const plan = planRemoteCommand({ command: `echo $$ > run.pid; exec sleep 60` }, remote.workspace.root, 30_000);
    const pending = remote.workspace.exec(plan, stop.signal);
    await waitUntil(() => existsSync(join(remote.root, "run.pid")) && readFileSync(join(remote.root, "run.pid"), "utf8").trim() !== "");
    stop.abort();
    const result = await pending;
    assert.equal(result.cancelled, true);
    const pid = readFileSync(join(remote.root, "run.pid"), "utf8").trim();
    await waitUntil(() => !alive(remote, pid));
    assert.equal(alive(remote, pid), false);
    assert.equal(remote.workspace.state, "connected");
});

function alive(remote: Awaited<ReturnType<typeof connected>>, pid: string) {
    try {
        remote.sh(`kill -0 ${Number(pid)} 2>/dev/null`);
        return true;
    } catch {
        return false;
    }
}

async function waitUntil(check: () => boolean, ms = 10_000) {
    const end = Date.now() + ms;
    while (Date.now() < end && !check()) await new Promise((resolve) => setTimeout(resolve, 100));
}

test("a lost connection stops the work in a clear state, blocks every further call, and a reconnect continues", { skip }, async () => {
    const remote = await connected();
    writeFileSync(join(remote.root, "a.txt"), "a\n");
    const lost: string[] = [];
    remote.workspace.onLost((reason) => lost.push(reason));
    remote.failNext("reset");
    await assert.rejects(remote.workspace.resolve("a.txt", "read"), remoteError("connection-lost"));
    assert.equal(remote.workspace.state, "lost");
    assert.equal(lost.length, 1);
    assert.match(remote.workspace.blockReason ?? "", /connection to devbox was lost/);
    const before = remote.calls().length;
    for (const attempt of [() => remote.workspace.resolve("a.txt", "read"), () => remote.workspace.listFiles(".", 5), () => remote.workspace.readFile(`${remote.workspace.root}/a.txt`)]) {
        await assert.rejects(attempt(), remoteError("connection-lost"));
    }
    const plan = commandPlan(remote, { command: "echo hi" });
    await assert.rejects(remote.workspace.exec(plan, new AbortController().signal), remoteError("connection-lost"));
    assert.equal(remote.calls().length, before, "nothing is sent while the connection is marked lost");
    assert.equal(lost.length, 1, "reported once");
    // Reconnecting brings it back, and the work goes on where it was.
    await remote.workspace.connect();
    assert.equal(remote.workspace.state, "connected");
    assert.equal((await remote.workspace.resolve("a.txt", "read")).kind, "file");
});

test("a connection that drops while a command runs is reported as lost, and the machine ends the command", { skip }, async () => {
    const remote = await connected();
    remote.failNext("drop-mid", 1, 700);
    const plan = planRemoteCommand({ command: `echo $$ > run.pid; echo started; exec sleep 60` }, remote.workspace.root, 30_000);
    const result = await remote.workspace.exec(plan, new AbortController().signal);
    assert.ok(result.lost instanceof RemoteError);
    assert.equal(result.lost.code, "connection-lost");
    assert.equal(result.exitCode, null);
    assert.equal(remote.workspace.state, "lost");
    assert.match(result.stdout, /started/);
    const pid = readFileSync(join(remote.root, "run.pid"), "utf8").trim();
    await waitUntil(() => !alive(remote, pid));
    assert.equal(alive(remote, pid), false, "the command does not outlive its connection");
});

test("a write that gets no answer is not assumed to have failed", { skip }, async () => {
    const remote = await connected();
    writeFileSync(join(remote.root, "w.txt"), "before\n");
    const [edit] = await plan(remote, [{ path: "w.txt", action: "update", replacements: [{ old: "before", new: "after" }] }]);
    remote.failNext("reset");
    await assert.rejects(remote.workspace.writeFile(edit!), remoteError("connection-lost"));
    assert.equal(remote.workspace.state, "lost");
    // The file is whole either way: the old content here, the new one in the other case.
    assert.match(readFileSync(join(remote.root, "w.txt"), "utf8"), /^(before|after)\n$/);
});

test("AGENTS.md of the remote folder is given to the model, bounded, and a missing one is not an error", { skip }, async () => {
    const remote = await connected();
    assert.equal(await remote.workspace.readInstructions(), null);
    writeFileSync(join(remote.root, "AGENTS.md"), "Use tabs.\n");
    assert.deepEqual(await remote.workspace.readInstructions(), { text: "Use tabs.\n", truncated: false });
    writeFileSync(join(remote.root, "CLAUDE.md"), "Be brief.\n");
    const both = await remote.workspace.readInstructions();
    assert.match(both!.text, /--- AGENTS\.md ---\nUse tabs\.[\s\S]*--- CLAUDE\.md ---\nBe brief\./);
    writeFileSync(join(remote.root, "AGENTS.md"), "x".repeat(40_000));
    assert.equal((await remote.workspace.readInstructions())!.truncated, true);
});

test("a folder with a space in its name works end to end", { skip }, async () => {
    const remote = makeFakeRemote({ subfolder: "my project" });
    writeFileSync(join(remote.root, "x.txt"), "x\n");
    const ws = new RemoteWorkspace(remote.target, remote.runner);
    await ws.connect();
    assert.deepEqual((await ws.listFiles(".", 10)).files, ["x.txt"]);
    const [edit] = await ws.planPatch([{ path: "y.txt", action: "create", content: "y\n" }]);
    await ws.writeFile(edit!);
    assert.equal(readFileSync(join(remote.root, "y.txt"), "utf8"), "y\n");
});

test("the remote scripts run under dash, the strictest common POSIX shell", { skip: !HAS_SH || dashShim() === null && "dash is not installed here" }, async () => {
    const remote = makeFakeRemote({ path: dashShim()! });
    writeFileSync(join(remote.root, "a.txt"), "needle\n");
    remote.sh("ln -s a.txt link.txt");
    const ws = remote.workspace;
    await ws.connect();
    assert.equal((await ws.resolve("link.txt", "read")).relative, "a.txt");
    await assert.rejects(ws.resolve("link.txt", "write"), PathError);
    await assert.rejects(ws.resolve("../x", "read"), PathError);
    assert.deepEqual((await ws.listFiles(".", 10)).files, ["a.txt"]);
    assert.deepEqual((await ws.searchText({ pattern: "needle", maxResults: 5 })).matches, ["a.txt:1:needle"]);
    const [edit, fresh] = await ws.planPatch([{ path: "a.txt", action: "update", replacements: [{ old: "needle", new: "thread" }] }, { path: "d/n.txt", action: "create", content: "n\n" }]);
    await ws.writeFile(edit!);
    await ws.writeFile(fresh!);
    assert.equal(readFileSync(join(remote.root, "a.txt"), "utf8"), "thread\n");
    assert.equal(readFileSync(join(remote.root, "d", "n.txt"), "utf8"), "n\n");
    const done = await ws.exec(planRemoteCommand({ command: "echo $$ > p.pid; echo hi; exit 3" }, ws.root, 30_000), new AbortController().signal);
    assert.deepEqual([done.exitCode, done.stdout], [3, "hi\n"]);
    const stop = new AbortController();
    const pending = ws.exec(planRemoteCommand({ command: "echo $$ > s.pid; exec sleep 60" }, ws.root, 30_000), stop.signal);
    await waitUntil(() => existsSync(join(remote.root, "s.pid")) && readFileSync(join(remote.root, "s.pid"), "utf8").trim() !== "");
    stop.abort();
    assert.equal((await pending).cancelled, true);
    const pid = readFileSync(join(remote.root, "s.pid"), "utf8").trim();
    await waitUntil(() => !alive(remote, pid));
    assert.equal(alive(remote, pid), false);
});
