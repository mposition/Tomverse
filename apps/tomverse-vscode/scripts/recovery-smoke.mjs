import { desktopExecutable } from "./host-path.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = join(root, "artifacts", `crash-${Date.now()}`);
const fixture = join(artifacts, "workspace");
mkdirSync(fixture, { recursive: true });
const executable = desktopExecutable();
if (!executable) throw new Error("Set VSCODE_EXECUTABLE_PATH");
await build({
    absWorkingDir: root,
    entryPoints: ["tests/integration/crash.ts"],
    outfile: "dist/crash.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["vscode"],
});
await build({
    absWorkingDir: root,
    entryPoints: ["../tomverse-cli/tests/fakeGateway.ts"],
    outfile: "dist/fake-gateway.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
});
const { FakeGateway } = createRequire(import.meta.url)(join(root, "dist/fake-gateway.cjs"));
const command =
    process.platform === "win32"
        ? { command: "Write-Output 'crash-command-started'; Start-Sleep -Seconds 60" }
        : { argv: ["/bin/sh", "-c", "echo crash-command-started; sleep 60"] };
const fake = await new FakeGateway({ script: () => ({ toolCalls: [{ name: "run_command", args: command }] }) }).start();
const installed = process.env.TOMVERSE_TEST_EXTENSION_PATH || JSON.parse(readFileSync(join(root, "artifacts/install-smoke.json"), "utf8")).installed;
const launch = (phase) => {
    const child = spawn(
        executable,
        [
            fixture,
            "--user-data-dir",
            join(artifacts, "profile"),
            "--extensions-dir",
            join(artifacts, "extensions"),
            `--extensionDevelopmentPath=${installed}`,
            `--extensionTestsPath=${join(root, "dist/crash.cjs")}`,
            "--disable-workspace-trust",
            "--skip-welcome",
            "--skip-release-notes",
            "--disable-updates",
            "--disable-telemetry",
        ],
        {
            env: { ...process.env, TOMVERSE_CRASH_BASE: fake.base, TOMVERSE_CRASH_ARTIFACT: artifacts, TOMVERSE_CRASH_PHASE: phase },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            detached: process.platform !== "win32",
        },
    );
    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    const ended = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => {
            writeFileSync(join(artifacts, `${phase}.log`), output);
            resolve(code);
        });
    });
    return { child, ended };
};
let seed;
try {
    seed = launch("seed");
    const started = Date.now();
    while (!existsSync(join(artifacts, "ready.json"))) {
        if (Date.now() - started > 40_000) throw new Error("Seed did not reach running command");
        await new Promise((r) => setTimeout(r, 100));
    }
    const requests = fake.completions.length;
    if (process.platform === "win32") {
        const kill = spawnSync("taskkill.exe", ["/PID", String(seed.child.pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
        if (kill.status !== 0) throw new Error(`Test tree termination failed: ${kill.stderr}`);
    } else process.kill(-seed.child.pid, "SIGKILL");
    await seed.ended;
    const resumed = launch("recover");
    if ((await resumed.ended) !== 0) throw new Error("Recovery host failed; see recover.log");
    if (fake.completions.length !== requests) throw new Error("Recovery sent another inference automatically");
    const result = {
        ...JSON.parse(readFileSync(join(artifacts, "recovered.json"), "utf8")),
        result: "PASS",
        requestsBefore: requests,
        requestsAfter: fake.completions.length,
        artifacts,
    };
    writeFileSync(join(root, "artifacts/recovery-smoke.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
} finally {
    if (seed && seed.child.exitCode === null) seed.child.kill();
    await fake.stop();
}
