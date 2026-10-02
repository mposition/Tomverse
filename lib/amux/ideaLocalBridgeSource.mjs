/** Shared, dependency-free program for the network-isolated Ubuntu child.
 * The supervising runner must choose and validate the executable/argv, mount
 * only the exact Unix socket, and enforce a process deadline. This bridge
 * grants no model or filesystem permission by itself. */
export const AMUX_V4_LOCAL_BRIDGE_SOURCE = String.raw`
const net = require("node:net");
const { spawn } = require("node:child_process");
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
  const child = spawn(executable, args, { shell: false, stdio: "inherit",
    env: process.env, cwd: "/tmp" });
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
    finish(signal ? 1 : (code ?? 1));
  });
});
server.once("error", (error) => {
  process.stderr.write("bridge_listen_failed:" + error.code + "\n");
  process.exitCode = 1;
});
`;
