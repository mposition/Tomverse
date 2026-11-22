import { desktopExecutable } from "./host-path.mjs";
import { runTests } from "@vscode/test-electron";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.TOMVERSE_TEST_EXTENSION_PATH) await import("./build.mjs");
const artifacts = join(root, "artifacts");
const fixture = join(artifacts, `workspace-${Date.now()}`);
mkdirSync(fixture, { recursive: true });
writeFileSync(join(fixture, "sum.js"), "export const sum = (a, b) => a - b;\n");
await build({
    absWorkingDir: root,
    entryPoints: ["tests/integration/index.ts"],
    outfile: "dist/integration.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["vscode"],
});
const executable = desktopExecutable();
const extensionPath = process.env.TOMVERSE_TEST_EXTENSION_PATH || root;
const profiles = process.env.TOMVERSE_TEST_PROFILE ? [process.env.TOMVERSE_TEST_PROFILE] : ["trusted", "restricted"];
for (const profile of profiles) {
    const userData = join(artifacts, `profile-${profile}`);
    mkdirSync(join(userData, "User"), { recursive: true });
    writeFileSync(
        join(userData, "User/settings.json"),
        JSON.stringify({
            "security.workspace.trust.enabled": true,
            "security.workspace.trust.startupPrompt": "never",
            "security.workspace.trust.emptyWindow": false,
            "chat.disableAIFeatures": true,
            "telemetry.telemetryLevel": "off",
            "update.mode": "none",
        }),
    );
    const launchArgs = [
        fixture,
        "--user-data-dir",
        userData,
        "--extensions-dir",
        join(artifacts, "extensions"),
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-telemetry",
        "--disable-updates",
    ];
    const testEnv = { TOMVERSE_TEST_ARTIFACTS: artifacts, TOMVERSE_TEST_PROFILE: profile, TOMVERSE_TEST_DEMO: process.env.TOMVERSE_TEST_DEMO || "0" };
    if (profile === "trusted") {
        await runTests({
            vscodeExecutablePath: executable,
            version: "1.146.0",
            extensionDevelopmentPath: extensionPath,
            extensionTestsPath: join(root, "dist/integration.cjs"),
            launchArgs,
            extensionTestsEnv: testEnv,
        });
    } else {
        // test-electron.runTests unconditionally adds --disable-workspace-trust.
        // Launch the same documented Extension Development Host flags directly for Restricted Mode.
        if (!executable) throw new Error("Set VSCODE_EXECUTABLE_PATH for the trust-enabled restricted run.");
        await new Promise((resolve, reject) => {
            const child = spawn(
                executable,
                [
                    ...launchArgs,
                    `--extensionDevelopmentPath=${extensionPath}`,
                    `--extensionTestsPath=${join(root, "dist/integration.cjs")}`,
                    "--no-sandbox",
                    "--disable-gpu-sandbox",
                ],
                { env: { ...process.env, ...testEnv }, stdio: "inherit", windowsHide: true },
            );
            child.on("error", reject);
            child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Restricted host exited ${code}`))));
        });
    }
}
