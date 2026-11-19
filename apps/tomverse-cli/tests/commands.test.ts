import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { commandEnv, planCommand, runCommand, CommandError } from "../src/commands.js";
import { tempDir } from "./helpers.js";

const node = process.execPath;
const never = new AbortController().signal;

test("argv runs the program directly: shell characters are plain arguments", async () => {
    const cwd = tempDir("cmd");
    const plan = planCommand({ argv: [node, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "a & b", "c|d", "$(x)", "%PATH%", "한글 값"] }, cwd, 10_000);
    assert.equal(plan.mode, "argv");
    assert.equal(plan.shell, null);
    const result = await runCommand(plan, never);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["a & b", "c|d", "$(x)", "%PATH%", "한글 값"]);
});

test("the shell form names its shell and runs a pipeline there", async () => {
    const cwd = tempDir("cmd");
    const plan = planCommand({ command: process.platform === "win32" ? "Write-Output 'one two' | ForEach-Object { $_.ToUpper() }" : "echo 'one two' | tr a-z A-Z" }, cwd, 10_000);
    assert.equal(plan.mode, "shell");
    assert.ok(plan.shell && plan.file === plan.shell);
    assert.match(plan.file, process.platform === "win32" ? /powershell\.exe$/i : /\/(bash|zsh|sh|dash)$/);
    const result = await runCommand(plan, never);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /ONE TWO/);
});

test("a folder with spaces and Korean, a non-zero exit, stderr and closed stdin", async () => {
    const cwd = join(tempDir("cmd"), "폴더 with space");
    mkdirSync(cwd);
    const plan = planCommand({ argv: [node, "-e", "process.stdin.on('data',()=>{}).on('end',()=>{console.error('stdin closed in '+process.cwd());process.exit(3)})"] }, cwd, 10_000);
    const result = await runCommand(plan, never);
    assert.equal(result.exitCode, 3);
    assert.ok(result.stderr.includes("stdin closed in") && result.stderr.includes("폴더 with space"), result.stderr);
});

test("output is bounded to the first and last 32 KB with the omission counted", async () => {
    const plan = planCommand({ argv: [node, "-e", "process.stdout.write('H'.repeat(40000)+'M'.repeat(100000)+'T'.repeat(40000))"] }, tempDir("cmd"), 20_000);
    const result = await runCommand(plan, never);
    assert.equal(result.stdoutOmittedBytes, 180_000 - 65_536);
    assert.ok(result.stdout.startsWith("H".repeat(1000)));
    assert.ok(result.stdout.endsWith("T".repeat(1000)));
    assert.match(result.stdout, /bytes omitted/);
});

/** A parent that starts a grandchild which would write a marker file after 4 s. */
const treeScript = (marker: string) => {
    const dir = tempDir("tree");
    const grandchild = join(dir, "grandchild.cjs");
    writeFileSync(grandchild, `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 4000); setInterval(() => {}, 1000);\n`);
    const parent = join(dir, "parent.cjs");
    writeFileSync(
        parent,
        `const child = require("child_process").spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "ignore" });\nconsole.log("child " + child.pid);\nsetInterval(() => {}, 1000);\n`
    );
    return parent;
};

test("a timeout ends the command and the process it started", async () => {
    const cwd = tempDir("cmd");
    const marker = join(cwd, "survived.txt");
    const plan = planCommand({ argv: [node, treeScript(marker)], timeoutSeconds: 1.5 }, cwd, 10_000);
    const result = await runCommand(plan, never);
    assert.equal(result.timedOut, true);
    assert.deepEqual(result.residualProcesses, []);
    const grandchild = Number(/child (\d+)/.exec(result.stdout)?.[1]);
    assert.ok(grandchild > 0, result.stdout);
    await new Promise((r) => setTimeout(r, 5000));
    assert.equal(existsSync(marker), false, "the grandchild was ended with the tree");
});

test("cancelling ends the command tree too", async () => {
    const cwd = tempDir("cmd");
    const marker = join(cwd, "survived.txt");
    const controller = new AbortController();
    const plan = planCommand({ argv: [node, treeScript(marker)] }, cwd, 60_000);
    const running = runCommand(plan, controller.signal);
    setTimeout(() => controller.abort(), 800);
    const result = await running;
    assert.equal(result.cancelled, true);
    assert.deepEqual(result.residualProcesses, []);
    await new Promise((r) => setTimeout(r, 5000));
    assert.equal(existsSync(marker), false);
});

test("commands get a small environment: never the Tomverse key or other secrets", async () => {
    const env = commandEnv(["MY_TOOL_HOME", "TOMVERSE_API_KEY"], {
        PATH: "/bin",
        HOME: "/home/u",
        TOMVERSE_API_KEY: "tvk_secret",
        TOMVERSE_ENDPOINT: "https://x",
        AWS_SECRET_ACCESS_KEY: "aws",
        OPENAI_API_KEY: "sk",
        GITHUB_TOKEN: "gh",
        MY_TOOL_HOME: "/opt/tool",
    });
    assert.equal(env.PATH, "/bin");
    assert.equal(env.MY_TOOL_HOME, "/opt/tool", "a name the user listed is passed");
    for (const name of ["TOMVERSE_API_KEY", "TOMVERSE_ENDPOINT", "AWS_SECRET_ACCESS_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN"]) assert.equal(env[name], undefined, name);
    process.env.TOMVERSE_API_KEY = "tvk_should_not_leak";
    try {
        const plan = planCommand({ argv: [node, "-e", "console.log(process.env.TOMVERSE_API_KEY ?? 'absent')"] }, tempDir("cmd"), 10_000);
        assert.ok(!plan.envNames.includes("TOMVERSE_API_KEY"));
        assert.equal((await runCommand(plan, never)).stdout.trim(), "absent");
    } finally {
        delete process.env.TOMVERSE_API_KEY;
    }
});

test("argv refuses a Windows batch script; the shell form is the way to run it", { skip: process.platform !== "win32" }, () => {
    const cwd = tempDir("cmd");
    writeFileSync(join(cwd, "tool.cmd"), "@echo off\r\necho hi\r\n");
    assert.throws(() => planCommand({ argv: [join(cwd, "tool.cmd"), "a&b"] }, cwd, 10_000), /batch script/);
    assert.throws(() => planCommand({ argv: ["npm", "test"] }, cwd, 10_000), /batch script|not/);
    assert.equal(planCommand({ command: "npm test" }, cwd, 10_000).mode, "shell");
});

test("exactly one of argv or command; sane timeouts", () => {
    const cwd = tempDir("cmd");
    assert.throws(() => planCommand({}, cwd, 1000), CommandError);
    assert.throws(() => planCommand({ argv: ["x"], command: "x" }, cwd, 1000), CommandError);
    assert.throws(() => planCommand({ argv: ["x"], timeoutSeconds: -1 }, cwd, 1000), /positive/);
    assert.equal(planCommand({ argv: [node], timeoutSeconds: 99_999 }, cwd, 1000).timeoutMs, 30 * 60_000);
    assert.equal(planCommand({ argv: [node] }, cwd, 120_000).timeoutMs, 120_000);
    void readFileSync;
});
