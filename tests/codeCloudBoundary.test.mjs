import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { requiresMutationOriginCheck } from "../lib/requestOrigin.ts";
import { desktopCloudExecutionEnabled, codeCloudRunnerSecret } from "../lib/desktopCloudExecutionSwitch.ts";
import {
  CODE_CLOUD_LIMITS, cleanCloudLogLine, codeCloudRequestSchema, codeCloudRunnerRequestSchema, looksLikeGitBundle,
} from "../lib/codeCloudContract.ts";
import { desktopReadApiRoute, desktopWriteApiRoute } from "../lib/nativeBearerGate.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// The condition for exempting /api/code/cloud/runner from the mutation Origin check (lib/requestOrigin.ts): the runner
// routes read no session and no cookie, so the only credentials they accept are the runner secret and a job token.
const RUNNER_FILES = ["app/api/code/cloud/runner/route.ts", "app/api/code/cloud/runner/bundle/route.ts"];

test("runner routes read no session or cookie", () => {
  for (const file of RUNNER_FILES) {
    const source = read(file);
    for (const forbidden of ["getServerSession", "next/headers", "cookies()", "resolveChatRouteSession", "requireMobileBearer", "@/lib/auth\""]) {
      assert.ok(!source.includes(forbidden), `${file} must not use ${forbidden}`);
    }
  }
});

test("only the exact runner path skips the Origin check; the person's job routes keep it", () => {
  assert.equal(requiresMutationOriginCheck("POST", "/api/code/cloud/runner"), false);
  assert.equal(requiresMutationOriginCheck("POST", "/api/code/cloud/runner/x"), true);
  assert.equal(requiresMutationOriginCheck("POST", "/api/code/cloud"), true);
  assert.equal(requiresMutationOriginCheck("PUT", "/api/code/cloud/bundle"), true);
  for (const file of ["app/api/code/cloud/route.ts", "app/api/code/cloud/bundle/route.ts"]) {
    const source = read(file);
    assert.ok(source.includes("hasValidMutationOrigin(request)") && source.includes('x-tomverse-code") !== "1"'), file);
  }
});

test("no Desktop bearer route reaches cloud jobs: Desktop uses the account settings session", () => {
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) if (/^TOMVERSE_DESKTOP_.*_ENABLED$/.test(name)) delete process.env[name];
  Object.assign(process.env, { TOMVERSE_DESKTOP_AUTH_ENABLED: "true", TOMVERSE_DESKTOP_CLOUD_EXECUTION_ENABLED: "true", TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED: "true",
    TOMVERSE_DESKTOP_REVIEW_WRITE_ENABLED: "true", CODE_MANAGED_EXECUTION_ENABLED: "true" });
  try {
    for (const path of ["/api/code/cloud", "/api/code/cloud/bundle", "/api/code/cloud/patch", "/api/code/cloud/runner", "/api/code/cloud/runner/bundle"]) {
      for (const method of ["GET", "POST", "PUT"]) {
        assert.equal(desktopReadApiRoute(path, method) || desktopWriteApiRoute(path, method), false, method + " " + path);
      }
    }
  } finally {
    process.env = saved;
  }
});

test("cloud execution is off unless every switch is exactly true and a runner secret is set", () => {
  const on = {
    TOMVERSE_DESKTOP_AUTH_ENABLED: "true", TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED: "true", TOMVERSE_DESKTOP_CLOUD_EXECUTION_ENABLED: "true",
    CODE_MANAGED_EXECUTION_ENABLED: "true", CODE_CLOUD_RUNNER_SECRET: "x".repeat(32),
  };
  assert.equal(desktopCloudExecutionEnabled(on), true);
  assert.equal(desktopCloudExecutionEnabled({}), false);
  for (const name of Object.keys(on)) {
    assert.equal(desktopCloudExecutionEnabled({ ...on, [name]: undefined }), false, name);
    if (name !== "CODE_CLOUD_RUNNER_SECRET") assert.equal(desktopCloudExecutionEnabled({ ...on, [name]: "TRUE" }), false, name);
  }
  assert.equal(codeCloudRunnerSecret({ CODE_CLOUD_RUNNER_SECRET: "short" }), null);
  assert.equal(desktopCloudExecutionEnabled({ ...on, CODE_CLOUD_RUNNER_SECRET: "x".repeat(31) }), false);
});

test("the capability names cloud execution only through its switch", () => {
  const source = read("app/api/products/chat/capabilities/route.ts");
  assert.match(source, /desktopCloudExecution: desktopCloudExecutionEnabled\(\)/);
});

test("the runner cannot name a model, a reservation, a user or a price", () => {
  const model = codeCloudRunnerRequestSchema.safeParse({ action: "model", jobId: crypto.randomUUID(), callId: crypto.randomUUID(),
    prompt: { system: "s", user: "u" }, schema: { type: "object" }, maxOutputTokens: 10, modelId: "other-model" });
  assert.equal(model.success, false);
  for (const extra of [{ reservationId: crypto.randomUUID() }, { userId: "u" }, { credits: 5 }]) {
    assert.equal(codeCloudRunnerRequestSchema.safeParse({ action: "heartbeat", jobId: crypto.randomUUID(), logs: [], ...extra }).success, false);
  }
  assert.equal(codeCloudRunnerRequestSchema.safeParse({ action: "model", jobId: crypto.randomUUID(), callId: crypto.randomUUID(),
    prompt: { system: "s", user: "u" }, schema: { type: "object" }, maxOutputTokens: 16_001 }).success, false);
  // The finish outcome list is not the stored status list: a runner cannot write "running" or "queued".
  assert.equal(codeCloudRunnerRequestSchema.safeParse({ action: "finish", jobId: crypto.randomUUID(), outcome: "running" }).success, false);
});

test("Desktop's create request is bounded and strict", () => {
  const body = { action: "create", taskId: crypto.randomUUID(), instruction: "Fix the test", catalogVersion: 3, contentHash: "h",
    executorModelId: "gpt-6-luna", reviewerModelId: "claude-haiku-4-5", approvedCredits: 20, bundleBytes: 100, bundleSha256: "a".repeat(64), baseCommit: "b".repeat(40) };
  assert.equal(codeCloudRequestSchema.safeParse(body).success, true);
  assert.equal(codeCloudRequestSchema.safeParse({ ...body, bundleBytes: CODE_CLOUD_LIMITS.bundleMaxBytes + 1 }).success, false);
  assert.equal(codeCloudRequestSchema.safeParse({ ...body, instruction: "x".repeat(CODE_CLOUD_LIMITS.instructionMaxChars + 1) }).success, false);
  assert.equal(codeCloudRequestSchema.safeParse({ ...body, price: 0 }).success, false);
  assert.equal(codeCloudRequestSchema.safeParse({ ...body, baseCommit: "HEAD" }).success, false);
});

test("log lines are flattened, stripped of control and bidi characters and bounded", () => {
  assert.equal(cleanCloudLogLine("a\r\nb\u001b[31mc‮d"), "a b[31mcd");
  assert.equal(cleanCloudLogLine("x".repeat(1000)).length, CODE_CLOUD_LIMITS.logLineMaxChars);
});

test("only a git bundle header is accepted as a bundle", () => {
  assert.equal(looksLikeGitBundle(new TextEncoder().encode("# v2 git bundle\nabc")), true);
  assert.equal(looksLikeGitBundle(new TextEncoder().encode("# v3 git bundle\n@object-format=sha1")), true);
  assert.equal(looksLikeGitBundle(new TextEncoder().encode("PK\u0003\u0004zip")), false);
});
