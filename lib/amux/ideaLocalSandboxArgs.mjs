import { AMUX_V4_LOCAL_BRIDGE_SOURCE } from "./ideaLocalBridgeSource.mjs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

const SOCKET_DIRECTORY = /^\/tmp\/amux-v4-[A-Za-z0-9-]{1,80}$/;
const EXECUTABLE = /^(?:\/usr\/bin\/node|\/run\/amux-cli\/(?:codex|claude))$/;
const STAGED_CLI = /^\/tmp\/amux-v4-cli-[A-Za-z0-9-]{1,80}\/(codex|claude)$/;
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

const validCliMount = (command, mount) => {
  if (!Array.isArray(command) || command.length < 1) return false;
  if (command[0] === "/usr/bin/node") return mount === undefined;
  // This boundary is an S0 binary probe, not an analysis invocation. A live
  // CLI runner needs a separately reviewed command and admission contract.
  if (command.length !== 2 || command[1] !== "--version") return false;
  const snapshot = snapshotCliMount(mount);
  if (!snapshot) return false;
  const match = STAGED_CLI.exec(snapshot.path);
  return match !== null && command[0] === `/run/amux-cli/${match[1]}`;
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
export function amuxV4SandboxArgs(socketDirectory, command, cliMount) {
  const safeMount = cliMount === undefined ? undefined : snapshotCliMount(cliMount);
  if (typeof socketDirectory !== "string" || !SOCKET_DIRECTORY.test(socketDirectory) ||
      !Array.isArray(command) || command.length < 1 || command.length > 32 ||
      !EXECUTABLE.test(command[0]) || !validCliMount(command, safeMount)) {
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
    "--unshare-all", "--die-with-parent", "--new-session",
    "--cap-drop", "ALL", "--clearenv",
    "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--dir", "/run",
    ...(safeMount ? ["--dir", "/run/amux-cli", "--ro-bind", safeMount.path, command[0]] : []),
    "--ro-bind", socketDirectory, "/run/amux",
    "--chdir", "/tmp",
    "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp",
    "--setenv", "HTTPS_PROXY", "http://127.0.0.1:3128",
    "--", "/usr/bin/node", "-e", AMUX_V4_LOCAL_BRIDGE_SOURCE,
    "--", ...command,
  ];
}

/** The execution entry point. Do not spawn from the pure argument builder:
 * it cannot prove the socket is still private on the local Ubuntu host. */
export async function amuxV4VerifiedSandboxArgs(socketDirectory, command, cliMount) {
  await verifyAmuxV4SandboxSocket(socketDirectory);
  const safeMount = cliMount === undefined ? undefined : snapshotCliMount(cliMount);
  if (!validCliMount(command, safeMount)) {
    throw new TypeError("invalid AMUX v4 CLI binary mount");
  }
  if (safeMount) await verifyAmuxV4StagedCliBinary(safeMount);
  return amuxV4SandboxArgs(socketDirectory, command, safeMount);
}
