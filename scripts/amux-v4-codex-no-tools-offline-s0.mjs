#!/usr/bin/env node
// Offline proof only: capture the first request to a synthetic loopback
// provider. This script never contacts a model or reads an OAuth profile.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { amuxV4CodexNoToolsCatalogJson,
  amuxV4CodexNoToolsConfigArgs } from
  "../lib/amux/ideaLocalCodexNoToolsCore.mjs";

const binary = process.argv[2];
if (process.platform !== "linux" || binary !== "/run/codex" ||
    process.env.HOME !== "/tmp" || process.env.CODEX_HOME) {
  throw new Error("offline namespace required");
}

const temporary = await mkdtemp("/tmp/amux-v4-offline-codex-");
let captured = null;
let captureError = null;
const server = createServer((request, response) => {
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
  const result = { captured, captureError, exit,
    // Diagnostics only; no request body or credential is printed.
    diagnostic: captured ? null : stderr.slice(0, 1600) };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!captured?.toolsIsArray || captured.toolsCount !== 0) process.exitCode = 1;
} finally {
  server.close();
  await rm(temporary, { recursive: true, force: true });
}
