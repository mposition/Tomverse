import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  CHAT_CODE_RUN_PROMPT,
  CODE_RUN_LIMITS,
  IDLE_CODE_RUN,
  buildCodeRunComposerText,
  chatCodeRunEnabled,
  chatCodeRunPagePath,
  checkCodeRunFileAdd,
  codeRunVendorRequestRefused,
  codeRunPlainText,
  isPythonCodeLanguage,
  parseCodeRunFrameMessage,
  reduceCodeRun,
  sanitizeCodeRunFileName,
  startCodeRun,
  stopCodeRun,
  type CodeRunFrameMessage,
} from "../lib/chatCodeRun.ts";
import {
  CODE_RUN_BLOCKED_GLOBALS,
  CODE_RUN_BLOCKED_NAVIGATOR,
  CODE_RUN_FILES,
  CODE_RUN_FRAME_SOURCE,
  CODE_RUN_PYODIDE_VERSION,
  CODE_RUN_PYTHON_HELPER,
  CODE_RUN_SANDBOX,
  CODE_RUN_VENDOR_PATH,
  CODE_RUN_WORKER_SOURCE,
  buildCodeRunDocument,
  codeRunCsp,
} from "../lib/chatCodeRunFrame.ts";
import { reactPreviewCsp } from "../lib/chatArtifactPreview.ts";
import { createStaticMarketingCsp, createStrictCsp } from "../lib/csp.ts";
import { HTML_PREVIEW_CSP, HTML_PREVIEW_OUTER_CSP, HTML_PREVIEW_SANDBOX, buildHtmlPreviewSrcdoc, htmlPreviewCsp } from "../lib/htmlArtifactPreview.ts";
import { buildChatTurnSystemBlocks } from "../lib/chatTurnSystemBlocks.ts";

const ORIGIN = "https://app.example.test";
const TOKEN = "tokentoken1234";

const withEnv = <T>(value: string | undefined, run: () => T): T => {
  const previous = process.env.TOMVERSE_CHAT_CODE_RUN_ENABLED;
  if (value === undefined) delete process.env.TOMVERSE_CHAT_CODE_RUN_ENABLED;
  else process.env.TOMVERSE_CHAT_CODE_RUN_ENABLED = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TOMVERSE_CHAT_CODE_RUN_ENABLED;
    else process.env.TOMVERSE_CHAT_CODE_RUN_ENABLED = previous;
  }
};

// ---------------------------------------------------------------- the switch

test("the switch is off unless the variable is exactly true", () => {
  assert.equal(chatCodeRunEnabled({}), false);
  for (const value of ["", "false", "1", "TRUE", "True", " true", "true ", "yes", "on"]) {
    assert.equal(chatCodeRunEnabled({ TOMVERSE_CHAT_CODE_RUN_ENABLED: value }), false, JSON.stringify(value));
  }
  assert.equal(chatCodeRunEnabled({ TOMVERSE_CHAT_CODE_RUN_ENABLED: "true" }), true);
  withEnv(undefined, () => assert.equal(chatCodeRunEnabled(), false));
  withEnv("true", () => assert.equal(chatCodeRunEnabled(), true));
});

test("only a python fence is runnable", () => {
  for (const language of ["python", "py", "Python", "python3", "py3"]) assert.equal(isPythonCodeLanguage(language), true, language);
  for (const language of ["js", "html", "jsx", "bash", "pycon", "ruby", "", null, undefined]) assert.equal(isPythonCodeLanguage(language), false, String(language));
});

const turn = {
  modelId: "gpt-5-6-luna",
  provider: "openai",
  isDeepResearchTurn: false,
  isAuthenticated: true,
  canPersist: true,
  nativeSearchEnabled: false,
  nativeSearchForced: false,
  appManagedSearchEnabled: false,
  turnAttachments: [],
  imageGenerationFlagEnabled: true,
  planAllowsImageGeneration: true,
  now: new Date("2026-11-28T00:00:00Z"),
};

