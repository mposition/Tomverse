import { planAmuxTrackedCheckoutClaudeCli } from "./ideaTrackedCheckoutCli.ts";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { verifyAmuxV4CliAuthSource, verifyAmuxV4SandboxSocket,
  verifyAmuxV4StagedCliBinary } from "./ideaLocalSandboxArgs.mjs";

const SOCKET_DIRECTORY = /^\/tmp\/amux-v4-[A-Za-z0-9-]{1,80}$/;
const STAGED_CLAUDE = /^\/tmp\/amux-v4-cli-[A-Za-z0-9-]{1,80}\/claude$/;
const AUTH_PATH = "/home/tommy/.amux-cli-profiles/claude-api/anthropic-api-key";
const SHA256 = /^[a-f0-9]{64}$/;

/** The v19 child keeps the prepared checkout as cwd. The v4 bridge forces
 * cwd=/tmp, so it cannot be reused for direct repository reads. No Git
 * credential or shell is present in this namespace. */
export const AMUX_V19_LOCAL_BRIDGE_SOURCE = String.raw`
const net = require("node:net");
const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const cwd = process.cwd();
const [executable, ...args] = process.argv.slice(1);
if (!/^\/tmp\/amux-v19-checkout-[A-Za-z0-9]{6}$/.test(cwd) ||
    executable !== "/run/amux-cli/claude" ||
    !args.includes("--bare") || !args.includes("--restricted")) {
  process.stderr.write("bridge_command_invalid\n");
  process.exit(2);
}
const sockets = new Set();
const server = net.createServer((client) => {
  const upstream = net.connect("/run/amux/proxy.sock");
  sockets.add(client); sockets.add(upstream);
  client.pipe(upstream); upstream.pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => { sockets.delete(client); upstream.destroy(); });
  upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
});
server.maxConnections = 16;
server.listen(3128, "127.0.0.1", () => {
  const env = { ...process.env };
  try {
    const key = readFileSync("/run/amux-cli/anthropic-api-key", "utf8").trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{24,512}$/.test(key)) throw new Error("invalid_key");
    env.ANTHROPIC_API_KEY = key;
  } catch {
    process.stderr.write("bridge_auth_unavailable\n");
    process.exitCode = 2;
    server.close();
    return;
  }
  const child = spawn(executable, args, { shell: false, stdio: "inherit", env, cwd });
  delete env.ANTHROPIC_API_KEY;
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    for (const socket of sockets) socket.destroy();
    server.close(() => { process.exitCode = code; });
  };
  child.once("error", () => finish(1));
  child.once("close", (code, signal) =>
    finish(signal ? 1 : (code === null || code === undefined ? 1 : code)));
});
server.once("error", () => {
  process.stderr.write("bridge_listen_failed\n");
  process.exitCode = 1;
});
`;

/** Build an isolated read-only mount for an already scanned checkout. This
 * pure builder grants no live invocation; the Ubuntu supervisor must verify
 * the socket, staged binary, auth source and checkout before spawning bwrap. */
export function planAmuxTrackedCheckoutSandbox(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      !SOCKET_DIRECTORY.test(input.socketDirectory) ||
      !STAGED_CLAUDE.test(input.cliMount?.path) ||
      !SHA256.test(input.cliMount?.sha256) ||
      input.authPath !== AUTH_PATH) {
    throw new TypeError("invalid tracked checkout sandbox");
  }
  const cli = planAmuxTrackedCheckoutClaudeCli({
    directory: input.checkoutDirectory,
    modelId: input.modelId,
    reasoningEffort: input.reasoningEffort,
  });
  return Object.freeze({
    cli,
    args: Object.freeze([
      "--unshare-all", "--die-with-parent", "--cap-drop", "ALL", "--clearenv",
      "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--dir", "/run", "--dir", "/run/amux-cli", "--dir", "/tmp/.claude",
      "--ro-bind", input.cliMount.path, cli.binary,
      "--ro-bind", input.authPath, "/run/amux-cli/anthropic-api-key",
      "--dir", "/etc", "--dir", "/etc/ssl",
      "--ro-bind", "/etc/ssl/certs", "/etc/ssl/certs",
      "--ro-bind", input.socketDirectory, "/run/amux",
      "--dir", cli.cwd, "--ro-bind", input.checkoutDirectory, cli.cwd,
      "--chdir", cli.cwd,
      "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp",
      "--setenv", "HTTPS_PROXY", "http://127.0.0.1:3128",
      "--setenv", "HTTP_PROXY", "http://127.0.0.1:3128",
      "--setenv", "SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt",
      "--setenv", "CLAUDE_CONFIG_DIR", "/tmp/.claude",
      "--setenv", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1",
      "--setenv", "CLAUDE_CODE_MAX_RETRIES", "0",
      "--", "/usr/bin/node", "-e", AMUX_V19_LOCAL_BRIDGE_SOURCE,
      "--", cli.binary, ...cli.args,
    ]),
  });
}

async function verifyPreparedCheckout(prepared) {
  if (process.platform !== "linux" || typeof process.getuid !== "function" ||
      !prepared || typeof prepared !== "object" ||
      !Array.isArray(prepared.files))
    throw new TypeError("unsafe tracked checkout");
  const directory = prepared.directory;
  planAmuxTrackedCheckoutClaudeCli({ directory, modelId: "claude-validation",
    reasoningEffort: "high" });
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink() ||
      root.uid !== process.getuid() || (root.mode & 0o777) !== 0o700 ||
      await realpath(directory) !== directory)
    throw new TypeError("unsafe tracked checkout");
  const expected = new Set(prepared.files);
  if (expected.size !== prepared.files.length) throw new TypeError("unsafe tracked checkout");
  const found = new Set();
  const pending = [directory];
  while (pending.length > 0) {
    const parent = pending.pop();
    for (const entry of await readdir(parent)) {
      const absolute = join(parent, entry);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || stat.uid !== process.getuid())
        throw new TypeError("unsafe tracked checkout");
      if (stat.isDirectory()) {
        if ((stat.mode & 0o777) !== 0o700) throw new TypeError("unsafe tracked checkout");
        pending.push(absolute);
      } else if (stat.isFile()) {
        const path = relative(directory, absolute);
        if ((stat.mode & 0o777) !== 0o400 || !expected.has(path))
          throw new TypeError("unsafe tracked checkout");
        found.add(path);
      } else throw new TypeError("unsafe tracked checkout");
    }
  }
  if (found.size !== expected.size) throw new TypeError("unsafe tracked checkout");
}

/** The host boundary verifies every mount immediately before bwrap starts.
 * The caller keeps the staged checkout alive through this call and the CLI
 * attempt, and removes it when the attempt settles. */
export async function verifiedAmuxTrackedCheckoutSandbox(input, prepared) {
  const planned = planAmuxTrackedCheckoutSandbox(input);
  if (prepared?.directory !== planned.cli.cwd)
    throw new TypeError("unsafe tracked checkout");
  await Promise.all([
    verifyAmuxV4SandboxSocket(input.socketDirectory),
    verifyAmuxV4StagedCliBinary(input.cliMount),
    verifyAmuxV4CliAuthSource(input.authPath),
    verifyPreparedCheckout(prepared),
  ]);
  return planned.args;
}
