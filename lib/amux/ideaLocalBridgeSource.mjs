/** Shared, dependency-free program for the network-isolated Ubuntu child.
 * The supervising runner must choose and validate the executable/argv, mount
 * only the exact Unix socket, and enforce a process deadline. This bridge
 * grants no model or filesystem permission by itself. */
export const AMUX_V4_LOCAL_BRIDGE_SOURCE = String.raw`
const net = require("node:net");
const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const [executable, ...args] = process.argv.slice(1);
if (!executable || !executable.startsWith("/")) {
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
  if (executable === "/run/amux-cli/claude") {
    if (!args.includes("--bare")) {
      process.stderr.write("bridge_claude_mode_invalid\n");
      process.exitCode = 2;
      server.close();
      return;
    }
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
  }
  const child = spawn(executable, args, { shell: false, stdio: "inherit",
    env, cwd: "/tmp" });
  delete env.ANTHROPIC_API_KEY;
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    for (const socket of sockets) socket.destroy();
    server.close(() => { process.exitCode = code; });
  };
  child.once("error", (error) => {
    process.stderr.write("bridge_child_failed:" + error.code + "\n");
    finish(1);
  });
  child.once("close", (code, signal) => {
    finish(signal ? 1 : (code === null || code === undefined ? 1 : code));
  });
});
server.once("error", (error) => {
  process.stderr.write("bridge_listen_failed:" + error.code + "\n");
  process.exitCode = 1;
});
`;
