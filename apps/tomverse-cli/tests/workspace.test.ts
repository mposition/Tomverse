import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse } from "node:path";
import test from "node:test";
import { isSecretPath, normalizeRoot, PathError, Workspace } from "../src/workspace.js";
import { planPatch, PatchError } from "../src/patch.js";
import { renderFileDiff, safeLine, safeText } from "../src/display.js";
import { tempDir } from "./helpers.js";

const link = (target: string, path: string) => {
    // A junction needs no privilege on Windows; elsewhere a directory symlink.
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
};

test("paths that leave the workspace are refused, through .. and through links", () => {
    const root = tempDir("ws");
    const outside = tempDir("outside");
    writeFileSync(join(outside, "secret.txt"), "outside");
    writeFileSync(join(root, "a.txt"), "inside");
    link(outside, join(root, "escape"));
    const ws = new Workspace(normalizeRoot(root));
    assert.equal(ws.resolve("a.txt", "read").relative, "a.txt");
    assert.equal(ws.resolve(join(root, "a.txt"), "read").relative, "a.txt", "an absolute path inside the root is fine");
    for (const bad of ["../outside.txt", "..", join(outside, "secret.txt"), "escape/secret.txt", "escape/new-file.txt", "escape"]) {
        for (const purpose of ["read", "write"] as const) {
            assert.throws(() => ws.resolve(bad, purpose), PathError, `${bad} (${purpose})`);
        }
    }
    // A new file below a new folder is fine and stays inside.
    assert.equal(ws.resolve("new/dir/file.txt", "write").exists, false);
});

test("credential paths and Git internals are never read or written", () => {
    const root = tempDir("ws");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), "[remote]\nurl = https://user:token@example.invalid\n");
    writeFileSync(join(root, ".env"), "TOKEN=x");
    mkdirSync(join(root, "pkg"));
    writeFileSync(join(root, "pkg", ".env.local"), "TOKEN=x");
    const ws = new Workspace(normalizeRoot(root));
    for (const path of [".env", "pkg/.env.local", ".git/config", "id_rsa", "deploy/server.pem", "secrets.yaml", "gcp-service-account-prod.json", ".npmrc", ".ssh/known_hosts"]) {
        assert.ok(isSecretPath(path), path);
        assert.throws(() => ws.resolve(path, "read"), /credentials/);
        assert.throws(() => ws.resolve(path, "write"), /credentials/);
    }
    for (const path of ["src/env.ts", "README.md", "keys.ts", "environment.md"]) assert.ok(!isSecretPath(path), path);
    const listed = ws.listFiles(".", 100);
    assert.ok(!listed.files.some((f) => isSecretPath(f)), JSON.stringify(listed.files));
});

test("Windows device, UNC and alternate-stream paths are refused", { skip: process.platform !== "win32" }, () => {
    const root = tempDir("ws");
    const ws = new Workspace(normalizeRoot(root));
    for (const bad of ["\\\\server\\share\\x.txt", "\\\\?\\C:\\Windows\\win.ini", "\\\\.\\PhysicalDrive0", "a.txt:hidden", "a.txt::$DATA"]) {
        assert.throws(() => ws.resolve(bad, "read"), PathError, bad);
    }
    // The same folder in another letter case is the same folder.
    writeFileSync(join(root, "Case.txt"), "x");
    assert.equal(ws.resolve(join(root.toUpperCase(), "Case.txt"), "read").relative.toLowerCase(), "case.txt");
});

test("the workspace cannot be the home folder or a filesystem root", () => {
    assert.throws(() => normalizeRoot(homedir()), /home folder/);
    assert.throws(() => normalizeRoot(parse(process.cwd()).root), /root/);
});

test("listing skips generated folders; a Git repo lists Git's view without ignored files", () => {
    const root = tempDir("ws");
    mkdirSync(join(root, "node_modules", "x"), { recursive: true });
    writeFileSync(join(root, "node_modules", "x", "index.js"), "");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "main.ts"), "");
    writeFileSync(join(root, "build.log"), "");
    const walk = new Workspace(normalizeRoot(root)).listFiles(".", 100);
    assert.equal(walk.source, "walk");
    assert.deepEqual(walk.files, ["build.log", "src/main.ts"]);
    if (spawnSync("git", ["--version"]).status === 0) {
        spawnSync("git", ["init", "-q"], { cwd: root });
        writeFileSync(join(root, ".gitignore"), "*.log\nnode_modules/\n");
        const git = new Workspace(normalizeRoot(root)).listFiles(".", 100);
        assert.equal(git.source, "git");
        assert.deepEqual(git.files.sort(), [".gitignore", "src/main.ts"]);
    }
    const bounded = new Workspace(normalizeRoot(root)).listFiles(".", 1);
    assert.equal(bounded.files.length, 1);
    assert.equal(bounded.truncated, true);
});