test("with the switch off the turn carries no code-run block and no extra tokens; on, the block is sent and priced", () => {
  const off = withEnv(undefined, () => buildChatTurnSystemBlocks(turn));
  const on = withEnv("true", () => buildChatTurnSystemBlocks(turn));
  assert.ok(!off.systemMessages.some((message) => message.content === CHAT_CODE_RUN_PROMPT));
  assert.equal(on.systemMessages.filter((message) => message.content === CHAT_CODE_RUN_PROMPT).length, 1);
  assert.equal(on.systemMessages.length, off.systemMessages.length + 1);
  assert.ok(on.promptTokens > off.promptTokens);
  // The rest of the turn is untouched.
  assert.deepEqual(on.systemMessages.filter((message) => message.content !== CHAT_CODE_RUN_PROMPT), off.systemMessages);
  // A deep-research turn carries no capability blocks, so none about running code.
  const research = withEnv("true", () => buildChatTurnSystemBlocks({ ...turn, isDeepResearchTurn: true }));
  assert.equal(research.systemMessages.length, 0);
});

test("the block keeps the continuation's rules last, and tells the model it never sees the output", () => {
  const seed = { rulesText: "RULES", transcriptText: "TRANSCRIPT" };
  const on = withEnv("true", () => buildChatTurnSystemBlocks({ ...turn, continuationSeed: seed }));
  assert.equal(on.systemMessages.at(-1)?.content, "RULES");
  assert.match(CHAT_CODE_RUN_PROMPT, /numpy, pandas and matplotlib/);
  assert.match(CHAT_CODE_RUN_PROMPT, /no network access/);
  assert.match(CHAT_CODE_RUN_PROMPT, /do not see it/);
  assert.match(CHAT_CODE_RUN_PROMPT, /never state, summarise or invent what a run printed or drew/);
});

// ---------------------------------------------------------------- the policy

test("the runner frame: scripts in a sandbox and nothing more, and a policy that admits one directory", () => {
  assert.equal(CODE_RUN_SANDBOX, "allow-scripts");
  assert.equal(CODE_RUN_SANDBOX, HTML_PREVIEW_SANDBOX);
  const vendor = `${ORIGIN}/vendor/pyodide/${CODE_RUN_PYODIDE_VERSION}/`;
  assert.equal(CODE_RUN_VENDOR_PATH, `/vendor/pyodide/${CODE_RUN_PYODIDE_VERSION}/`);
  assert.equal(
    codeRunCsp(ORIGIN),
    [
      "default-src 'none'",
      `script-src 'unsafe-inline' 'wasm-unsafe-eval' ${vendor}`,
      `connect-src ${vendor}`,
      "worker-src blob:",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "manifest-src 'none'",
    ].join("; ")
  );
  const csp = codeRunCsp(ORIGIN);
  // No CDN, no network to anywhere else, no eval, no images or styles from outside.
  assert.doesNotMatch(csp, /cdn|unpkg|jsdelivr|cloudflare|https:\/\/(?!app\.example\.test)/);
  assert.doesNotMatch(csp, /'unsafe-eval'/);
  assert.doesNotMatch(csp, /'self'/);
  assert.throws(() => codeRunCsp("javascript:alert(1)"));
  assert.throws(() => codeRunCsp("https://app.example.test/path"));
});

test("the HTML and React previews keep exactly the policy they had", () => {
  const cdn = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com";
  assert.equal(
    HTML_PREVIEW_CSP,
    [
      "default-src 'none'",
      `script-src 'unsafe-inline' ${cdn}`,
      `style-src 'unsafe-inline' ${cdn}`,
      "img-src data: blob:",
      `font-src data: ${cdn}`,
      "media-src data: blob:",
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "worker-src 'none'",
      "manifest-src 'none'",
      "webrtc 'block'",
    ].join("; ")
  );
  assert.equal(HTML_PREVIEW_OUTER_CSP, "frame-src 'none'");
  for (const policy of [HTML_PREVIEW_CSP, htmlPreviewCsp(ORIGIN), reactPreviewCsp(ORIGIN)]) {
    assert.doesNotMatch(policy, /wasm-unsafe-eval|worker-src blob|pyodide/);
    assert.match(policy, /connect-src 'none'/);
  }
  assert.match(htmlPreviewCsp(ORIGIN), /worker-src 'none'/);
  // The preview document builder is unchanged: its frame still has the one token and a policy with no worker.
  const srcdoc = buildHtmlPreviewSrcdoc("<p>x</p>", ORIGIN);
  assert.match(srcdoc, /sandbox="allow-scripts"/);
  assert.doesNotMatch(srcdoc, /wasm-unsafe-eval|worker-src blob/);
});

