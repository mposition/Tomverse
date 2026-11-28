// Packs the CLI, installs the tarball into an empty folder outside the
// repository, and checks what a user would get: the file list, the manifest,
// runtime dependency licenses, no private paths or secrets in the code, the
// bin shim, and the process test suite run against the installed copy.
// A local pack is not a publication; nothing is uploaded.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(app, "..", "..");
const fail = (message) => {
    console.error(`pack-verify FAILED: ${message}`);
    process.exit(1);
};
const run = (cmd, args, options = {}) => {
    const result = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32" && /^(npm|npx)$/.test(cmd), ...options });
    if (result.status !== 0) fail(`${cmd} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
};

if (!existsSync(join(app, "dist", "cli.js"))) fail("dist/cli.js missing; run the build first.");
const work = mkdtempSync(join(tmpdir(), "tomverse-cli-pack-"));
const fromRepo = relative(repoRoot, work);
if (!fromRepo.startsWith("..") && !isAbsolute(fromRepo)) fail("the install folder must be outside the repository");

// 1. Pack and inspect the file list.
const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work], { cwd: app }))[0];
const tarball = join(work, packed.filename);
const files = packed.files.map((f) => f.path).sort();
const allowed = (path) => path === "package.json" || path === "README.md" || path === "LICENSE" || /^dist\/[a-z]+\.js$/.test(path);
const unexpected = files.filter((f) => !allowed(f));
if (unexpected.length) fail(`unexpected files in the package: ${unexpected.join(", ")}`);
for (const required of ["package.json", "README.md", "LICENSE", "dist/cli.js", "dist/main.js"]) if (!files.includes(required)) fail(`missing ${required}`);
const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");

// 2. Install into an empty project outside the repository.
const project = join(work, "user-project");
run("npm", ["init", "-y"], { cwd: work });
spawnSync(process.platform === "win32" ? "cmd" : "mkdir", process.platform === "win32" ? ["/c", "mkdir", project] : ["-p", project]);
writeFileSync(join(project, "package.json"), '{ "name": "user-project", "private": true }\n');
run("npm", ["install", tarball, "--no-audit", "--no-fund", "--prefer-offline", "--ignore-scripts"], { cwd: project });
const installed = join(project, "node_modules", "@tomverse", "cli");
const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
if (manifest.workspaces || manifest.devDependencies) fail("the published manifest carries workspace or dev fields");
const deps = Object.keys(manifest.dependencies ?? {}).sort();
if (deps.join(",") !== "@ai-sdk/openai,@modelcontextprotocol/sdk,ai,zod") fail(`unexpected runtime dependencies: ${deps.join(", ")}`);
for (const [name, version] of Object.entries(manifest.dependencies)) if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`${name} is not pinned (${version})`);

// 3. Licenses of everything that would be installed for a user.
const licenses = {};
const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(dir, entry.name);
        if (entry.name.startsWith("@")) {
            walk(path);
            continue;
        }
        const pj = join(path, "package.json");
        if (existsSync(pj)) {
            const p = JSON.parse(readFileSync(pj, "utf8"));
            if (p.name && p.name !== "@tomverse/cli") licenses[`${p.name}@${p.version}`] = typeof p.license === "string" ? p.license : JSON.stringify(p.license ?? null);
        }
        if (existsSync(join(path, "node_modules"))) walk(join(path, "node_modules"));
    }
};
walk(join(project, "node_modules"));
const LICENSE_ALLOW = new Set(["MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "BlueOak-1.0.0"]);
// An SPDX "A OR B" lets the user take either; one allowlisted option is enough.
const acceptable = (license) => license.replace(/[()]/g, "").split(/\s+OR\s+/).some((option) => LICENSE_ALLOW.has(option.trim()));
const badLicense = Object.entries(licenses).filter(([, l]) => !acceptable(l));
if (badLicense.length) fail(`dependency licenses outside the allowlist: ${badLicense.map(([n, l]) => `${n} (${l})`).join(", ")}`);

// 4. No private paths, internal modules or secrets in the shipped code.
const code = files.filter((f) => f.endsWith(".js")).map((f) => [f, readFileSync(join(installed, f), "utf8")]);
const FORBIDDEN = [
    [/[A-Z]:\\\\?Project/i, "a local repository path"],
    [/tomverse-private/i, "a private repository name"],
    [/from ["']@\/lib|["']server-only["']|@prisma\/client|next\/server/, "a server-only import"],
    [/\bamux\b/i, "internal agent infrastructure"],
    [/tvk_[0-9a-z]{8}_[A-Za-z0-9_-]{43}/, "an API key"],
    [/sk-[A-Za-z0-9]{20,}/, "a provider key"],
    [/sourceMappingURL/, "a source map reference"],
];
for (const [file, text] of code) for (const [pattern, what] of FORBIDDEN) if (pattern.test(text)) fail(`${file} contains ${what}`);
// A CR anywhere breaks the shebang on macOS and Linux ("env: node\r"), which a
// tarball packed on a Windows clone with autocrlf would otherwise carry.
for (const [file, text] of code) if (text.includes("\r")) fail(`${file} has CR line endings`);
if (!code.find(([f]) => f === "dist/cli.js")[1].startsWith("#!/usr/bin/env node\n")) fail("dist/cli.js does not start with '#!/usr/bin/env node'");
if (manifest.private) fail("the manifest is still private");
if (manifest.license !== "SEE LICENSE IN LICENSE") fail(`license field is ${JSON.stringify(manifest.license)}, expected "SEE LICENSE IN LICENSE"`);
if (!readFileSync(join(installed, "LICENSE"), "utf8").includes("Tomverse CLI License")) fail("LICENSE is not the Tomverse CLI license");
if (manifest.publishConfig?.access !== "public") fail("publishConfig.access must be public for a scoped package");
if (manifest.engines?.node !== ">=22") fail(`engines.node is ${JSON.stringify(manifest.engines?.node)}`);

// 5. The bin shim and the process suite against the installed copy.
const shim = join(project, "node_modules", ".bin", process.platform === "win32" ? "tomverse.cmd" : "tomverse");
if (!existsSync(shim)) fail("no tomverse bin shim was installed");
const version = spawnSync(shim, ["--version"], { encoding: "utf8", shell: process.platform === "win32" }).stdout.trim();
if (version !== manifest.version) fail(`tomverse --version printed '${version}'`);
const suite = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", "tests/cli.process.test.ts"], {
    cwd: app,
    encoding: "utf8",
    env: { ...process.env, TOMVERSE_CLI_BIN: join(installed, "dist", "cli.js") },
});
const summary = (suite.stdout.match(/^# (pass|fail) \d+$/gm) ?? []).join(", ");
if (suite.status !== 0) fail(`process tests against the installed package: ${summary}\n${suite.stdout.slice(-3000)}`);

const report = {
    package: `${manifest.name}@${manifest.version}`,
    tarball,
    sha256,
    files,
    unpackedSize: packed.unpackedSize,
    runtimeDependencies: manifest.dependencies,
    licenses,
    platform: `${process.platform} ${process.arch} node ${process.versions.node}`,
    processTests: summary,
    license: manifest.license,
    published: false,
};
writeFileSync(join(work, "pack-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, licenses: `${Object.keys(licenses).length} packages, all allowlisted` }, null, 2));
console.log(`pack-verify OK. Report: ${join(work, "pack-report.json")}`);
