// Rebuild the final single-file runner from the exact merged source commit.
// Output stays outside the repository and grants no dispatch authority.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { build, version as esbuildVersion } from "esbuild";
import { builtinOnlyRequireBanner } from
  "./prompt-refiner-vnext-one-shot-runner-banner.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = "0.1.0";
const name = `prompt-refiner-vnext-one-shot-runner-${version}`;
const [mode, sourceCommit, outputArgument] = process.argv.slice(2);
if (process.argv.length !== 5 || !["--build", "--verify"].includes(mode) ||
    !/^[0-9a-f]{40}$/.test(sourceCommit ?? "") || !outputArgument) {
  throw new Error("runner_final_usage_invalid");
}
const outputDir = resolve(outputArgument);
const outputRelative = relative(root, outputDir);
if (outputRelative === "" ||
    (!isAbsolute(outputRelative) && outputRelative !== ".." &&
      !outputRelative.startsWith(`..${sep}`) &&
      !outputRelative.startsWith("/"))) {
  throw new Error("runner_final_output_inside_repository");
}
const packagePath = resolve(outputDir, `${name}.mjs.gz`);
const recordPath = resolve(outputDir, `${name}.json`);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceSha256 = (bytes) => {
  const normalized = Buffer.allocUnsafe(bytes.length);
  let count = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) continue;
    normalized[count++] = bytes[i];
  }
  return sha256(normalized.subarray(0, count));
};
const git = (...args) => execFileSync("git", args, {
  cwd: root, encoding: "utf8", windowsHide: true,
}).trim();
const gitBytes = (path, commit) => execFileSync("git", ["show", `${commit}:${path}`], {
  cwd: root, windowsHide: true,
});
if (git("status", "--porcelain", "--untracked-files=no") !== "") {
  throw new Error("runner_final_source_dirty");
}
if (git("rev-parse", "HEAD") !== sourceCommit ||
    git("merge-base", sourceCommit, "origin/develop") !== sourceCommit) {
  throw new Error("runner_final_source_not_merged_develop_commit");
}
if (esbuildVersion !== "0.28.1") {
  throw new Error("runner_final_builder_version_mismatch");
}
if (Number.parseInt(process.versions.node.split(".", 1)[0], 10) !== 22) {
  throw new Error("runner_final_node_major_mismatch");
}

const bundle = await build({
  absWorkingDir: root,
  entryPoints: ["scripts/prompt-refiner-vnext-one-shot-owner-runner.mjs"],
  outfile: resolve(outputDir, `${name}.mjs`),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  conditions: ["react-server"],
  alias: { "@": root },
  packages: "bundle",
  legalComments: "inline",
  banner: { js: `/* eslint-disable */\n// ${name}; exact merged source.\n${builtinOnlyRequireBanner}\n` },
  write: false,
  metafile: true,
  logLevel: "silent",
});
if (bundle.outputFiles.length !== 1) {
  throw new Error("runner_final_output_count_invalid");
}
const runnerBytes = bundle.outputFiles[0].contents;
const packageBytes = gzipSync(runnerBytes, { level: 9, mtime: 0 });
const existing = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : null;
if (mode === "--verify" && !existing) {
  throw new Error("runner_final_missing");
}
const inputs = Object.keys(bundle.metafile.inputs).map((input) => {
  const absolute = resolve(root, input);
  const path = relative(root, absolute).split(sep).join("/");
  if (path === ".." || path.startsWith("../") || path.startsWith("/")) {
    throw new Error("runner_final_input_outside_repository");
  }
  const digest = path.startsWith("node_modules/")
    ? sha256(readFileSync(absolute))
    : sourceSha256(readFileSync(absolute));
  if (!path.startsWith("node_modules/") &&
      sourceSha256(gitBytes(path, sourceCommit)) !== digest) {
    throw new Error("runner_final_source_commit_drift");
  }
  return [path, digest];
}).sort(([left], [right]) => left.localeCompare(right, "en"));
const inputSha256 = sha256(Buffer.from(inputs
  .map(([path, digest]) => `${path}\0${digest}\n`).join(""), "utf8"));
const runnerSha256 = sha256(runnerBytes);
const packageSha256 = sha256(packageBytes);
const lockSha256 = sourceSha256(readFileSync(resolve(root, "package-lock.json")));
if (sourceSha256(gitBytes("package-lock.json", sourceCommit)) !== lockSha256) {
  throw new Error("runner_final_lockfile_commit_drift");
}
const record = {
  schemaVersion: 1,
  version,
  status: "rebuilt_from_merged_source",
  b01PreregistrationPerformed: false,
  dispatchAuthority: false,
  verificationBoundary: "owner_checksum_and_runner_self_check_not_server_attestation",
  sourceCommit,
  builder: `esbuild@${esbuildVersion}`,
  nodeMajor: 22,
  packageLockSha256: lockSha256,
  bundledInputSha256: inputSha256,
  runnerSha256,
  packageSha256,
  packageFile: `${name}.mjs.gz`,
  executableFile: `${name}.mjs`,
};
const recordBytes = Buffer.from(JSON.stringify(record, null, 2) + "\n", "utf8");
if (existing) {
  if (mode === "--build") {
    throw new Error("runner_final_already_built");
  }
  if (!existsSync(packagePath) ||
      !readFileSync(packagePath).equals(packageBytes) ||
      !readFileSync(recordPath).equals(recordBytes)) {
    throw new Error("runner_final_bytes_changed");
  }
  process.stdout.write(JSON.stringify({ status: "final_bytes_verified",
    version, packageSha256, runnerSha256, sourceCommit }) + "\n");
} else {
  if (mode === "--verify") {
    throw new Error("runner_final_missing");
  }
  if (existsSync(packagePath)) {
    throw new Error("runner_final_partial_output");
  }
  mkdirSync(dirname(packagePath), { recursive: true });
  writeFileSync(packagePath, packageBytes, { flag: "wx" });
  writeFileSync(recordPath, recordBytes, { flag: "wx" });
  process.stdout.write(JSON.stringify({ status: "final_built",
    version, packageSha256, runnerSha256, sourceCommit }) + "\n");
}
