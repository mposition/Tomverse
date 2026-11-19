// Builds a standalone `tomverse` executable for the platform this runs on, for
// users without Node.js. It is a Node.js single executable application (SEA):
// dist/ bundled into one CommonJS file, injected into a copy of the running
// node binary. A SEA can only be built for the platform and architecture of the
// node that builds it, so each target is built on its own machine
// (.github/workflows/tomverse-cli-release-check.yml runs all six).
//
// Output in apps/tomverse-cli/release/:
//   tomverse-<version>-<os>-<arch>.zip (Windows) or .tar.gz (macOS, Linux)
//     holding the executable, LICENSE, README.md and THIRD_PARTY_NOTICES.txt
//   the same name + .sha256
// Nothing is uploaded or signed with a publisher identity; on macOS the binary
// gets an ad-hoc signature, which Apple silicon needs to run it at all.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const fail = (message) => {
    console.error(`build-binary FAILED: ${message}`);
    process.exit(1);
};
const run = (cmd, args, options = {}) => {
    const result = spawnSync(cmd, args, { encoding: "utf8", ...options });
    if (result.status !== 0) fail(`${cmd} ${args.join(" ")}\n${result.stdout ?? ""}\n${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`);
    return result.stdout;
};

const pkg = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
const os = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform];
if (!os) fail(`no standalone build for ${process.platform}; use the npm package`);
const target = `${os}-${process.arch}`;
const exeName = process.platform === "win32" ? "tomverse.exe" : "tomverse";
if (!existsSync(join(app, "dist", "cli.js"))) fail("dist/cli.js missing; run the build first.");

