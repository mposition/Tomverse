import { AMUX_V4_LOCAL_BRIDGE_SOURCE } from "./ideaLocalBridgeSource.mjs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { planAmuxV4AnalysisCliInvocation } from "./ideaLocalCliContract.mjs";
import { AMUX_V4_CODEX_CATALOG_SANDBOX_PATH,
  amuxV4CodexNoToolsCatalogJson } from "./ideaLocalCodexNoToolsCore.mjs";

const SOCKET_DIRECTORY = /^\/tmp\/amux-v4-[A-Za-z0-9-]{1,80}$/;
const EXECUTABLE = /^(?:\/usr\/bin\/node|\/run\/amux-cli\/(?:codex|claude))$/;
const STAGED_CLI = /^\/tmp\/amux-v4-cli-[A-Za-z0-9-]{1,80}\/(codex|claude)$/;
const CLI_PROFILE_ROOT = "/home/tommy/.amux-cli-profiles";
const CLI_PROFILE = Object.freeze({
  openai: `${CLI_PROFILE_ROOT}/codex`,
  anthropic: `${CLI_PROFILE_ROOT}/claude-api`,
});
const CLI_AUTH = Object.freeze({
  openai: `${CLI_PROFILE.openai}/auth.json`,
  anthropic: `${CLI_PROFILE.anthropic}/anthropic-api-key`,
});
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_CLI_BYTES = 512 * 1024 * 1024;

const snapshotCliMount = (mount) => {
  if (!mount || typeof mount !== "object" || Array.isArray(mount)) return null;
  try {
    const fields = Object.getOwnPropertyDescriptors(mount);
    if (Reflect.ownKeys(fields).length !== 2 ||
        !("value" in (fields.path ?? {})) ||
        !("value" in (fields.sha256 ?? {}))) return null;
    const path = fields.path.value;
    const sha256 = fields.sha256.value;
    return typeof path === "string" && typeof sha256 === "string" &&
      STAGED_CLI.test(path) && SHA256.test(sha256) ? { path, sha256 } : null;
  } catch { return null; }
};

const snapshotAnalysis = (analysis) => {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) return null;
  try {
    const fields = Object.getOwnPropertyDescriptors(analysis);
    if (Reflect.ownKeys(fields).length !== 4 ||
        !["provider", "modelId", "reasoningEffort", "authPath"]
          .every((key) => "value" in (fields[key] ?? {}))) return null;
    const provider = fields.provider.value;
    const modelId = fields.modelId.value;
    const reasoningEffort = fields.reasoningEffort.value;
    const authPath = fields.authPath.value;
    const plan = planAmuxV4AnalysisCliInvocation({ provider, modelId, reasoningEffort });
    if (!plan || authPath !== CLI_AUTH[provider]) return null;
    return { plan, authPath };
  } catch { return null; }
};

const validCliMount = (command, mount, analysis) => {
  if (!Array.isArray(command) || command.length < 1) return false;
  if (command[0] === "/usr/bin/node") return mount === undefined && analysis === undefined;
  const snapshot = snapshotCliMount(mount);
  if (!snapshot) return false;
  const match = STAGED_CLI.exec(snapshot.path);
  if (match === null || command[0] !== `/run/amux-cli/${match[1]}`) return false;
  if (analysis === undefined) return command.length === 2 && command[1] === "--version";
  return match[1] === (analysis.plan.provider === "openai" ? "codex" : "claude") &&
    command.length === analysis.plan.command.length &&
    command.every((argument, index) => argument === analysis.plan.command[index]);
};

/** S0 checks a private staged copy against the caller's expected digest.
 * The probe computes that digest itself; it is not operator approval. A live
 * runner requires a separate trusted catalog and admission contract. */
