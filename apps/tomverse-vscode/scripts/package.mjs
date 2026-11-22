import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await import("./build.mjs");
const inputs = Object.keys(JSON.parse(readFileSync(join(root, "dist/build-meta.json"), "utf8")).inputs);
const packages = new Set();
for (const input of inputs) {
    const match = input.replaceAll("\\", "/").match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (match) packages.add(resolve(root, match[1]));
}
const notices = [];
for (const path of [...packages].sort()) {
    const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    const license = readdirSync(path).find((name) => /^licen[sc]e(?:\.(?:md|txt))?$/i.test(name));
    if (!license && !(manifest.name.startsWith("@ai-sdk/") && manifest.license === "Apache-2.0"))
        throw new Error(`No bundled dependency license: ${manifest.name}`);
    const text = license
        ? readFileSync(join(path, license), "utf8")
        : readFileSync(require.resolve("ai/package.json").replace("package.json", "LICENSE"), "utf8");
    notices.push(`${manifest.name}@${manifest.version}\n${text}`);
    const embedded = join(path, "src/to-json-schema/zod3-to-json-schema/LICENSE");
    if (existsSync(embedded)) notices.push(`${manifest.name} embedded zod3-to-json-schema\n${readFileSync(embedded, "utf8")}`);
}
notices.push(readFileSync(join(root, "scripts/licenses/Apache-2.0.txt"), "utf8"));
writeFileSync(join(root, "THIRD-PARTY-NOTICES.txt"), notices.join("\n\n--------------------\n\n"));
mkdirSync(join(root, "artifacts"), { recursive: true });
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const vsce = join(dirname(require.resolve("@vscode/vsce/package.json")), "vsce");
const sourceDate = execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
const result = spawnSync(
    process.execPath,
    [vsce, "package", "--no-dependencies", "--allow-missing-repository", "--out", `artifacts/tomverse-vscode-${manifest.version}.vsix`],
    { cwd: root, stdio: "inherit", windowsHide: true, env: { ...process.env, SOURCE_DATE_EPOCH: sourceDate } },
);
if (result.status !== 0) process.exit(result.status ?? 1);
