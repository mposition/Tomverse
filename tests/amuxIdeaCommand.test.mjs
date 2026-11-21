import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { AMUX_SESSION_INTAKE_ROUTE } from "../lib/amux/ideaSessionIntakeClientCore.ts";
import { amuxIdeaErrorReport, amuxIdeaText, githubRepositoryOf, parseAmuxIdeaArgs,
  runAmuxIdeaCommand } from "../scripts/amux-idea.mjs";
import { amuxSessionPlanFixture } from "./fixtures/amuxSessionPlan.mjs";

const requestId = "34340477-7664-42f4-b3fe-845d10365051";
const ideaId = "8486a25b-919f-4714-a3d8-45ef5a18b175";
const reservationId = "788e5cd2-4615-46e6-b287-0b84ca217c7c";
const secret = "session_intake_only_012345678901234567890123";
const env = {
  TOMVERSE_AMUX_SESSION_INTAKE_CLIENT_SECRET: secret,
  TOMVERSE_AMUX_SESSION_INTAKE_ORIGIN: "https://tomverse.test",
};
const committed = (extra = {}) => new Response(JSON.stringify({
  status: "committed", requestId, ideaId, reservationId, hasExternalSources: true,
  adminPath: `/admin/amux-backlog?tab=ideas&idea=${requestId}`, ...extra,
}), { status: 201, headers: { "content-type": "application/json" } });
const files = (entries) => ({ readInput: (path) => {
  if (!Object.hasOwn(entries, path)) throw new Error("missing");
  return entries[path];
} });
const submitArgs = ["submit", "--tool", "Claude Code", "--provider", "Anthropic",
  "--title", "Dark mode toggle", "--body", "idea.md"];

test("the command admits only its own flags, once each, and repeats only references", () => {
  assert.deepEqual(parseAmuxIdeaArgs(["submit", "--title", "t", "--repo", "a/b", "--repo", "c/d"]).flags,
    { "--title": "t", "--repo": ["a/b", "c/d"] });
  for (const args of [[], ["send"], ["submit", "--title"], ["submit", "--title", "a", "--title", "b"],
    ["submit", "--secret", "x"], ["prompt", "--plan", "p.json"], ["submit", "--title", "--body"],
    ["submit", "--body", "-", "--plan", "-"], ["submit", "--no-repo", "--repo", "a/b"]]) {
    assert.throws(() => parseAmuxIdeaArgs(args), /command_invalid/, JSON.stringify(args));
  }
});

test("the idea text is its one-line title, then the body", () => {
  assert.equal(amuxIdeaText({ "--title": " Dark mode " }), "Dark mode");
  assert.equal(amuxIdeaText({ "--title": "Dark mode", "--body": "b.md" }, files({ "b.md": "\nWhy.\n" })),
    "Dark mode\n\nWhy.");
  assert.throws(() => amuxIdeaText({ "--title": "two\nlines" }), /metadata_incomplete/);
  assert.throws(() => amuxIdeaText({}), /metadata_incomplete/);
  assert.equal(githubRepositoryOf("https://github.com/mposition/Tomverse.git\n"), "mposition/Tomverse");
  assert.equal(githubRepositoryOf("git@github.com:mposition/Tomverse.git"), "mposition/Tomverse");
  assert.equal(githubRepositoryOf("https://gitlab.com/a/b"), null);
});