test("the runner document starts with its policy, carries its token and the page's nonce, and cannot be closed early", () => {
  const html = buildCodeRunDocument({ assetOrigin: ORIGIN, token: TOKEN, nonce: "bm9uY2VWYWx1ZQ==" });
  const firstElement = /^<!doctype html><html><head>(<meta[^>]*>)/.exec(html)?.[1];
  assert.ok(firstElement, "the policy meta is the first element of the head");
  assert.equal(firstElement, `<meta http-equiv="Content-Security-Policy" content="${codeRunCsp(ORIGIN)}">`);
  assert.match(html, /<script nonce="bm9uY2VWYWx1ZQ==">/);
  assert.ok(html.includes(`"token":"${TOKEN}"`));
  assert.ok(html.includes(`"parentOrigin":"${ORIGIN}"`));
  // The only script element is ours; text in the embedded sources cannot end it.
  assert.equal(html.match(/<script/g)?.length, 1);
  assert.equal(html.match(/<\/script>/g)?.length, 1);
  // A bad nonce is dropped rather than put into the markup.
  assert.doesNotMatch(buildCodeRunDocument({ assetOrigin: ORIGIN, token: TOKEN, nonce: 'x" onload="alert(1)' }), /onload/);
  assert.doesNotMatch(buildCodeRunDocument({ assetOrigin: ORIGIN, token: TOKEN }), /nonce=/);
  assert.throws(() => buildCodeRunDocument({ assetOrigin: "not an origin", token: TOKEN }));
  assert.throws(() => buildCodeRunDocument({ assetOrigin: ORIGIN, token: 'a"b' }));
});

