import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import ts from "typescript";

import {
  ANTHROPIC_VERSION,
  DEFAULT_MODEL,
  INPUT_LIMITS,
  MODEL_ENDPOINT,
  SESSION_LIMITS,
  buildModelRequest,
  parseModelResult,
  prepareInput,
  prepareRegistrationRound,
  prepareWorkRunInputs,
  readFileDenied,
  readTrackedFile,
  runModelSession,
} from "../lib/engineeringAgentModelCall.ts";

const bytes = (text) => new TextEncoder().encode(text);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/* External text ------------------------------------------------------- */

test("inputs are rejected for NUL or invalid UTF-8, and cleaned otherwise", () => {
  assert.deepEqual(prepareInput(new Uint8Array([0x61, 0x00]), 10), {
    ok: false,
    reason: "input_rejected",
    detail: "nul_byte",
  });
  assert.equal(prepareInput(new Uint8Array([0xff, 0xfe]), 10).detail, "invalid_utf8");
  const cleaned = prepareInput(bytes("a\u0007b\tc\nd\u001bé"), 100);
  assert.equal(cleaned.text, "ab\tc\ndé");
});

test("cuts never split a character, and the digest is of the original bytes", () => {
  const raw = bytes("가".repeat(300));
  const cut = prepareInput(raw, 512);
  assert.equal(cut.truncated, true);
  assert.equal(cut.originalBytes, 900);
  assert.equal(cut.digest, sha256(raw));
  assert.equal(cut.text, "가".repeat(170));
});

test("a head-and-tail cut keeps both ends and names what it dropped", () => {
  const raw = bytes(`${"h".repeat(20 * 1024)}${"t".repeat(20 * 1024)}`);
  const cut = prepareInput(raw, INPUT_LIMITS.executionBrief);
  const [head, marker, tail] = cut.text.split("\n");
  assert.equal(head, "h".repeat(12 * 1024));
  assert.equal(tail, "t".repeat(4 * 1024));
  assert.equal(marker, `[truncated ${40 * 1024 - 16 * 1024} bytes, sha256 ${sha256(raw)}]`);
});

test("the run total is met by cutting the CI log first, then the dependabot body", () => {
  const result = prepareWorkRunInputs({
    executionBrief: bytes("b".repeat(15 * 1024)),
    ciLog: bytes("c".repeat(40 * 1024)),
    dependabotBody: bytes("d".repeat(8 * 1024)),
  });
  assert.equal(result.ok, true);
  const size = (text) => (text === null ? 0 : bytes(text).length);
  assert.ok(size(result.brief) + size(result.ciLog) + size(result.dependabotBody) <= INPUT_LIMITS.workRunTotal);
  assert.equal(result.brief, "b".repeat(15 * 1024), "the brief is never cut for the total");
  assert.equal(result.dependabotBody, "d".repeat(8 * 1024), "the CI log gave way first");
  assert.ok(result.truncated.includes("ciLog"));
});

test("a registration round defers what does not fit instead of cutting it again", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ key: `K-${i}`, raw: bytes("x".repeat(8 * 1024)) }));
  items.push({ key: "BAD-1", raw: new Uint8Array([0]) });
  const round = prepareRegistrationRound(items);
  assert.equal(round.offered.length, 8);
  assert.deepEqual(round.deferred, ["K-8", "K-9"]);
  assert.deepEqual(round.rejected, ["BAD-1"]);
});

/* read_file ----------------------------------------------------------- */

test("the denylist holds for tracked files too", () => {
  for (const path of [
    ".env",
    "app/.env.local",
    "config/.npmrc",
    ".netrc",
    "certs/server.pem",
    "keys/deploy.key",
    "x/store.p12",
    "x/a.pfx",
    "x/b.jks",
    "home/id_rsa.pub",
    "home/id_ed25519",
    "sub/.git/config",
  ]) {
    assert.equal(readFileDenied(path, new Set()), true, path);
  }
  assert.equal(readFileDenied("tests/fixtures/fake-token.txt", new Set(["tests/fixtures/fake-token.txt"])), true);
  assert.equal(readFileDenied("lib/chatInput.ts", new Set()), false);
});

