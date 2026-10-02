import { AMUX_V4_LOCAL_BRIDGE_SOURCE } from "./ideaLocalBridgeSource.mjs";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

const SOCKET_DIRECTORY = /^\/tmp\/amux-v4-[A-Za-z0-9-]{1,80}$/;
const EXECUTABLE = /^\/usr\/(?:bin|local\/bin)\/(?:node|codex|claude)$/;

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
export function amuxV4SandboxArgs(socketDirectory, command) {
  if (typeof socketDirectory !== "string" || !SOCKET_DIRECTORY.test(socketDirectory) ||
      !Array.isArray(command) || command.length < 1 || command.length > 32 ||
      !EXECUTABLE.test(command[0])) {
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
    "--dir", "/run", "--ro-bind", socketDirectory, "/run/amux",
    "--chdir", "/tmp",
    "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp",
    "--setenv", "HTTPS_PROXY", "http://127.0.0.1:3128",
    "--", "/usr/bin/node", "-e", AMUX_V4_LOCAL_BRIDGE_SOURCE,
    "--", ...command,
  ];
}

/** The execution entry point. Do not spawn from the pure argument builder:
 * it cannot prove the socket is still private on the local Ubuntu host. */
export async function amuxV4VerifiedSandboxArgs(socketDirectory, command) {
  await verifyAmuxV4SandboxSocket(socketDirectory);
  return amuxV4SandboxArgs(socketDirectory, command);
}
