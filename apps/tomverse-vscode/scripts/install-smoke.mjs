import { desktopExecutable } from "./host-path.mjs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = join(root, "artifacts");
const workspace = join(artifacts, `install-${Date.now()}`);
mkdirSync(workspace, { recursive: true });
const executable = desktopExecutable();
if (!executable) throw new Error("Set VSCODE_EXECUTABLE_PATH to the local desktop executable.");
const base = dirname(executable);
const candidates = [join(base, "resources/app/out/cli.js"), resolve(base, "../Resources/app/out/cli.js")];
if (process.platform === "win32")
    for (const name of readdirSync(base)) if (/^[a-f0-9]{10}$/.test(name)) candidates.push(join(base, name, "resources/app/out/cli.js"));
const cli = process.env.VSCODE_CLI_JS || candidates.find(existsSync);
if (!cli) throw new Error("VS Code CLI entry not found. Set VSCODE_CLI_JS.");
const extensions = join(workspace, "extensions");
const profile = join(workspace, "profile");
const logs = [];
const run = (file, args, options = {}) => {
    const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true, ...options });
    logs.push({ args, code: result.status, stdout: result.stdout, stderr: result.stderr });
    if (result.status !== 0) throw new Error(`Command failed (${result.status}): ${result.stderr || result.stdout}`);
    return result.stdout;
};
const manage = (...args) =>
    run(executable, [cli, "--user-data-dir", profile, "--extensions-dir", extensions, ...args], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", VSCODE_DEV: "" },
    });
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const vsix = join(artifacts, `tomverse-vscode-${manifest.version}.vsix`);
// A synthetic prior package tests a real extension update, without claiming a prior public release.
const staging = join(workspace, "prior");
mkdirSync(staging);
for (const name of readdirSync(root).filter(
    (n) => /^package\.nls.*\.json$/.test(n) || ["README.md", "LICENSE", "CHANGELOG.md", "THIRD-PARTY-NOTICES.txt", ".vscodeignore"].includes(n),
))
    cpSync(join(root, name), join(staging, name));
mkdirSync(join(staging, "dist"));
cpSync(join(root, "dist/extension.cjs"), join(staging, "dist/extension.cjs"));
cpSync(join(root, "media"), join(staging, "media"), { recursive: true });
writeFileSync(join(staging, "package.json"), JSON.stringify({ ...manifest, version: "0.0.0", scripts: {}, devDependencies: {} }, null, 2));
const prior = join(workspace, "prior-0.0.0.vsix");
const vsce = join(dirname(require.resolve("@vscode/vsce/package.json")), "vsce");
run(process.execPath, [vsce, "package", "--no-dependencies", "--out", prior], { cwd: staging });
manage("--install-extension", prior, "--force");
if (!manage("--list-extensions", "--show-versions").includes("tomverse.tomverse-vscode@0.0.0")) throw new Error("Prior install missing");
manage("--install-extension", vsix, "--force");
if (!manage("--list-extensions", "--show-versions").includes(`tomverse.tomverse-vscode@${manifest.version}`)) throw new Error("Update missing");
manage("--uninstall-extension", "tomverse.tomverse-vscode");
manage("--install-extension", vsix, "--force");
const installed = readdirSync(extensions)
    .map((name) => join(extensions, name))
    .find((path) => {
        try {
            const m = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
            return m.publisher === "tomverse" && m.name === manifest.name && m.version === manifest.version;
        } catch {
            return false;
        }
    });
if (!installed) throw new Error("Installed runtime not found");
if (!readFileSync(join(installed, "dist/extension.cjs")).equals(readFileSync(join(root, "dist/extension.cjs"))))
    throw new Error("Installed runtime differs from build");
writeFileSync(
    join(artifacts, "install-smoke.json"),
    JSON.stringify(
        {
            executable,
            platform: process.platform,
            arch: process.arch,
            installed,
            vsix,
            sha256: createHash("sha256").update(readFileSync(vsix)).digest("hex"),
            baseline: "synthetic 0.0.0",
            result: "PASS install/update/uninstall/reinstall",
            logs,
        },
        null,
        2,
    ),
);
console.log(`PASS installed VSIX update and reinstall: ${installed}`);
const integration = spawnSync(process.execPath, [join(root, "scripts/integration.mjs")], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, TOMVERSE_TEST_EXTENSION_PATH: installed },
    windowsHide: true,
});
if (integration.status !== 0) process.exit(integration.status ?? 1);
