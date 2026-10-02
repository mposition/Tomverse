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

const validCliMount = (command, mount) => {
  if (command[0] === "/usr/bin/node") return mount === undefined;
  if (!mount || typeof mount !== "object" || Array.isArray(mount) ||
      Reflect.ownKeys(mount).length !== 2 ||
      !Object.hasOwn(mount, "path") || !Object.hasOwn(mount, "sha256") ||
      typeof mount.path !== "string" || typeof mount.sha256 !== "string" ||
      !SHA256.test(mount.sha256)) return false;
  const match = STAGED_CLI.exec(mount.path);
  return match !== null && command[0] === `/run/amux-cli/${match[1]}`;
};

/** The local supervisor copies one operator-approved CLI binary into this
 * private directory and pins its expected digest. No auth/config path is
 * mounted by this S0 boundary. */
export async function verifyAmuxV4StagedCliBinary(mount) {
  if (process.platform !== "linux" || !mount || typeof mount !== "object" ||
      Array.isArray(mount) || Reflect.ownKeys(mount).length !== 2 ||
      !Object.hasOwn(mount, "path") || !Object.hasOwn(mount, "sha256") ||
      typeof mount.path !== "string" || typeof mount.sha256 !== "string" ||
      !STAGED_CLI.test(mount.path) || !SHA256.test(mount.sha256) ||
      typeof process.getuid !== "function") {
    throw new TypeError("invalid AMUX v4 CLI binary mount");
  }
  const parentPath = mount.path.slice(0, mount.path.lastIndexOf("/"));
  const [parent, binary, realParent, realBinary] = await Promise.all([
    lstat(parentPath), lstat(mount.path), realpath(parentPath), realpath(mount.path),
  ]);
  if (!parent.isDirectory() || parent.uid !== process.getuid() ||
      (parent.mode & 0o777) !== 0o700 || realParent !== parentPath ||
      !binary.isFile() || binary.uid !== process.getuid() ||
      (binary.mode & 0o777) !== 0o500 || binary.size < 1 ||
      binary.size > MAX_CLI_BYTES || realBinary !== mount.path) {
    throw new TypeError("unsafe AMUX v4 CLI binary mount");
  }
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(mount.path)) hash.update(bytes);
  if (hash.digest("hex") !== mount.sha256) {
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
  if (typeof socketDirectory !== "string" || !SOCKET_DIRECTORY.test(socketDirectory) ||
      !Array.isArray(command) || command.length < 1 || command.length > 32 ||
      !EXECUTABLE.test(command[0]) || !validCliMount(command, cliMount)) {
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
    ...(cliMount ? ["--dir", "/run/amux-cli", "--ro-bind", cliMount.path, command[0]] : []),
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
  if (!validCliMount(command, cliMount)) {
    throw new TypeError("invalid AMUX v4 CLI binary mount");
  }
  if (cliMount) await verifyAmuxV4StagedCliBinary(cliMount);
  return amuxV4SandboxArgs(socketDirectory, command, cliMount);
}
