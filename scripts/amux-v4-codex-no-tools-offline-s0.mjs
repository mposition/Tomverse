#!/usr/bin/env node
// Offline proof only. The launcher first creates a network-isolated bwrap
// namespace; the child captures every request to a synthetic loopback provider.
// No OAuth profile is mounted and no model endpoint is reachable.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { amuxV4CodexNoToolsCatalogJson,
  amuxV4CodexNoToolsConfigArgs } from
  "../lib/amux/ideaLocalCodexNoToolsCore.mjs";

const SOURCE_BINARY = "/home/tommy/.codex/packages/standalone/releases/0.155.1-x86_64-unknown-linux-musl/bin/codex";
const BINARY_SHA256 = "0753dfe1d8b87a52436deb13eb1c549661ef4c84fee2c5aa688385eebeccb761";
const self = fileURLToPath(import.meta.url);

if (process.env.AMUX_V4_OFFLINE_CHILD !== "1") {
  if (process.platform !== "linux" || process.argv.length !== 2) {
    throw new Error("offline Linux launcher required");
  }
  const hash = createHash("sha256");
  for await (const part of createReadStream(SOURCE_BINARY)) hash.update(part);
  if (hash.digest("hex") !== BINARY_SHA256) {
    throw new Error("unapproved offline Codex binary");
  }
  const args = ["--unshare-all", "--die-with-parent", "--cap-drop", "ALL",
    "--clearenv", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--dir", "/run", "--ro-bind", self, "/run/probe.mjs",
    "--ro-bind", SOURCE_BINARY, "/run/codex",
    "--setenv", "HOME", "/tmp", "--setenv", "PATH", "/usr/bin:/bin",
    "--setenv", "AMUX_V4_OFFLINE_CHILD", "1", "--chdir", "/tmp",
    "--", "/usr/bin/node", "/run/probe.mjs", "/run/codex"];
  const isolated = spawn("/usr/bin/bwrap", args, {
    env: { PATH: "/usr/bin:/bin" }, detached: true,
    stdio: ["ignore", "pipe", "ignore"], shell: false,
  });
  const chunks = [];
  let bytes = 0;
  isolated.stdout.on("data", (part) => {
    bytes += part.length;
    if (bytes <= 4096) chunks.push(part);
    else {
      try { process.kill(-isolated.pid, "SIGKILL"); }
      catch { isolated.kill("SIGKILL"); }
    }
  });
  const timeout = setTimeout(() => {
    try { process.kill(-isolated.pid, "SIGKILL"); }
    catch { isolated.kill("SIGKILL"); }
  }, 30_000);
  const exit = await new Promise((resolve) => {
    isolated.once("error", () => resolve({ code: null }));
    isolated.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { result = null; }
  if (exit.code !== 0 || bytes > 4096 ||
      result?.captured?.toolsIsArray !== true ||
      result.captured.toolsCount !== 0 ||
      result.captured.reasoningEffort !== "high" ||
      result.captured.toolChoice !== "auto" ||
      result.requestCount !== 1 || result.captureError !== null ||
      result.exit?.code !== 1 || result.exit?.signal !== null) {
    process.stderr.write("AMUX_V4_CODEX_OFFLINE_S0_FAILED\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("AMUX_V4_CODEX_OFFLINE_S0_PASS tools=0 effort=high requests=1\n");
  }
} else {
  if (process.platform !== "linux" || process.argv[2] !== "/run/codex" ||
      process.env.HOME !== "/tmp" || process.env.CODEX_HOME) {
    throw new Error("offline namespace required");
  }
  await runIsolatedCapture(process.argv[2]);
}

async function runIsolatedCapture(binary) {
const temporary = await mkdtemp("/tmp/amux-v4-offline-codex-");
let captured = null;
let captureError = null;
let requestCount = 0;
const server = createServer((request, response) => {
  requestCount += 1;
  if (request.method !== "POST" || request.url !== "/v1/responses" ||
      captured !== null) {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > 256_000) request.destroy();
    else chunks.push(chunk);
  });
  request.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      captured = {
        toolsIsArray: Array.isArray(body.tools),
        toolsCount: Array.isArray(body.tools) ? body.tools.length : null,
        toolChoice: body.tool_choice ?? null,
        reasoningEffort: body.reasoning?.effort ?? null,
      };
    } catch { captureError = "invalid_request"; }
    response.writeHead(400, { "content-type": "application/json" });
    response.end('{"error":{"message":"offline capture complete","type":"invalid_request_error"}}');
  });
});
try {
  await writeFile(join(temporary, "catalog.json"),
    amuxV4CodexNoToolsCatalogJson("gpt-5.6-sol"), { mode: 0o600 });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const overrides = [
    `model_provider="local_capture"`,
    'model_providers.local_capture.name="local_capture"',
    `model_providers.local_capture.base_url="http://127.0.0.1:${port}/v1"`,
    'model_providers.local_capture.wire_api="responses"',
    "model_providers.local_capture.requires_openai_auth=false",
    "model_providers.local_capture.supports_websockets=false",
    "model_providers.local_capture.supports_standalone_web_search=false",
    "model_providers.local_capture.request_max_retries=0",
    "model_providers.local_capture.stream_max_retries=0",
    'model_reasoning_effort="high"',
    'shell_environment_policy.inherit="none"',
  ];
  const zeroToolArgs = amuxV4CodexNoToolsConfigArgs();
  const catalogOverride = zeroToolArgs.indexOf("-c");
  zeroToolArgs[catalogOverride + 1] =
    `model_catalog_json=${JSON.stringify(join(temporary, "catalog.json"))}`;
  const command = ["--ask-for-approval", "never",
    ...zeroToolArgs,
    ...overrides.flatMap((value) => ["-c", value]),
    "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "--strict-config", "--sandbox", "read-only", "--json",
    "--skip-git-repo-check", "-m", "gpt-5.6-sol", "-"];
  const child = spawn(binary, command, {
    cwd: temporary,
    env: { HOME: "/tmp", CODEX_HOME: temporary, PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "ignore", "pipe"], shell: false,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 4000) stderr += chunk.toString("utf8").slice(0, 4000);
  });
  child.stdin.end("Say S0_OK.\n");
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const exit = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error: error.code }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  const result = { captured, captureError, requestCount, exit,
    // Diagnostics only; no request body or credential is printed.
    diagnostic: captured ? null : stderr.slice(0, 1600) };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!captured?.toolsIsArray || captured.toolsCount !== 0 ||
      captured.toolChoice !== "auto" || captured.reasoningEffort !== "high" ||
      requestCount !== 1 || exit.code !== 1 || exit.signal !== null) {
    process.exitCode = 1;
  }
} finally {
  server.close();
  await rm(temporary, { recursive: true, force: true });
}
}