const ports = (files, { symlinks = [], realpaths = {}, directories = [] } = {}) => ({
  realpath: async (path) => realpaths[path] ?? path,
  lstatIsSymlink: async (path) => symlinks.includes(path),
  lstatIsFile: async (path) => Object.hasOwn(files, path) && !directories.includes(path),
  readFile: async (path) => bytes(files[path]),
});

const read = (overrides = {}) =>
  readTrackedFile({
    cloneRoot: "/clone",
    trackedPaths: new Set(["lib/a.ts", "lib/link.ts", "lib/dir", ".env"]),
    secretFixturePaths: new Set(),
    requested: "lib/a.ts",
    ports: ports({ "/clone/lib/a.ts": "export const a = 1;\n", "/clone/lib/link.ts": "x" }),
    budgetRemaining: 1024,
    ...overrides,
  });

test("read_file returns a tracked, regular, in-clone, non-denied file within budget", async () => {
  assert.deepEqual(await read(), { ok: true, text: "export const a = 1;\n", bytes: 20 });
  assert.deepEqual(await read({ requested: "lib/other.ts" }), { ok: false, reason: "not_tracked" });
  assert.deepEqual(await read({ requested: "/etc/passwd" }), { ok: false, reason: "not_tracked" });
  assert.deepEqual(await read({ requested: { path: "lib/a.ts" } }), { ok: false, reason: "not_tracked" });
  assert.deepEqual(await read({ requested: ".env" }), { ok: false, reason: "denied" });
  assert.deepEqual(
    await read({ requested: "lib/link.ts", ports: ports({ "/clone/lib/link.ts": "x" }, { symlinks: ["/clone/lib/link.ts"] }) }),
    { ok: false, reason: "symlink" },
  );
  assert.deepEqual(
    await read({ ports: ports({ "/clone/lib/a.ts": "x" }, { symlinks: ["/clone/lib"] }) }),
    { ok: false, reason: "symlink" },
    "a symlinked parent directory is refused too",
  );
  assert.deepEqual(
    await read({ ports: ports({ "/clone/lib/a.ts": "x" }, { realpaths: { "/clone/lib/a.ts": "/elsewhere/a.ts" } }) }),
    { ok: false, reason: "outside_clone" },
  );
  assert.deepEqual(
    await read({ requested: "lib/dir", ports: ports({ "/clone/lib/dir": "" }, { directories: ["/clone/lib/dir"] }) }),
    { ok: false, reason: "not_a_file" },
  );
  assert.deepEqual(await read({ budgetRemaining: 5 }), { ok: false, reason: "budget_exhausted" });
  assert.deepEqual(
    await read({ ports: ports({ "/clone/lib/a.ts": "a\u0000b" }) }),
    { ok: false, reason: "not_text" },
  );
});

/* The request -------------------------------------------------------- */

