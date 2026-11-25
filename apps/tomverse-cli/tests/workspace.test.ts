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
import { readInstructions } from "../src/main.js";
import { readProjectInstructions } from "../src/runtime.js";

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

test("project references accept files and folders while respecting workspace exclusions", () => {
    const root = tempDir("references");
    const outside = tempDir("outside");
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules"));
    mkdirSync(join(root, "private-data"));
    writeFileSync(join(root, "src", "main.ts"), "");
    writeFileSync(join(root, "node_modules", "index.js"), "");
    writeFileSync(join(root, ".env"), "");
    link(outside, join(root, "escape"));
    const workspace = new Workspace(normalizeRoot(root), [join(root, "private-data")]);
    assert.deepEqual(workspace.reference("."), { path: ".", kind: "folder" });
    assert.deepEqual(workspace.reference(join(root, "src")), { path: "src", kind: "folder" });
    assert.deepEqual(workspace.reference(join(root, "src", "main.ts")), { path: "src/main.ts", kind: "file" });
    for (const path of ["missing", "node_modules", "node_modules/index.js", ".env", "private-data", "escape", outside]) {
        assert.throws(() => workspace.reference(path), PathError, path);
    }
});

test("large project instructions expose a bounded excerpt and a truncation flag", () => {
    const root = tempDir("instructions");
    const prefix = "Project guidance.\n";
    const path = join(root, "AGENTS.md");
    const workspace = new Workspace(normalizeRoot(root));
    writeFileSync(path, prefix);
    assert.deepEqual(readProjectInstructions(workspace), { text: prefix, truncated: false });
    writeFileSync(path, prefix + "가".repeat(90_000) + "Outside the excerpt.");
    const result = readProjectInstructions(workspace);
    assert.equal(result?.truncated, true);
    assert.ok(result?.text.startsWith(prefix));
    assert.match(result?.text ?? "", /\[AGENTS\.md continues/);
    assert.doesNotMatch(result?.text ?? "", /Outside the excerpt/);
    writeFileSync(path, "a".repeat(31_999) + "😀 outside the excerpt.");
    const unicode = readProjectInstructions(workspace);
    assert.equal(unicode?.text.split("\n")[0], "a".repeat(31_999));
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

test("AGENTS.md is read only through the same path check: a link out of the folder is not sent", () => {
    const root = tempDir("ws");
    const outside = tempDir("outside");
    writeFileSync(join(outside, "AGENTS.md"), "private notes from elsewhere");
    writeFileSync(join(root, "README.md"), "x");
    assert.equal(readInstructions(new Workspace(normalizeRoot(root))), null, "no AGENTS.md");
    writeFileSync(join(root, "AGENTS.md"), "Run npm test before you finish.");
    assert.equal(readInstructions(new Workspace(normalizeRoot(root))), "Run npm test before you finish.");
    const linked = tempDir("ws");
    mkdirSync(join(linked, "docs"));
    link(outside, join(linked, "docs", "shared"));
    // A folder link named like the file cannot smuggle the outside file in.
    link(outside, join(linked, "AGENTS.md"));
    assert.equal(readInstructions(new Workspace(normalizeRoot(linked))), null);
});
