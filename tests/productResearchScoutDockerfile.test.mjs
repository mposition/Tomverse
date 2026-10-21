import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");
const dockerfile = read("docker/product-research-scout.Dockerfile");
const instructions = dockerfile
  .split("\n")
  .filter((line) => line.trim() && !line.trimStart().startsWith("#"));

test("the probe image is Playwright's own, pinned by digest, at the version the lockfile installs", () => {
  const lock = JSON.parse(read("package-lock.json"));
  const version = lock.packages["node_modules/@playwright/test"].version;
  const from = instructions.filter((line) => line.startsWith("FROM "));
  assert.equal(from.length, 1, "one stage");
  assert.match(
    from[0],
    new RegExp(`^FROM mcr\\.microsoft\\.com/playwright:v${version.replaceAll(".", "\\.")}-noble@sha256:[0-9a-f]{64}$`),
    "a tag that differs from the lockfile would ship browsers @playwright/test does not expect",
  );
});

test("the probe runs unprivileged, with no build argument and no lifecycle scripts", () => {
  // Chromium refuses its sandbox to root; S0 (11) is whether the sandbox runs.
  const users = instructions.filter((line) => line.startsWith("USER "));
  assert.deepEqual(users, ["USER pwuser"]);
  assert.ok(instructions.indexOf("USER pwuser") > instructions.findIndex((line) => line.startsWith("RUN ")), "USER after the last RUN");
  assert.equal(instructions.some((line) => /^ARG\b/.test(line)), false, "an ARG is how a Railway variable reaches a build");
  assert.equal(instructions.some((line) => /--mount=type=secret/.test(line)), false);
  const runs = instructions.filter((line) => line.startsWith("RUN "));
  assert.deepEqual(runs, ["RUN npm ci --ignore-scripts --no-audit --no-fund"]);
});

test("the sandbox is asked for first; only the walker's retry after a refused sandbox goes without it", () => {
  const browser = read("lib/productResearchScoutBrowser.mjs");
  const scripts = [
    ["probe", read("scripts/agents/product-research-scout-s0-probe.mjs")],
    ["walker", read("scripts/agents/product-research-scout.mjs")],
  ];
  for (const [name, text] of [["Dockerfile", dockerfile], ["browser", browser], ...scripts]) {
    assert.equal(/--no-sandbox|--disable-setuid-sandbox|--no-zygote/.test(text), false, name);
    assert.equal(/chromiumSandbox:\s*false/.test(text), false, name);
  }
  // Both scripts launch through the shared module, which asks for the sandbox unless told otherwise.
  assert.match(browser, /export async function launch\(args, \{ sandbox = true \} = \{\}\)/);
  assert.match(browser, /chromiumSandbox: sandbox === false \? false : true/);
  for (const [name, text] of scripts) {
    assert.match(text, /from "\.\.\/\.\.\/lib\/productResearchScoutBrowser\.mjs"/, name);
    assert.equal(/chromium\.launch\(/.test(text), false, name);
  }
  // The probe measures the sandbox and never goes without it. The walker goes
  // without it once, after a sandboxed launch failed and the policy allowed the retry.
  const [, probe] = scripts[0];
  const [, walker] = scripts[1];
  assert.equal(/sandbox:\s*false/.test(probe), false);
  assert.equal((walker.match(/sandbox:\s*false/g) ?? []).length, 1);
  const sandboxed = walker.indexOf("browser = await launch(args);");
  const guard = walker.indexOf("if (!retriesWithoutSandbox(process.env.PRODUCT_RESEARCH_SCOUT_SANDBOX_FALLBACK, failure)) throw error;");
  const retry = walker.indexOf("browser = await launch(args, { sandbox: false });");
  assert.ok(sandboxed > 0 && sandboxed < guard && guard < retry, "sandboxed launch, then the guard, then the retry");
});

test("a failed launch reports the host's sandbox conditions as short values only", async () => {
  const { sandboxHost } = await import("../lib/productResearchScoutBrowser.mjs");
  const host = sandboxHost();
  assert.deepEqual(Object.keys(host), [
    "uid",
    "maxUserNamespaces",
    "unprivilegedUsernsClone",
    "apparmorRestrictsUserns",
    "noNewPrivs",
    "seccomp",
    "capBnd",
  ]);
  for (const [key, value] of Object.entries(host)) {
    assert.ok(value === null || typeof value === "number" || (typeof value === "string" && value.length <= 32), key);
  }
  const walker = read("scripts/agents/product-research-scout.mjs");
  assert.match(walker, /const failure = launchFailure\(error\);/);
  assert.match(walker, /product_research_scout_browser_launch_failed", \.\.\.failure, host: sandboxHost\(\)/);
});

test("the probe is a local tool: it reads only its switch, and no Railway service runs it", async () => {
  const probe = read("scripts/agents/product-research-scout-s0-probe.mjs");
  const names = [...probe.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(names)], ["PRODUCT_RESEARCH_SCOUT_ENABLED"]);

  // The walker's first run in Railway is the sandbox check, so the probe has
  // no service of its own.
  const { AGENT_RUNNER_SERVICES } = await import("../.railway/agent-runners.ts");
  assert.equal(AGENT_RUNNER_SERVICES.some((runner) => /s0-probe/.test(runner.startCommand)), false);
});

test("the walker runs daily at 18:00 UTC with its switch, URL and secret, and no model key", async () => {
  const walker = read("scripts/agents/product-research-scout.mjs");
  const names = [...new Set([...walker.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((match) => match[1]))].sort();
  assert.deepEqual(names, [
    "PRODUCT_RESEARCH_SCOUT_ENABLED",
    "PRODUCT_RESEARCH_SCOUT_INGEST_SECRET",
    "PRODUCT_RESEARCH_SCOUT_INGEST_URL",
    "PRODUCT_RESEARCH_SCOUT_SANDBOX_FALLBACK",
  ]);

  const { AGENT_RUNNER_SERVICES } = await import("../.railway/agent-runners.ts");
  const service = AGENT_RUNNER_SERVICES.find((runner) => runner.key === "product_research_scout");
  assert.equal(service.cronSchedule, "0 18 * * *");
  // The Admin "next run" reads this hour; the two move together.
  const { SCOUT_SCHEDULE_UTC_HOUR } = await import("../lib/productResearchScoutCore.ts");
  assert.equal(service.cronSchedule, `0 ${SCOUT_SCHEDULE_UTC_HOUR} * * *`);
  assert.equal(service.startCommand, "npm run agent:product-research-scout");
  assert.equal(service.dockerfile.path, "docker/product-research-scout.Dockerfile");
  assert.deepEqual(Object.keys(service.environments).sort(), ["dev", "production"]);
  for (const variables of Object.values(service.environments)) assert.deepEqual([...variables].sort(), names);
  // The image carries what the walker imports.
  for (const path of ["scripts/agents/product-research-scout.mjs", "scripts/report-product-consistency-core.mjs"]) {
    assert.ok(dockerfile.includes(`COPY ${path} ${path}`), path);
  }
});