export async function verifyAmuxV4StagedCliBinary(mount) {
  const safeMount = snapshotCliMount(mount);
  if (process.platform !== "linux" || !safeMount || typeof process.getuid !== "function") {
    throw new TypeError("invalid AMUX v4 CLI binary mount");
  }
  const parentPath = safeMount.path.slice(0, safeMount.path.lastIndexOf("/"));
  const [parent, binary, realParent, realBinary] = await Promise.all([
    lstat(parentPath), lstat(safeMount.path), realpath(parentPath), realpath(safeMount.path),
  ]);
  if (!parent.isDirectory() || parent.uid !== process.getuid() ||
      (parent.mode & 0o777) !== 0o700 || realParent !== parentPath ||
      !binary.isFile() || binary.nlink !== 1 || binary.uid !== process.getuid() ||
      (binary.mode & 0o777) !== 0o500 || binary.size < 1 ||
      binary.size > MAX_CLI_BYTES || realBinary !== safeMount.path) {
    throw new TypeError("unsafe AMUX v4 CLI binary mount");
  }
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(safeMount.path)) hash.update(bytes);
  if (hash.digest("hex") !== safeMount.sha256) {
    throw new TypeError("AMUX v4 CLI binary digest changed");
  }
}

/** The operator logs in separately to this AMUX-only mutable profile. Never
 * copy the main tommy OAuth secret or mount the primary CLI config root. */
export async function verifyAmuxV4CliAuthSource(authPath) {
  if (process.platform !== "linux" || typeof authPath !== "string" ||
      !Object.values(CLI_AUTH).includes(authPath) ||
      typeof process.getuid !== "function") {
    throw new TypeError("invalid AMUX v4 CLI auth mount");
  }
  const provider = Object.keys(CLI_AUTH).find((key) => CLI_AUTH[key] === authPath);
  const profilePath = CLI_PROFILE[provider];
  const [root, profile, auth, realRoot, realProfile, realAuth] = await Promise.all([
    lstat(CLI_PROFILE_ROOT), lstat(profilePath), lstat(authPath),
    realpath(CLI_PROFILE_ROOT), realpath(profilePath), realpath(authPath),
  ]);
  if (!root.isDirectory() || root.uid !== process.getuid() ||
      (root.mode & 0o777) !== 0o700 || realRoot !== CLI_PROFILE_ROOT ||
      !profile.isDirectory() || profile.uid !== process.getuid() ||
      (profile.mode & 0o777) !== 0o700 || realProfile !== profilePath) {
    throw new TypeError("unsafe AMUX v4 dedicated CLI profile");
  }
  if (!auth.isFile() || auth.nlink !== 1 || auth.uid !== process.getuid() ||
      (auth.mode & 0o777) !== 0o600 || auth.size < 1 || auth.size > 131_072 ||
      realAuth !== authPath) {
    throw new TypeError("unsafe AMUX v4 CLI auth mount");
  }
}

async function verifyAmuxV4CodexCatalog(cliPath, modelId) {
  const catalogPath = join(dirname(cliPath), "model-catalog.json");
  const [stat, canonical, content] = await Promise.all([
    lstat(catalogPath), realpath(catalogPath), readFile(catalogPath, "utf8"),
  ]);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o400 || canonical !== catalogPath ||
      content !== amuxV4CodexNoToolsCatalogJson(modelId)) {
    throw new TypeError("unsafe AMUX v4 Codex tool catalog");
  }
}

/** Fail before bwrap sees a socket path which has become a symlink or an
 * accessible host directory. The caller still owns the directory lifecycle. */
export async function verifyAmuxV4SandboxSocket(socketDirectory) {
  if (process.platform !== "linux" || typeof socketDirectory !== "string" ||
      !SOCKET_DIRECTORY.test(socketDirectory) ||
      typeof process.getuid !== "function") {
    throw new TypeError("invalid AMUX v4 sandbox socket directory");
  }
  const socketPath = join(socketDirectory, "proxy.sock");
  const [directory, socket, canonicalDirectory, canonicalSocket] = await Promise.all([
    lstat(socketDirectory), lstat(socketPath), realpath(socketDirectory),
    realpath(socketPath),
  ]);
  if (!directory.isDirectory() || directory.uid !== process.getuid() ||
      (directory.mode & 0o777) !== 0o700 ||
      !socket.isSocket() || socket.uid !== process.getuid() ||
      (socket.mode & 0o777) !== 0o600 ||
      canonicalDirectory !== socketDirectory || canonicalSocket !== socketPath) {
    throw new TypeError("unsafe AMUX v4 sandbox socket");
  }
}

/** Fixed, shell-free namespace boundary shared by the synthetic S0 probe and
 * a future local runner. The caller must create and verify the private socket
 * directory; these arguments alone do not authorize a model call. */