const out = join(app, "release");
const work = join(out, `work-${target}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// 1. One CommonJS file: a SEA's require() loads built-in modules only.
const esbuild = require("esbuild");
const bundle = join(work, "tomverse.cjs");
const built = esbuild.buildSync({
    entryPoints: [join(app, "dist", "cli.js")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: `node${process.versions.node.split(".")[0]}`,
    outfile: bundle,
    metafile: true,
    legalComments: "none",
    logLevel: "warning",
});
if (built.errors.length) fail("esbuild reported errors");
const text = readFileSync(bundle, "utf8").replace(/^#!.*\n/, "");
writeFileSync(bundle, text);
const required = [...text.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
const notBuiltin = [...new Set(required)].filter((id) => !isBuiltin(id));
if (notBuiltin.length) fail(`the bundle still requires non-built-in modules at run time: ${notBuiltin.join(", ")}`);

// 2. Notices for every bundled package (their licenses ask for it) and Node.js.
const packages = new Map();
for (const input of Object.keys(built.metafile.inputs)) {
    const parts = input.split(/[\\/]/);
    const at = parts.lastIndexOf("node_modules");
    if (at < 0) continue;
    const nameParts = parts[at + 1]?.startsWith("@") ? parts.slice(at + 1, at + 3) : parts.slice(at + 1, at + 2);
    const dir = join(process.cwd(), ...parts.slice(0, at + 1), ...nameParts);
    if (!packages.has(dir)) packages.set(dir, nameParts.join("/"));
}
const noticeFiles = (dir) => readdirSync(dir).filter((f) => /^(licen[cs]e|notice|copying)(\.|$)/i.test(f)).sort();
const notices = [];
const described = [...packages]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([dir]) => {
        const p = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        return { id: `${p.name}@${p.version}`, license: typeof p.license === "string" ? p.license : JSON.stringify(p.license), dir, files: noticeFiles(dir) };
    });
for (const pkgInfo of described) {
    const title = `${"=".repeat(78)}\n${pkgInfo.id} (${pkgInfo.license})\n${"=".repeat(78)}\n`;
    if (pkgInfo.files.length) {
        notices.push(`${title}${pkgInfo.files.map((f) => readFileSync(join(pkgInfo.dir, f), "utf8").trim()).join("\n\n")}\n`);
        continue;
    }
    // A package that ships no license file: its license text is the one another
    // bundled package under the same (permissive, notice-free) license ships.
    const same = described.find((o) => o.license === pkgInfo.license && o.files.length);
    if (!same || !/^(Apache-2\.0)$/.test(pkgInfo.license)) fail(`${pkgInfo.id} (${pkgInfo.license}) has no license file to reproduce`);
    notices.push(`${title}This package ships no license file. It is licensed under ${pkgInfo.license}; the full license text is reproduced above or below under ${same.id}.\n`);
}
const nodeLicense = [join(dirname(process.execPath), "LICENSE"), join(dirname(process.execPath), "..", "LICENSE")].find(existsSync);
if (!nodeLicense) fail(`no LICENSE next to ${process.execPath}; build with an official Node.js distribution`);
notices.unshift(`${"=".repeat(78)}\nNode.js ${process.version} runtime (MIT and others)\n${"=".repeat(78)}\n${readFileSync(nodeLicense, "utf8").trim()}\n`);
const header = `Third-party software in the Tomverse CLI ${pkg.version} standalone executable (${target}).\nThe Tomverse CLI itself is licensed under LICENSE. Each component below is under its own license.\n\n`;
writeFileSync(join(work, "THIRD_PARTY_NOTICES.txt"), header + notices.join("\n"));

// 3. The SEA blob, injected into a copy of this node.
const config = join(work, "sea-config.json");
const blob = join(work, "sea-prep.blob");
writeFileSync(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }, null, 2));
run(process.execPath, ["--experimental-sea-config", config]);
const base = `tomverse-${pkg.version}-${target}`;
const stage = join(out, base);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const exe = join(stage, exeName);
copyFileSync(process.execPath, exe);
if (process.platform !== "win32") chmodSync(exe, 0o755);
if (process.platform === "darwin") run("codesign", ["--remove-signature", exe]);
const postject = ["--yes", "postject@1.0.0-alpha.6", exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
if (process.platform === "darwin") postject.push("--macho-segment-name", "NODE_SEA");
run("npx", postject, { shell: process.platform === "win32" });
if (process.platform === "darwin") run("codesign", ["--sign", "-", exe]);

// 4. It must run as itself, without node on PATH.
const noNode = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^path$/i.test(k) && !/^NODE_/.test(k)));
const version = run(exe, ["--version"], { env: { ...noNode, PATH: "" } }).trim();
if (version !== pkg.version) fail(`${exeName} --version printed '${version}', expected ${pkg.version}`);
const help = run(exe, ["--help"], { env: { ...noNode, PATH: "" } });
if (!help.includes("tomverse doctor")) fail(`${exeName} --help did not print the usage`);

// 5. Archive with the license files, and its checksum.
copyFileSync(join(app, "LICENSE"), join(stage, "LICENSE"));
copyFileSync(join(app, "README.md"), join(stage, "README.md"));
copyFileSync(join(work, "THIRD_PARTY_NOTICES.txt"), join(stage, "THIRD_PARTY_NOTICES.txt"));
const archive = join(out, `${base}${process.platform === "win32" ? ".zip" : ".tar.gz"}`);
rmSync(archive, { force: true });
const contents = [exeName, "LICENSE", "README.md", "THIRD_PARTY_NOTICES.txt"];
if (process.platform === "win32") {
    // bsdtar from Windows itself writes a zip with -a; Git's GNU tar on PATH cannot.
    run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-a", "-c", "-f", archive, "-C", stage, ...contents]);
} else {
    run("tar", ["-czf", archive, "-C", stage, ...contents]);
}
const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
const archiveName = relative(out, archive).split(sep).join("/");
writeFileSync(`${archive}.sha256`, `${sha256}  ${archiveName}\n`);
rmSync(work, { recursive: true, force: true });

console.log(JSON.stringify({ target, node: process.version, executable: exe, archive, sha256, bundledPackages: packages.size, published: false }, null, 2));
console.log(`build-binary OK: ${archive}`);
