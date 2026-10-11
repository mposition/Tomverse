// Produce an immutable, single-file candidate from the reviewed local source.
// This never enables dispatch or chooses an operational installation path.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { build, version as esbuildVersion } from "esbuild";
import { builtinOnlyRequireBanner } from
  "./prompt-refiner-vnext-one-shot-runner-banner.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = "0.1.0-candidate.3";
const name = `prompt-refiner-vnext-one-shot-runner-${version}`;
const packagePath = resolve(root, "bin", `${name}.mjs.gz`);
const recordPath = resolve(root, "bin", `${name}.json`);
const a15Commit = "256e087d503151ea1ebdf812b1c6e52a5cfb6d77";
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
const verifyOnly = process.argv.length === 3 && process.argv[2] === "--verify";
if (!verifyOnly && process.argv.length !== 2) {
  throw new Error("runner_candidate_mode_invalid");
}

if (git("status", "--porcelain", "--untracked-files=no") !== "") {
  throw new Error("runner_candidate_source_dirty");
}
if (git("merge-base", "HEAD", a15Commit) !== a15Commit) {
  throw new Error("runner_candidate_a15_base_mismatch");
}
if (esbuildVersion !== "0.28.1") {
  throw new Error("runner_candidate_builder_version_mismatch");
}

const bundle = await build({
  absWorkingDir: root,
  entryPoints: ["scripts/prompt-refiner-vnext-one-shot-owner-runner.mjs"],
  outfile: resolve(root, "bin", `${name}.mjs`),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  conditions: ["react-server"],
  alias: { "@": root },
  packages: "bundle",
  legalComments: "inline",
  banner: { js: `/* eslint-disable */\n// ${name}; candidate only.\n${builtinOnlyRequireBanner}\n` },
  write: false,
  metafile: true,
  logLevel: "silent",
});
if (bundle.outputFiles.length !== 1) {
  throw new Error("runner_candidate_output_count_invalid");
}
const runnerBytes = bundle.outputFiles[0].contents;
const packageBytes = gzipSync(runnerBytes, { level: 9, mtime: 0 });
const existing = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : null;
if (verifyOnly && !existing) {
  throw new Error("runner_candidate_missing");
}
const sourceCommit = existing?.sourceCommit ?? git("rev-parse", "HEAD");
const inputs = Object.keys(bundle.metafile.inputs).map((input) => {
  const absolute = resolve(root, input);
  const path = relative(root, absolute).split(sep).join("/");
  if (path === ".." || path.startsWith("../") || path.startsWith("/")) {
    throw new Error("runner_candidate_input_outside_repository");
  }
  const digest = path.startsWith("node_modules/")
    ? sha256(readFileSync(absolute))
    : sourceSha256(readFileSync(absolute));
  if (!path.startsWith("node_modules/") &&
      sourceSha256(gitBytes(path, sourceCommit)) !== digest) {
    throw new Error("runner_candidate_source_commit_drift");
  }
  return [path, digest];
}).sort(([left], [right]) => left.localeCompare(right, "en"));
const inputSha256 = sha256(Buffer.from(inputs
  .map(([path, digest]) => `${path}\0${digest}\n`).join(""), "utf8"));
const runnerSha256 = sha256(runnerBytes);
const packageSha256 = sha256(packageBytes);
const lockSha256 = sourceSha256(readFileSync(resolve(root, "package-lock.json")));
if (sourceSha256(gitBytes("package-lock.json", sourceCommit)) !== lockSha256) {
  throw new Error("runner_candidate_lockfile_commit_drift");
}
const record = {
  schemaVersion: 1,
  version,
  status: "candidate_only",
  b01FinalDigest: false,
  dispatchAuthority: false,
  verificationBoundary: "owner_checksum_and_runner_self_check_not_server_attestation",
  a15BaseCommit: a15Commit,
  sourceCommit,
  builder: `esbuild@${esbuildVersion}`,
  nodeMajor: 22,
  packageLockSha256: lockSha256,
  bundledInputSha256: inputSha256,
  runnerSha256,
  packageSha256,
  packageFile: `bin/${name}.mjs.gz`,
  executableFile: `${name}.mjs`,
};
const recordBytes = Buffer.from(JSON.stringify(record, null, 2) + "\n", "utf8");
if (existing) {
  if (!existsSync(packagePath) ||
      !readFileSync(packagePath).equals(packageBytes) ||
      !readFileSync(recordPath).equals(recordBytes)) {
    throw new Error("runner_candidate_bytes_changed_repin_required");
  }
  process.stdout.write(JSON.stringify({ status: "candidate_bytes_verified",
    version, packageSha256, runnerSha256, sourceCommit }) + "\n");
} else {
  if (existsSync(packagePath)) {
    throw new Error("runner_candidate_partial_output");
  }
  mkdirSync(dirname(packagePath), { recursive: true });
  writeFileSync(packagePath, packageBytes, { flag: "wx" });
  writeFileSync(recordPath, recordBytes, { flag: "wx" });
  process.stdout.write(JSON.stringify({ status: "candidate_built",
    version, packageSha256, runnerSha256, sourceCommit }) + "\n");
}