export function amuxV4SandboxArgs(socketDirectory, command, cliMount, analysisMount) {
  const safeMount = cliMount === undefined ? undefined : snapshotCliMount(cliMount);
  const analysis = analysisMount === undefined ? undefined : snapshotAnalysis(analysisMount);
  if (typeof socketDirectory !== "string" || !SOCKET_DIRECTORY.test(socketDirectory) ||
      !Array.isArray(command) || command.length < 1 || command.length > 96 ||
      !EXECUTABLE.test(command[0]) ||
      (analysisMount !== undefined && !analysis) ||
      !validCliMount(command, safeMount, analysis)) {
    throw new TypeError("invalid AMUX v4 sandbox configuration");
  }
  for (let index = 0; index < command.length; index += 1) {
    const argument = command[index];
    if (!Object.hasOwn(command, index) || typeof argument !== "string" ||
        argument.includes("\0") || Buffer.byteLength(argument, "utf8") > 8_192) {
      throw new TypeError("invalid AMUX v4 sandbox configuration");
    }
  }
  return [
    // The supervisor starts bwrap in its own process group and kills that
    // group at the deadline. Do not create a second session inside bwrap.
    "--unshare-all", "--die-with-parent",
    "--cap-drop", "ALL", "--clearenv",
    "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--dir", "/run",
    ...(safeMount ? ["--dir", "/run/amux-cli", "--ro-bind", safeMount.path, command[0]] : []),
    ...(safeMount && analysis?.plan.provider === "openai" ? ["--ro-bind",
      join(dirname(safeMount.path), "model-catalog.json"),
      AMUX_V4_CODEX_CATALOG_SANDBOX_PATH] : []),
    ...(analysis ? ["--dir", analysis.plan.provider === "openai" ? "/tmp/.codex" : "/tmp/.claude",
      // Codex retains its dedicated mutable OAuth file. Claude --bare sees
      // only a read-only AMUX API key; no host settings, hooks or plugins.
      analysis.plan.provider === "openai" ? "--bind" : "--ro-bind",
      analysis.authPath,
      analysis.plan.provider === "openai" ? "/tmp/.codex/auth.json" :
        "/run/amux-cli/anthropic-api-key",
      "--dir", "/etc", "--dir", "/etc/ssl",
      "--ro-bind", "/etc/ssl/certs", "/etc/ssl/certs"] : []),
    "--ro-bind", socketDirectory, "/run/amux",
    "--chdir", "/tmp",
    "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp",
    "--setenv", "HTTPS_PROXY", "http://127.0.0.1:3128",
    ...(analysis ? ["--setenv", "HTTP_PROXY", "http://127.0.0.1:3128",
      "--setenv", "SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt",
      ...(analysis.plan.provider === "openai"
        ? ["--setenv", "CODEX_HOME", "/tmp/.codex"]
        : ["--setenv", "CLAUDE_CONFIG_DIR", "/tmp/.claude",
          "--setenv", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1",
          "--setenv", "CLAUDE_CODE_MAX_RETRIES", "0",
          "--setenv", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "128000"])] : []),
    "--", "/usr/bin/node", "-e", AMUX_V4_LOCAL_BRIDGE_SOURCE,
    "--", ...command,
  ];
}

/** The execution entry point. Do not spawn from the pure argument builder:
 * it cannot prove the socket is still private on the local Ubuntu host. */
export async function amuxV4VerifiedSandboxArgs(socketDirectory, command, cliMount,
  analysisMount) {
  await verifyAmuxV4SandboxSocket(socketDirectory);
  const safeMount = cliMount === undefined ? undefined : snapshotCliMount(cliMount);
  const analysis = analysisMount === undefined ? undefined : snapshotAnalysis(analysisMount);
  if ((analysisMount !== undefined && !analysis) ||
      !validCliMount(command, safeMount, analysis)) {
    throw new TypeError("invalid AMUX v4 CLI binary mount");
  }
  if (safeMount) await verifyAmuxV4StagedCliBinary(safeMount);
  if (analysis) await verifyAmuxV4CliAuthSource(analysis.authPath);
  if (safeMount && analysis?.plan.provider === "openai") {
    await verifyAmuxV4CodexCatalog(safeMount.path, analysis.plan.modelId);
  }
  return amuxV4SandboxArgs(socketDirectory, command, safeMount, analysisMount);
}
