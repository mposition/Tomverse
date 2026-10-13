import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");
const dockerfile = read("docker/product-research-scout-probe.Dockerfile");
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

test("neither the image nor the probe turns the Chromium sandbox off", () => {
  const probe = read("scripts/agents/product-research-scout-s0-probe.mjs");
  for (const [name, text] of [["Dockerfile", dockerfile], ["probe", probe]]) {
    assert.equal(/--no-sandbox|--disable-setuid-sandbox|--no-zygote/.test(text), false, name);
    assert.equal(/chromiumSandbox:\s*false/.test(text), false, name);
  }
  assert.match(probe, /chromiumSandbox:\s*true/);
});

test("the probe reads one variable, its switch, and the service declares only that", async () => {
  const probe = read("scripts/agents/product-research-scout-s0-probe.mjs");
  const names = [...probe.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(names)], ["PRODUCT_RESEARCH_SCOUT_ENABLED"]);

  const { AGENT_RUNNER_SERVICES } = await import("../.railway/agent-runners.ts");
  const service = AGENT_RUNNER_SERVICES.find((runner) => runner.key === "product_research_scout_probe");
  assert.deepEqual(Object.keys(service.environments), ["staging"]);
  assert.deepEqual([...service.environments.staging], ["PRODUCT_RESEARCH_SCOUT_ENABLED"]);
  assert.equal(service.cronSchedule, null);
  assert.equal(service.dockerfile.path, "docker/product-research-scout-probe.Dockerfile");
});