test("the request goes to the one fixed host, and the key appears only in its header", () => {
  const sentinel = "SENTINEL-KEY-7f3a9c";
  const request = buildModelRequest({
    apiKey: sentinel,
    model: DEFAULT_MODEL,
    system: "system",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(request.url, MODEL_ENDPOINT);
  assert.equal(new URL(request.url).host, "api.anthropic.com");
  assert.equal(request.headers["x-api-key"], sentinel);
  assert.equal(request.headers["anthropic-version"], ANTHROPIC_VERSION);
  assert.ok(!request.body.includes(sentinel));
  const body = JSON.parse(request.body);
  assert.deepEqual(body.tools.map((tool) => tool.name), ["read_file"]);
  assert.equal(body.fallbacks, "default");
  assert.equal(body.max_tokens, SESSION_LIMITS.maxOutputTokens);
});

test("the model call module cannot run anything and never reads the environment", () => {
  const path = new URL("../lib/engineeringAgentModelCall.ts", import.meta.url);
  const source = ts.createSourceFile("m.ts", readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const problems = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const from = node.moduleSpecifier.text;
      if (from !== "node:crypto") problems.push(`import ${from}`);
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) problems.push("dynamic import");
      if (ts.isIdentifier(node.expression) && ["eval", "require", "Function"].includes(node.expression.text)) {
        problems.push(node.expression.text);
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      problems.push("new Function");
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process"
    ) {
      problems.push(`process.${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.deepEqual(problems, []);
});

/* The answer --------------------------------------------------------- */

const answer = (overrides = {}) =>
  JSON.stringify({ manifest: { summary: "Fix x", tests: ["tests/x.test.mjs"] }, patch: "diff --git a/x b/x\n", ...overrides });

test("the answer is exactly manifest and patch, within limits", () => {
  assert.equal(parseModelResult(answer()).ok, true);
  assert.deepEqual(parseModelResult(answer({ patch: "  " })), { ok: false, reason: "no_change" });
  for (const text of [
    "Here is the patch: " + answer(),
    answer({ extra: 1 }),
    JSON.stringify({ manifest: { summary: "x", tests: [], notes: "y" }, patch: "p" }),
    answer({ patch: "p".repeat(64 * 1024 + 1) }),
    JSON.stringify({ manifest: { summary: "x".repeat(2049), tests: [] }, patch: "p" }),
    "[]",
    "not json",
  ]) {
    assert.deepEqual(parseModelResult(text), { ok: false, reason: "schema_invalid" }, text.slice(0, 40));
  }
});

/* The session -------------------------------------------------------- */

const scripted = (responses) => {
  const requests = [];
  const transport = async (request) => {
    requests.push(JSON.parse(request.body));
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { transport, requests };
};

const reply = (stop_reason, content) => ({ status: 200, json: { stop_reason, content } });

test("a tool loop answers every read_file call in one message and returns the parsed answer", async () => {
  const { transport, requests } = scripted([
    reply("tool_use", [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "tool_use", id: "t1", name: "read_file", input: { path: "lib/a.ts" } },
      { type: "tool_use", id: "t2", name: "read_file", input: { path: ".env" } },
    ]),
    reply("end_turn", [{ type: "text", text: answer() }]),
  ]);
  const outcome = await runModelSession({
    apiKey: "k",
    system: "s",
    userContent: "task",
    transport,
    readFile: async (path) =>
      path === "lib/a.ts" ? { ok: true, text: "A", bytes: 1 } : { ok: false, reason: "denied" },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.turns, 2);
  const second = requests[1].messages;
  assert.equal(second[1].role, "assistant");
  assert.equal(second[1].content[0].type, "thinking", "the whole assistant turn goes back");
  assert.equal(second[2].content.length, 2, "both results in one user message");
  assert.equal(second[2].content[1].is_error, true);
});

test("failures are failures, never a change or no change", async () => {
  const run = async (responses) =>
    runModelSession({
      apiKey: "k",
      system: "s",
      userContent: "task",
      transport: scripted(responses).transport,
      readFile: async () => ({ ok: true, text: "x".repeat(10), bytes: 10 }),
    });
  assert.deepEqual(await run([reply("refusal", [])]), { ok: false, reason: "refused" });
  assert.deepEqual(await run([reply("max_tokens", [])]), { ok: false, reason: "output_limit" });
  assert.deepEqual(await run([{ status: 529, json: {} }]), { ok: false, reason: "provider_error", status: 529 });
  assert.deepEqual(await run([new Error("socket hang up")]), { ok: false, reason: "provider_error" });
  assert.deepEqual(await run([reply("pause_turn", [])]), { ok: false, reason: "unexpected_response" });
  assert.deepEqual(await run([reply("end_turn", [{ type: "text", text: "I could not do it." }])]), {
    ok: false,
    reason: "schema_invalid",
  });
  const endless = Array.from({ length: SESSION_LIMITS.maxTurns + 1 }, () =>
    reply("tool_use", [{ type: "tool_use", id: "t", name: "read_file", input: { path: "a" } }]),
  );
  assert.deepEqual(await run(endless), { ok: false, reason: "turn_limit" });
});

test("the tool budget ends the session rather than silently stopping reads", async () => {
  const { transport } = scripted([
    reply("tool_use", [{ type: "tool_use", id: "t", name: "read_file", input: { path: "a" } }]),
  ]);
  const outcome = await runModelSession({
    apiKey: "k",
    system: "s",
    userContent: "task",
    transport,
    readFile: async () => ({ ok: false, reason: "budget_exhausted" }),
  });
  assert.deepEqual(outcome, { ok: false, reason: "tool_budget_exceeded" });
});