test("submit with a plan sends the checked plan once and reports its state", async () => {
  const sent = [];
  const prepared = [];
  const result = await runAmuxIdeaCommand([...submitArgs, "--plan", "plan.json",
    "--repo", "mposition/Tomverse", "--pr", "mposition/Tomverse#4155"], env, {
    ...files({ "idea.md": "Users asked for it.", "plan.json": JSON.stringify(amuxSessionPlanFixture()) }),
    createRequestId: () => requestId,
    onPrepared: (value) => prepared.push(value),
    fetcher: async (url, init) => {
      sent.push({ url, init });
      return committed({ plan: { state: "awaiting_approval", unitCount: 4 } });
    },
  });
  assert.deepEqual(prepared, [{ status: "dispatching", requestId, plan: "attached" }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, `https://tomverse.test${AMUX_SESSION_INTAKE_ROUTE}`);
  assert.equal(sent[0].init.method, "POST");
  assert.equal(sent[0].init.headers.authorization, `Bearer ${secret}`);
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ["input", "plan", "requestId", "source", "version"]);
  assert.deepEqual(body.plan, amuxSessionPlanFixture());
  assert.deepEqual(body.input, { version: 1, idea: "Dark mode toggle\n\nUsers asked for it.",
    repositories: ["mposition/Tomverse"],
    pullRequests: [{ repository: "mposition/Tomverse", number: 4155 }] });
  assert.deepEqual(body.source, { toolName: "Claude Code", modelProvider: "Anthropic",
    sessionDisplay: "Claude Code session" });
  assert.equal(result.value.state, "committed");
  assert.deepEqual(result.value.plan, { state: "awaiting_approval", unitCount: 4 });
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("submit without a plan is the existing intake body, with this checkout as its reference", async () => {
  let body;
  const result = await runAmuxIdeaCommand(submitArgs, env, {
    ...files({ "idea.md": "Users asked for it." }),
    createRequestId: () => requestId,
    onPrepared: () => {},
    defaultRepository: () => "mposition/Tomverse",
    fetcher: async (_url, init) => { body = JSON.parse(init.body); return committed(); },
  });
  assert.deepEqual(Object.keys(body).sort(), ["input", "requestId", "source", "version"]);
  assert.deepEqual(body.input.repositories, ["mposition/Tomverse"]);
  assert.equal(result.value.state, "committed");
  assert.equal(Object.hasOwn(result.value, "plan"), false);

  await runAmuxIdeaCommand([...submitArgs, "--no-repo"], env, {
    ...files({ "idea.md": "x" }), createRequestId: () => requestId, onPrepared: () => {},
    defaultRepository: () => { throw new Error("not consulted"); },
    fetcher: async (_url, init) => { body = JSON.parse(init.body); return committed(); },
  });
  assert.deepEqual(body.input.repositories, []);
});

test("a refused plan stops before any request, with only the parser's closed verdict", async () => {
  const plan = amuxSessionPlanFixture();
  delete plan.units[3].expectedPaths;
  let calls = 0;
  const run = (text) => runAmuxIdeaCommand([...submitArgs, "--plan", "plan.json"], env, {
    ...files({ "idea.md": "x", "plan.json": text }), createRequestId: () => requestId,
    onPrepared: () => {}, fetcher: async () => { calls++; return committed(); },
  });
  const refusal = await run(JSON.stringify(plan)).catch((error) => error);
  assert.deepEqual(amuxIdeaErrorReport(refusal), { error: "plan_rejected", reason: "schema",
    detail: { detail: "chunk_schema_rejected", at: { rule: "task_expected_paths_missing",
      field: "expectedPaths", unit: 3, kind: "card" } } });
  const secretPlan = amuxSessionPlanFixture({ coveredScope: "Keep sk-live1234567890abcdef." });
  const content = await run(JSON.stringify(secretPlan)).catch((error) => error);
  assert.deepEqual(amuxIdeaErrorReport(content), { error: "content_refused" });
  assert.equal(JSON.stringify(amuxIdeaErrorReport(content)).includes("sk-live"), false);
  const unparsable = await run("{ not json").catch((error) => error);
  assert.deepEqual(amuxIdeaErrorReport(unparsable), { error: "plan_rejected" });
  assert.equal(calls, 0);
});

test("check and prompt need no credential and send nothing", async () => {
  const checked = await runAmuxIdeaCommand(["check", "--plan", "plan.json"], {},
    files({ "plan.json": JSON.stringify(amuxSessionPlanFixture()) }));
  assert.deepEqual(checked.value, { status: "plan_ok", unitCount: 4 });
  const prompt = await runAmuxIdeaCommand(["prompt", "--title", "Dark mode toggle"], {});
  assert.equal(prompt.output, "text");
  assert.match(prompt.text, /answer the prompt below with exactly one JSON object/);
  assert.match(prompt.text, /"text":"Dark mode toggle"/);
  assert.match(prompt.text, /This session analysis has exactly one source unit/);
  await assert.rejects(runAmuxIdeaCommand(submitArgs, {}, files({ "idea.md": "x" })),
    /credential_unavailable/);
  await assert.rejects(runAmuxIdeaCommand(["submit", "--title", "t"], env, {}),
    /metadata_incomplete/);
});

test("the entrypoint prints closed codes only, never the secret or the plan", () => {
  const dir = mkdtempSync(join(tmpdir(), "amux-idea-"));
  try {
    const plan = amuxSessionPlanFixture({ coveredScope: "Private note C:\\Users\\op\\x.txt" });
    writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
    const script = resolve(import.meta.dirname, "..", "scripts", "amux-idea.mjs");
    const run = (args, extraEnv) => spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
      cwd: resolve(import.meta.dirname, ".."), encoding: "utf8",
      env: { ...process.env, ...extraEnv } });
    const refused = run(["submit", "--tool", "Codex", "--provider", "OpenAI", "--title", "t",
      "--plan", join(dir, "plan.json"), "--no-repo"], env);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, "");
    assert.deepEqual(JSON.parse(refused.stderr), { error: "content_refused" });
    const badOrigin = run(["submit", "--tool", "Codex", "--provider", "OpenAI", "--title", "t",
      "--no-repo"], { ...env, TOMVERSE_AMUX_SESSION_INTAKE_ORIGIN: "http://insecure.test" });
    assert.equal(badOrigin.status, 1);
    assert.deepEqual(JSON.parse(badOrigin.stderr), { error: "origin_invalid" });
    for (const output of [refused, badOrigin]) {
      assert.equal(`${output.stdout}${output.stderr}`.includes(secret), false);
      assert.equal(`${output.stdout}${output.stderr}`.includes("Private note"), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.equal(packageJson.scripts["amux:idea"], "node --import tsx scripts/amux-idea.mjs");
});