test("the frame and worker sources are valid scripts, are free of backslashes, and make no network call of their own", () => {
  const configured = (source: string) => `(function(){var CONFIG={base:"x",limits:{},ns:"n",version:1,token:"t",parentOrigin:"o"};${source}\n})`;
  assert.doesNotThrow(() => new vm.Script(configured(CODE_RUN_FRAME_SOURCE)));
  assert.doesNotThrow(() => new vm.Script(configured(CODE_RUN_WORKER_SOURCE)));
  for (const source of [CODE_RUN_FRAME_SOURCE, CODE_RUN_WORKER_SOURCE, CODE_RUN_PYTHON_HELPER]) {
    assert.ok(!source.includes(String.fromCharCode(92)), "no backslash");
    assert.doesNotMatch(source, /\beval\(|new Function|document\.write|innerHTML|XMLHttpRequest|sendBeacon|WebSocket/);
  }
  // The frame never loads a script from anywhere; the worker loads the runtime from the one directory only.
  assert.doesNotMatch(CODE_RUN_FRAME_SOURCE, /importScripts|fetch\(|import\(/);
  assert.match(CODE_RUN_WORKER_SOURCE, /import\(CONFIG\.base \+ "pyodide\.mjs"\)/);
  assert.doesNotMatch(CODE_RUN_WORKER_SOURCE, /micropip|fetch\(|loadPackage\(/);
  // The frame accepts a run only from its parent window, from the app's origin, with its token.
  assert.match(CODE_RUN_FRAME_SOURCE, /event\.source !== window\.parent \|\| event\.origin !== PARENT/);
  assert.match(CODE_RUN_FRAME_SOURCE, /d\.token !== TOKEN/);
  assert.match(CODE_RUN_FRAME_SOURCE, /window\.parent\.postMessage\(message, PARENT\)/);
  // A stop, a time limit and an output limit all end the worker.
  assert.match(CODE_RUN_FRAME_SOURCE, /worker\.terminate\(\)/);
  assert.match(CODE_RUN_FRAME_SOURCE, /finish\("timeout"\)/);
  assert.match(CODE_RUN_FRAME_SOURCE, /finish\("output_limit"\)/);
});

// ------------------------------------------------------- the vendored files

const vendorDir = join(process.cwd(), "public", "vendor", "pyodide", CODE_RUN_PYODIDE_VERSION);

test("every vendored Pyodide file is exactly the pinned one, and nothing else is in the directory", () => {
  const onDisk = readdirSync(vendorDir).sort();
  assert.deepEqual(onDisk, Object.keys(CODE_RUN_FILES).sort());
  for (const name of onDisk) {
    const bytes = readFileSync(join(vendorDir, name));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), CODE_RUN_FILES[name].sha256, name);
    assert.equal(bytes.byteLength, CODE_RUN_FILES[name].bytes, name);
  }
});

test("the lock lists only wheels that are present with the hash the lock states, and a closed dependency set", () => {
  const lock = JSON.parse(readFileSync(join(vendorDir, "pyodide-lock.json"), "utf8")) as {
    info: { python: string };
    packages: Record<string, { file_name: string; sha256: string; depends: string[]; imports: string[] }>;
  };
  assert.match(lock.info.python, /^3\.14\./);
  const names = Object.keys(lock.packages);
  for (const wanted of ["numpy", "pandas", "matplotlib"]) assert.ok(names.includes(wanted), wanted);
  // Nothing that installs or reaches out.
  for (const forbidden of ["micropip", "pyodide-http", "requests", "urllib3"]) assert.ok(!names.includes(forbidden), forbidden);
  for (const [name, entry] of Object.entries(lock.packages)) {
    assert.ok(CODE_RUN_FILES[entry.file_name], `${name} wheel is pinned`);
    assert.equal(createHash("sha256").update(readFileSync(join(vendorDir, entry.file_name))).digest("hex"), entry.sha256, name);
    for (const dependency of entry.depends) assert.ok(names.includes(dependency), `${name} needs ${dependency}`);
  }
  // Every wheel in the directory is in the lock, and the core files are the only other things there.
  const wheels = Object.keys(CODE_RUN_FILES).filter((name) => name.endsWith(".whl")).sort();
  assert.deepEqual(wheels, Object.values(lock.packages).map((entry) => entry.file_name).sort());
  assert.deepEqual(
    Object.keys(CODE_RUN_FILES).filter((name) => !name.endsWith(".whl")).sort(),
    ["pyodide-lock.json", "pyodide.asm.mjs", "pyodide.asm.wasm", "pyodide.mjs", "python_stdlib.zip"]
  );
});

test("the runtime directory stays a bounded size", () => {
  const total = readdirSync(vendorDir).reduce((sum, name) => sum + statSync(join(vendorDir, name)).size, 0);
  assert.ok(total < 40 * 1024 * 1024, `${total} bytes`);
});

// ------------------------------------------------- headers and the page policy

test("the vendored directory is served with CORS and an immutable cache, and the runner's pages alone may compile WebAssembly", () => {
  const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
  assert.match(config, /source: "\/vendor\/pyodide\/:path\*"/);
  const block = config.slice(config.indexOf('source: "/vendor/pyodide/:path*"'), config.indexOf('source: "/:path*"'));
  assert.match(block, /Access-Control-Allow-Origin", value: "\*"/);
  assert.match(block, /immutable/);
  for (const path of ["/chat", "/chat/workspace", "/review", "/continuations/abc", "/settings/imports/conversations/abc"]) {
    assert.equal(chatCodeRunPagePath(path), true, path);
  }
  for (const path of ["/", "/admin", "/admin/chat-e2e", "/pricing", "/chat/other", "/review/x/y", "/en/chat", "/continuations/", undefined, null]) {
    assert.equal(chatCodeRunPagePath(path), false, String(path));
  }
});

test("'wasm-unsafe-eval' is in the page policy only with the switch on and only on an answer page", () => {
  const nonce = "bm9uY2U=";
  const scriptSrc = (policy: string) => policy.split("; ").find((directive) => directive.startsWith("script-src "))!;
  const plain = withEnv(undefined, () => createStrictCsp(nonce, "/chat"));
  assert.doesNotMatch(plain, /wasm-unsafe-eval/);
  assert.equal(withEnv("false", () => createStrictCsp(nonce, "/chat")), plain);
  const on = withEnv("true", () => createStrictCsp(nonce, "/chat"));
  assert.match(scriptSrc(on), /'strict-dynamic' 'wasm-unsafe-eval'/);
  // Nothing else in the policy moved.
  assert.equal(on.replace(" 'wasm-unsafe-eval'", ""), plain);
  for (const path of [undefined, "/", "/admin/models", "/auth/desktop", "/chat/other"]) {
    assert.doesNotMatch(withEnv("true", () => createStrictCsp(nonce, path)), /wasm-unsafe-eval/, String(path));
  }
  assert.doesNotMatch(withEnv("true", () => createStaticMarketingCsp()), /wasm-unsafe-eval/);
  assert.doesNotMatch(withEnv("true", () => createStrictCsp(nonce, "/chat")), /'unsafe-eval'/);
});

// ------------------------------------------------------------- the messages

const message = (extra: Record<string, unknown>) => ({ ns: "tomverse-code-run", v: 1, token: TOKEN, ...extra });
const parse = (data: unknown) => parseCodeRunFrameMessage(data, { token: TOKEN });
const done = { type: "done", runId: "run1", status: "ok", value: null, error: null, skippedFigures: 0, durationMs: 12 };

test("a frame message is believed only with the right namespace, version and token", () => {
  assert.deepEqual(parse(message({ type: "ready" })), { type: "ready" });
  assert.equal(parse({ ...message({ type: "ready" }), token: "someone-elses" }), null);
  assert.equal(parse({ ...message({ type: "ready" }), ns: "other" }), null);
  assert.equal(parse({ ...message({ type: "ready" }), v: 2 }), null);
  for (const junk of [null, undefined, "ready", 5, [], [message({ type: "ready" })], { type: "ready" }]) assert.equal(parse(junk), null, JSON.stringify(junk));
  assert.equal(parse(message({ type: "run", runId: "r", code: "x", files: [] })), null, "the frame cannot send a run");
  assert.equal(parse(message({ type: "unknown" })), null);
});

test("each message kind is checked for the kind and size of every field", () => {
  assert.deepEqual(parse(message({ type: "phase", runId: "run1", phase: "packages" })), { type: "phase", runId: "run1", phase: "packages" });
  assert.equal(parse(message({ type: "phase", runId: "run1", phase: "other" })), null);
  assert.equal(parse(message({ type: "phase", runId: "has space", phase: "running" })), null);
  assert.equal(parse(message({ type: "phase", runId: "x".repeat(65), phase: "running" })), null);

  assert.deepEqual(parse(message({ type: "output", runId: "run1", stream: "stdout", text: "hi" })), { type: "output", runId: "run1", stream: "stdout", text: "hi" });
  assert.equal(parse(message({ type: "output", runId: "run1", stream: "stdout", text: "x".repeat(CODE_RUN_LIMITS.maxChunkChars + 1) })), null);
  assert.equal(parse(message({ type: "output", runId: "run1", stream: "stdin", text: "hi" })), null);
  assert.equal(parse(message({ type: "output", runId: "run1", stream: "stdout", text: 5 })), null);

  const png = "data:image/png;base64,iVBORw0KGgo=";
  assert.deepEqual(parse(message({ type: "image", runId: "run1", dataUrl: png })), { type: "image", runId: "run1", dataUrl: png });
  for (const dataUrl of [
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "data:text/html;base64,PGgxPg==",
    "https://example.com/x.png",
    "javascript:alert(1)",
    "data:image/png;base64,AAA\"onerror=\"x",
    "data:image/png;base64," + "A".repeat(CODE_RUN_LIMITS.maxImageBase64Chars + 100),
    "data:image/png,rawtext",
    5,
  ]) {
    assert.equal(parse(message({ type: "image", runId: "run1", dataUrl })), null, String(dataUrl).slice(0, 40));
  }

  assert.deepEqual(parse(message(done)), { ...done, value: null, error: null });
  assert.equal(parse(message({ ...done, status: "weird" })), null);
  assert.equal(parse(message({ ...done, value: "x".repeat(CODE_RUN_LIMITS.maxValueChars + 1) })), null);
  assert.equal(parse(message({ ...done, error: 5 })), null);
  assert.equal(parse(message({ ...done, skippedFigures: -1 })), null);
  assert.equal(parse(message({ ...done, skippedFigures: 1.5 })), null);
  assert.equal(parse(message({ ...done, durationMs: Number.NaN })), null);
  assert.equal(parse(message({ ...done, durationMs: -1 })), null);
});

// -------------------------------------------------------------- the state

const feed = (messages: CodeRunFrameMessage[], from = startCodeRun("run1")) => messages.reduce(reduceCodeRun, from);

test("a run's state follows the frame's messages, merges adjacent output and ignores another run's", () => {
  let state = startCodeRun("run1");
  assert.equal(state.status, "loading");
  state = feed(
    [
      { type: "phase", runId: "run1", phase: "packages" },
      { type: "phase", runId: "run1", phase: "running" },
      { type: "output", runId: "run1", stream: "stdout", text: "a\n" },
      { type: "output", runId: "run1", stream: "stdout", text: "b\n" },
      { type: "output", runId: "run1", stream: "stderr", text: "warn\n" },
      { type: "output", runId: "other", stream: "stdout", text: "NOT MINE\n" },
      { type: "image", runId: "run1", dataUrl: "data:image/png;base64,AAAA" },
      { type: "done", runId: "run1", status: "error", value: "42", error: "Traceback", skippedFigures: 2, durationMs: 5 },
    ],
    state
  );
  assert.equal(state.status, "done");
  assert.equal(state.outcome, "error");
  assert.deepEqual(state.segments, [{ stream: "stdout", text: "a\nb\n" }, { stream: "stderr", text: "warn\n" }]);
  assert.equal(state.images.length, 1);
  assert.equal(state.skippedFigures, 2);
  assert.equal(codeRunPlainText(state), "a\nb\nwarn\n\n42\nTraceback");
  // Once done, a late message changes nothing.
  assert.equal(reduceCodeRun(state, { type: "output", runId: "run1", stream: "stdout", text: "late" }), state);
  // A frame's "ready" never touches a run.
  assert.equal(reduceCodeRun(IDLE_CODE_RUN, { type: "ready" }), IDLE_CODE_RUN);
});

test("the page enforces the output and figure limits again on what it receives", () => {
  let state = startCodeRun("run1");
  const big = "x".repeat(CODE_RUN_LIMITS.maxChunkChars);
  for (let i = 0; i < 20; i += 1) state = reduceCodeRun(state, { type: "output", runId: "run1", stream: "stdout", text: big });
  assert.equal(state.outputChars, CODE_RUN_LIMITS.maxOutputChars);
  assert.equal(state.segments.reduce((sum, segment) => sum + segment.text.length, 0), CODE_RUN_LIMITS.maxOutputChars);
  for (let i = 0; i < CODE_RUN_LIMITS.maxImages + 3; i += 1) state = reduceCodeRun(state, { type: "image", runId: "run1", dataUrl: "data:image/png;base64,AAAA" });
  assert.equal(state.images.length, CODE_RUN_LIMITS.maxImages);
  assert.equal(state.skippedFigures, 3);
});

test("Stop ends a running run and leaves a finished one alone", () => {
  const running = startCodeRun("run1");
  assert.equal(stopCodeRun(running).outcome, "stopped");
  assert.equal(stopCodeRun(running).status, "done");
  const finished = feed([{ type: "done", runId: "run1", status: "ok", value: null, error: null, skippedFigures: 0, durationMs: 1 }]);
  assert.equal(stopCodeRun(finished), finished);
  assert.equal(stopCodeRun(IDLE_CODE_RUN), IDLE_CODE_RUN);
});

test("the numbers that bound a run are the ones the policy states", () => {
  assert.equal(CODE_RUN_LIMITS.runTimeoutMs, 30_000);
  assert.equal(CODE_RUN_LIMITS.maxOutputChars, 100_000);
  assert.equal(CODE_RUN_LIMITS.maxImages, 6);
  assert.equal(CODE_RUN_LIMITS.maxFiles, 5);
  assert.equal(CODE_RUN_LIMITS.maxFileBytes, 10 * 1024 * 1024);
  assert.equal(CODE_RUN_LIMITS.maxTotalFileBytes, 20 * 1024 * 1024);
  assert.ok(CODE_RUN_LIMITS.loadTimeoutMs > CODE_RUN_LIMITS.runTimeoutMs);
});

// ------------------------------------------------- composer text and files

test("the composer text is a request and the output in a fence that the output cannot close", () => {
  assert.equal(buildCodeRunComposerText("Explain.", "a\nb\n"), "Explain.\n\n```text\na\nb\n```");
  const tricky = buildCodeRunComposerText("Explain.", "before\n```\nafter");
  assert.match(tricky, /^Explain\.\n\n````text\n/);
  assert.ok(tricky.endsWith("\n````"));
  const long = buildCodeRunComposerText("Explain.", "z".repeat(CODE_RUN_LIMITS.composerOutputChars + 500));
  assert.ok(long.includes("\n..."));
  assert.ok(long.length < CODE_RUN_LIMITS.composerOutputChars + 100);
});

test("file names are reduced to a safe bounded name and file additions are bounded", () => {
  assert.equal(sanitizeCodeRunFileName("sales 2026.csv"), "sales 2026.csv");
  assert.equal(sanitizeCodeRunFileName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeCodeRunFileName("C:\\Users\\me\\data.json"), "data.json");
  assert.equal(sanitizeCodeRunFileName(".hidden"), "hidden");
  assert.equal(sanitizeCodeRunFileName("a<b>|c.txt"), "a_b__c.txt");
  assert.equal(sanitizeCodeRunFileName(""), "file");
  assert.equal(sanitizeCodeRunFileName("..."), "file");
  assert.ok(sanitizeCodeRunFileName("n".repeat(500)).length <= CODE_RUN_LIMITS.maxFileNameChars);
  assert.equal(checkCodeRunFileAdd([], { size: 10 }), null);
  assert.equal(checkCodeRunFileAdd([], { size: CODE_RUN_LIMITS.maxFileBytes + 1 }), "size");
  assert.equal(checkCodeRunFileAdd(Array.from({ length: CODE_RUN_LIMITS.maxFiles }, () => ({ size: 1 })), { size: 1 }), "count");
  assert.equal(checkCodeRunFileAdd([{ size: CODE_RUN_LIMITS.maxFileBytes }, { size: CODE_RUN_LIMITS.maxFileBytes }], { size: 1 }), "total");
});

// ------------------------------------------- the worker has no network left

/** The worker source is a JSON string inside the page, so its quotes arrive escaped. */
const BACKSLASH = String.fromCharCode(92);
const MUST_BE_REMOVED = [
  "fetch", "Request", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport",
  "importScripts", "Worker", "SharedWorker", "caches",
];

test("the worker removes every request maker, and the list cannot lose one unnoticed", () => {
  for (const name of MUST_BE_REMOVED) assert.ok((CODE_RUN_BLOCKED_GLOBALS as readonly string[]).includes(name), name);
  for (const name of ["sendBeacon", "serviceWorker"]) assert.ok((CODE_RUN_BLOCKED_NAVIGATOR as readonly string[]).includes(name), name);
  assert.equal(new Set(CODE_RUN_BLOCKED_GLOBALS).size, CODE_RUN_BLOCKED_GLOBALS.length, "no duplicates");
  // The built worker script carries exactly these lists.
  const html = buildCodeRunDocument({ assetOrigin: ORIGIN, token: TOKEN });
  for (const name of [...CODE_RUN_BLOCKED_GLOBALS, ...CODE_RUN_BLOCKED_NAVIGATOR]) assert.ok(html.includes(BACKSLASH + '"' + name + BACKSLASH + '"'), name);
  assert.ok(html.includes(BACKSLASH + '"blocked' + BACKSLASH + '":'));
  assert.ok(html.includes(BACKSLASH + '"blockedNavigator' + BACKSLASH + '":'));
});

test("the network is removed after the packages are in and before the code runs, from the global and every prototype", () => {
  const source = CODE_RUN_WORKER_SOURCE;
  const packages = source.indexOf("loadPackagesFromImports(message.code");
  const removal = source.indexOf("    removeNetwork();");
  const running = source.indexOf('phase: "running"');
  const runner = source.indexOf("await runner(message.code");
  assert.ok(packages > 0 && removal > packages && running > removal && runner > running, "order: packages, removal, running, code");
  assert.match(source, /Object\.getPrototypeOf\(scope\)/);
  assert.match(source, /delete scopes\[s\]\[name\]/);
  assert.match(source, /configurable: false/);
  // It fails closed: a name still callable afterwards ends the run before the code starts.
  assert.match(source, /the sandbox could not remove/);
  // One run per worker.
  assert.match(source, /message\.type === "run" && !used/);
});

test("the worker script is a function, so none of its own helpers are globals the code can reach", () => {
  const html = buildCodeRunDocument({ assetOrigin: ORIGIN, token: TOKEN });
  assert.ok(html.includes("(function(){var CONFIG="), "the worker source is wrapped in a function");
  assert.ok(html.includes('})();"'), "the function is called with the configuration");
});

test("a finished worker is ended and the next one started warm; a stop, limit or crash only ends it", () => {
  const finish = CODE_RUN_FRAME_SOURCE.slice(CODE_RUN_FRAME_SOURCE.indexOf("function finish("), CODE_RUN_FRAME_SOURCE.indexOf("function forwardOutput("));
  assert.match(finish, /endWorker\(\);\n  if \(status === "ok" \|\| status === "error"\)/);
  assert.match(finish, /spawn\(\); worker\.postMessage\(\{ type: "boot" \}\)/);
});

test("Python cannot run JavaScript from a string: the frame policy and the page policy carry no 'unsafe-eval'", () => {
  // `Function`, `eval`, `setTimeout("...")` and Pyodide's `run_js` all evaluate a string; with no 'unsafe-eval' the
  // browser refuses each (measured in Chromium), so a dynamic import() -- which cannot be removed -- is out of reach.
  assert.doesNotMatch(codeRunCsp(ORIGIN), /unsafe-eval(?!')/);
  assert.doesNotMatch(codeRunCsp(ORIGIN), /'unsafe-eval'/);
  const nonce = "bm9uY2U=";
  assert.doesNotMatch(withEnv("true", () => createStrictCsp(nonce, "/chat")), /'unsafe-eval'/);
  assert.match(codeRunCsp(ORIGIN), /'wasm-unsafe-eval'/);
});

test("the server refuses a query string or a body on the runtime directory, before anything else of the proxy", () => {
  const dir = "/vendor/pyodide/314.0.8/";
  assert.equal(codeRunVendorRequestRefused(`${dir}pyodide.asm.wasm`, "GET", ""), false);
  assert.equal(codeRunVendorRequestRefused(`${dir}pyodide.asm.wasm`, "HEAD", ""), false);
  assert.equal(codeRunVendorRequestRefused(`${dir}pyodide-lock.json`, "GET", "?leak=1"), true);
  assert.equal(codeRunVendorRequestRefused(`${dir}x`, "POST", ""), true);
  assert.equal(codeRunVendorRequestRefused(`${dir}x`, "PUT", ""), true);
  assert.equal(codeRunVendorRequestRefused("/vendor/pyodide/", "DELETE", ""), true);
  // Other paths are not this check's business.
  assert.equal(codeRunVendorRequestRefused("/vendor/artifact-preview/react.js", "GET", "?v=1"), false);
  assert.equal(codeRunVendorRequestRefused("/api/chat", "POST", "?x=1"), false);
  const proxy = readFileSync(join(process.cwd(), "proxy.ts"), "utf8");
  const call = proxy.indexOf("codeRunVendorRequestRefused(request.nextUrl.pathname");
  assert.ok(call > proxy.indexOf("blockedOriginResponse();"), "after the host and origin checks");
  assert.ok(call < proxy.indexOf("stripInternalAuthHeaders(requestHeaders)"), "before the rest of the proxy");
});
