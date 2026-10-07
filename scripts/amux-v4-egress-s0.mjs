/** Synthetic-only Linux namespace probe. Bundle this file with esbuild before
 * running it in Ubuntu; the bundled artifact contains the TS proxy core. It
 * never launches a model CLI or dials a provider endpoint. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { createServer as createTcpServer, connect as connectTcp } from "node:net";
import { join } from "node:path";

import { amuxV4VerifiedSandboxArgs } from "../lib/amux/ideaLocalSandboxArgs.mjs";
import { createAmuxV4EgressProxy } from "../lib/amux/ideaLocalEgressProxy.ts";

const CHILD = String.raw`
const assert = require("node:assert/strict");
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const net = require("node:net");
const request = (authority, expected, method = "CONNECT") => new Promise((resolve, reject) => {
  const socket = net.connect({ host: "127.0.0.1", port: 3128 });
  let output = "";
  const timer = setTimeout(() => { socket.destroy(); reject(new Error("response deadline")); }, 2000);
  socket.once("error", reject);
  socket.once("connect", () => socket.write(
    method + " " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\n\r\n" +
    (expected === 200 ? "S0_ECHO" : "")));
  socket.on("data", (bytes) => {
    output += bytes.toString("utf8");
    if (output.includes(expected === 200 ? "S0_ECHO" : expected + " ")) {
      clearTimeout(timer); socket.destroy(); resolve(output);
    }
  });
});
const direct = () => new Promise((resolve, reject) => {
  const socket = net.connect({ host: "127.0.0.1",
    port: Number(process.argv[1]) });
  const timer = setTimeout(() => { socket.destroy(); reject(new Error("direct connection hung")); }, 1000);
  socket.once("connect", () => { clearTimeout(timer); socket.destroy(); reject(new Error("direct network allowed")); });
  socket.once("error", (error) => {
    clearTimeout(timer);
    if (error.code === "ECONNREFUSED" || error.code === "ENETUNREACH") resolve();
    else reject(error);
  });
});
async function main() {
  assert.deepEqual(Object.keys(process.env).sort(),
    ["HOME", "HTTPS_PROXY", "PATH", "PWD"]);
  assert.equal(process.env.PWD, "/tmp");
  assert.equal(process.env.DATABASE_URL, undefined);
  assert.equal(process.env.GITHUB_TOKEN, undefined);
  assert.equal(process.env.SSH_AUTH_SOCK, undefined);
  assert.equal(existsSync("/mnt/c"), false);
  assert.equal(existsSync("/home"), false);
  assert.equal(existsSync("/etc"), false);
  assert.equal(existsSync("/root"), false);
  assert.deepEqual(readdirSync("/run"), ["amux"]);
  const socketMount = readFileSync("/proc/self/mountinfo", "utf8").split("\n")
    .map((line) => line.split(" "))
    .find((fields) => fields[4] === "/run/amux");
  assert.ok(socketMount && socketMount[5].split(",").includes("ro"));
  const interfaces = readFileSync("/proc/net/dev", "utf8").split("\n")
    .slice(2).filter((line) => line.includes(":"))
    .map((line) => line.split(":")[0].trim());
  assert.deepEqual(interfaces, ["lo"]);
  await direct();
  assert.match(await request("evil.example:443", 403), /403 Forbidden/);
  assert.match(await request("api.openai.com:80", 403), /403 Forbidden/);
  assert.match(await request("127.0.0.1:443", 403), /403 Forbidden/);
  assert.match(await request("http://api.openai.com/", 405, "GET"), /405 Method Not Allowed/);
  assert.match(await request("api.openai.com:443", 200), /200 Connection Established/);
  assert.match(await request("api.openai.com:443", 403), /403 Forbidden/);
  assert.match(await request("api.openai.com:443", 403), /403 Forbidden/);
  process.stdout.write("S0_OK\n");
}
main().catch((error) => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
`;

const listen = (server, address) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(address, () => {
    server.off("error", reject);
    resolve(server.address());
  });
});
const close = (server) => new Promise((resolve) => server.close(resolve));

async function runChild(args) {
  const child = spawn("bwrap", args, { stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", DATABASE_URL: "S0_DB_CANARY",
      GITHUB_TOKEN: "S0_GH_CANARY", HOME: "/S0_HOME_CANARY",
      SSH_AUTH_SOCK: "/S0_SSH_CANARY" } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (bytes) => { stdout = (stdout + bytes).slice(-8192); });
  child.stderr.on("data", (bytes) => { stderr = (stderr + bytes).slice(-8192); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, `sandbox exited ${code}: ${stderr}`);
    assert.equal(stdout, "S0_OK\n");
  } finally { clearTimeout(timer); }
}

async function main() {
  assert.equal(process.platform, "linux", "run the bundled probe inside Ubuntu");
  const directory = await mkdtemp("/tmp/amux-v4-egress-s0-");
  await chmod(directory, 0o700);
  const socketPath = join(directory, "proxy.sock");
  const lookups = [];
  const dials = [];
  const echo = createTcpServer((socket) => socket.pipe(socket));
  const echoAddress = await listen(echo, { host: "127.0.0.1", port: 0 });
  const proxy = createAmuxV4EgressProxy(["api.openai.com"], {
    resolve: async (host) => {
      lookups.push(host);
      if (lookups.length === 2) return ["169.254.169.254"];
      if (lookups.length === 3) return ["104.18.6.192", "127.0.0.1"];
      return ["104.18.6.192"];
    },
    dial: (address, port) => {
      dials.push({ address, port });
      return connectTcp({ host: "127.0.0.1", port: echoAddress.port });
    },
  });
  try {
    await listen(proxy, socketPath);
    await chmod(socketPath, 0o600);
    await runChild(await amuxV4VerifiedSandboxArgs(directory,
      ["/usr/bin/node", "-e", CHILD, String(echoAddress.port)]));
    assert.deepEqual(lookups, ["api.openai.com", "api.openai.com",
      "api.openai.com"], "refused targets must not trigger DNS");
    assert.deepEqual(dials, [{ address: "104.18.6.192", port: 443 }],
      "only the checked public IP and port may be dialed");
    process.stdout.write("AMUX_V4_EGRESS_S0_PASS\n");
  } finally {
    await close(proxy);
    await close(echo);
    await unlink(socketPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory);
  }
}
main().catch((error) => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