test("patches keep BOM, CRLF, Unicode and the final newline; ambiguity is refused", () => {
    const root = tempDir("patch");
    const ws = new Workspace(normalizeRoot(root));
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    writeFileSync(join(root, "crlf.txt"), Buffer.concat([bom, Buffer.from("첫 줄\r\nsecond line\r\nthird\r\n", "utf8")]));
    const [edit] = planPatch(ws, [{ path: "crlf.txt", action: "update", replacements: [{ old: "second line\nthird", new: "두 번째 줄\nthird" }] }]);
    assert.equal(edit!.eol, "crlf");
    assert.equal(edit!.bom, true);
    assert.deepEqual(edit!.afterBytes, Buffer.concat([bom, Buffer.from("첫 줄\r\n두 번째 줄\r\nthird\r\n", "utf8")]));

    writeFileSync(join(root, "nofinal.txt"), "a\nb");
    const [nofinal] = planPatch(ws, [{ path: "nofinal.txt", action: "update", replacements: [{ old: "b", new: "c" }] }]);
    assert.equal(nofinal!.afterText, "a\nc", "no newline is added at the end");

    writeFileSync(join(root, "dup.txt"), "x = 1\nx = 1\n");
    assert.throws(() => planPatch(ws, [{ path: "dup.txt", action: "update", replacements: [{ old: "x = 1", new: "x = 2" }] }]), /occurs 2 times/);
    assert.throws(() => planPatch(ws, [{ path: "dup.txt", action: "update", replacements: [{ old: "nope", new: "x" }] }]), /not found/);
    assert.throws(() => planPatch(ws, [{ path: "dup.txt", action: "create", content: "x" }]), /already exists/);
    assert.throws(() => planPatch(ws, [{ path: "dup.txt", action: "update", replacements: [{ old: "x = 1\nx = 1\n", new: "x = 1\nx = 1\n" }] }]), /unchanged/);
    assert.throws(
        () => planPatch(ws, [{ path: "dup.txt", action: "delete" }, { path: "./dup.txt", action: "delete" }]),
        /twice/
    );
    writeFileSync(join(root, "bin.dat"), Buffer.from([1, 0, 2, 3]));
    assert.throws(() => planPatch(ws, [{ path: "bin.dat", action: "update", replacements: [{ old: "a", new: "b" }] }]), /binary/);
    writeFileSync(join(root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    assert.throws(() => planPatch(ws, [{ path: "latin1.txt", action: "update", replacements: [{ old: "caf", new: "x" }] }]), /UTF-8/);

    writeFileSync(join(root, "mixed.txt"), "a\r\nb\nc\n");
    const [mixed] = planPatch(ws, [{ path: "mixed.txt", action: "update", replacements: [{ old: "b\n", new: "B\n" }] }]);
    assert.equal(mixed!.eol, "mixed");
    assert.equal(mixed!.afterText, "a\r\nB\nc\n", "mixed endings are matched and kept as they are");
    assert.equal(readFileSync(join(root, "mixed.txt"), "utf8"), "a\r\nb\nc\n", "planning writes nothing");
    assert.throws(() => planPatch(ws, []), PatchError);
});

test("terminal output cannot carry escape sequences, clipboard writes or bidi tricks", () => {
    const hostile = "ok\u001b]52;c;ZWNobyBwd25lZA==\u0007\u001b[2J\u001b[1A\rApprove? y\u202enoitca\u0000\u009b";
    const shown = safeText(hostile);
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e]/.test(shown), JSON.stringify(shown));
    assert.match(shown, /\\u\{1b\}\]52;c;/);
    assert.ok(safeLine("a\nb").includes("\\n"));
    assert.ok(safeText("한국어 · emoji 👍 tab\tok\n").includes("한국어 · emoji 👍 tab\tok\n"), "ordinary Unicode, tab and newline pass");
    const diff = renderFileDiff("x.txt", "a\r\nb\r\n", "a\r\nc\r\n");
    assert.match(diff, /- b\n\+ c/);
    assert.ok(!diff.includes("\\u{d}"), "CRLF is not shown as control characters");
});
