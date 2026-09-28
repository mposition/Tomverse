import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("a head-and-tail cut keeps both ends, names what it dropped, and fits the limit marker included", () => {
  const raw = bytes(`${"h".repeat(20 * 1024)}${"t".repeat(20 * 1024)}`);
  const cut = prepareInput(raw, INPUT_LIMITS.executionBrief);
  const [head, marker, tail] = cut.text.split("\n");
  assert.ok(bytes(cut.text).length <= INPUT_LIMITS.executionBrief.total);
  assert.match(head, /^h+$/);
  assert.ok(head.length < 12 * 1024 && head.length > 12 * 1024 - 128, "the marker comes out of the head's share");
  assert.equal(tail, "t".repeat(4 * 1024));
  assert.equal(marker, `[truncated ${40 * 1024 - head.length - 4 * 1024} bytes, sha256 ${sha256(raw)}]`);
});

/** Control characters other than newline and tab. */
const hasControl = (text) =>
  [...text].some((char) => {
    const point = char.codePointAt(0);
    return (point < 0x20 && point !== 0x09 && point !== 0x0a) || (point >= 0x7f && point <= 0x9f);
  });

/** A deterministic mix of ASCII, Hangul, emoji, control characters and code points NFC expands. */
const mixed = (seed, length) => {
  const pieces = [0x61, 0xac00, 0x1f600, 0x07, 0x1b, 0x0958, 0x2adc, 0x0a, 0xe9, 0x09].map((point) =>
    String.fromCodePoint(point),
  );
  let state = seed;
  let text = "";
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    text += pieces[state % pieces.length];
  }
  return text;
};

test("no input comes out longer than its limit, whatever normalisation does to its size", () => {
  const grows = String.fromCodePoint(0x0958);
  assert.ok(bytes(grows.normalize("NFC")).length > bytes(grows).length, "the fixture really grows under NFC");
  for (let seed = 1; seed <= 40; seed += 1) {
    const raw = bytes(mixed(seed, 2_000 + seed * 700));
    for (const limit of [
      INPUT_LIMITS.issueTitle,
      INPUT_LIMITS.executionBrief,
      INPUT_LIMITS.ciLog,
      INPUT_LIMITS.dependabotBody,
    ]) {
      const prepared = prepareInput(raw, limit);
      const total = typeof limit === "number" ? limit : limit.total;
      assert.ok(bytes(prepared.text).length <= total, `seed ${seed}`);
      assert.ok(!hasControl(prepared.text), `seed ${seed}`);
      assert.equal(prepared.digest, sha256(raw));
      assert.equal(prepared.originalBytes, raw.length);
    }
  }
  assert.throws(() => prepareInput(bytes("x".repeat(100)), { total: 50, head: 10, tail: 40 }), /marker/);
});

test("the run total is met by cutting the CI log first, then the dependabot body, and every source keeps its digest", () => {
  const executionBrief = bytes("b".repeat(15 * 1024));
  const ciLog = bytes("c".repeat(40 * 1024));
  const dependabotBody = bytes("d".repeat(8 * 1024));
  const result = prepareWorkRunInputs({
    executionBrief,
    ciLog,
    dependabotBody,
  });
  assert.equal(result.ok, true);
  const size = (prepared) => (prepared === null ? 0 : bytes(prepared.text).length);
  assert.ok(size(result.brief) + size(result.ciLog) + size(result.dependabotBody) <= INPUT_LIMITS.workRunTotal);
  assert.equal(result.brief.text, "b".repeat(15 * 1024), "the brief is never cut for the total");
  assert.equal(result.dependabotBody.text, "d".repeat(8 * 1024), "the CI log gave way first");
  assert.deepEqual(result.truncated, ["ciLog"]);
  assert.match(
    result.ciLog.text,
    /\n\[truncated \d+ bytes, sha256 [0-9a-f]{64}\]\n/,
    "a recut log still names what it dropped",
  );
  assert.deepEqual(
    [result.brief, result.ciLog, result.dependabotBody].map(({ digest, originalBytes }) => [digest, originalBytes]),
    [executionBrief, ciLog, dependabotBody].map((raw) => [sha256(raw), raw.length]),
  );
  assert.deepEqual(
    prepareWorkRunInputs({
      executionBrief: bytes("ok"),
      ciLog: new Uint8Array([0]),
    }),
    {
      ok: false,
      source: "ciLog",
      detail: "nul_byte",
    },
  );
});

test("a registration round defers what does not fit instead of cutting it again", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    key: `K-${i}`,
    raw: bytes(`${i}`.repeat(9 * 1024)),
  }));
  items.push({ key: "BAD-1", raw: new Uint8Array([0]) });
  const round = prepareRegistrationRound(items);
  assert.equal(round.offered.length, 8);
  assert.deepEqual(round.deferred, ["K-8", "K-9"]);
  assert.deepEqual(round.rejected, ["BAD-1"]);
  assert.equal(round.offered[0].digest, sha256(items[0].raw), "the digest is of the item as received");
  assert.equal(round.offered[0].originalBytes, 9 * 1024);
  assert.equal(round.offered[0].truncated, true);
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
    ports: ports({
      "/clone/lib/a.ts": "export const a = 1;\n",
      "/clone/lib/link.ts": "x",
    }),
    budgetRemaining: 1024,
    ...overrides,
  });

test("read_file returns a tracked, regular, in-clone, non-denied file within budget", async () => {
  assert.deepEqual(await read(), {
    ok: true,
    text: "export const a = 1;\n",
    bytes: 20,
  });
  assert.deepEqual(await read({ requested: "lib/other.ts" }), {
    ok: false,
    reason: "not_tracked",
  });
  assert.deepEqual(await read({ requested: "/etc/passwd" }), {
    ok: false,
    reason: "not_tracked",
  });
  assert.deepEqual(await read({ requested: { path: "lib/a.ts" } }), {
    ok: false,
    reason: "not_tracked",
  });
  assert.deepEqual(await read({ requested: ".env" }), {
    ok: false,
    reason: "denied",
  });
  assert.deepEqual(
    await read({
      requested: "lib/link.ts",
      ports: ports({ "/clone/lib/link.ts": "x" }, { symlinks: ["/clone/lib/link.ts"] }),
    }),
    { ok: false, reason: "symlink" },
  );
  assert.deepEqual(
    await read({
      ports: ports({ "/clone/lib/a.ts": "x" }, { symlinks: ["/clone/lib"] }),
    }),
    { ok: false, reason: "symlink" },
    "a symlinked parent directory is refused too",
  );
  assert.deepEqual(
    await read({
      ports: ports({ "/clone/lib/a.ts": "x" }, { realpaths: { "/clone/lib/a.ts": "/elsewhere/a.ts" } }),
    }),
    { ok: false, reason: "outside_clone" },
  );
  assert.deepEqual(
    await read({
      requested: "lib/dir",
      ports: ports({ "/clone/lib/dir": "" }, { directories: ["/clone/lib/dir"] }),
    }),
    { ok: false, reason: "not_a_file" },
  );
  assert.deepEqual(await read({ budgetRemaining: 5 }), {
    ok: false,
    reason: "budget_exhausted",
  });
  assert.deepEqual(await read({ ports: ports({ "/clone/lib/a.ts": "a\u0000b" }) }), { ok: false, reason: "not_text" });
});

/** A Windows path, written with forward slashes here so no escaping is involved. */
const windowsPath = (forward) => forward.split("/").join(String.fromCharCode(92));

test("the clone root must be its own real path: a symlinked or junctioned root is refused, not followed", async () => {
  const files = { "/clone/lib/a.ts": "export const a = 1;\n" };
  assert.deepEqual(
    await read({
      ports: ports(files, { realpaths: { "/clone": "/elsewhere/clone" } }),
    }),
    { ok: false, reason: "clone_root_not_canonical" },
  );
  assert.deepEqual(
    await read({
      cloneRoot: "/clone/",
      ports: ports(files, { realpaths: { "/clone/": "/clone" } }),
    }),
    { ok: true, text: "export const a = 1;\n", bytes: 20 },
    "a trailing separator is not a different root",
  );
  const windows = { "C:/work/clone/lib/a.ts": "w" };
  assert.deepEqual(
    await read({
      cloneRoot: windowsPath("C:/work/clone"),
      ports: ports(windows, {
        realpaths: {
          [windowsPath("C:/work/clone")]: windowsPath("C:/work/clone"),
          "C:/work/clone/lib/a.ts": windowsPath("C:/work/clone/lib/a.ts"),
        },
      }),
    }),
    { ok: true, text: "w", bytes: 1 },
    "backslashes and a drive letter are the same path",
  );
  assert.deepEqual(
    await read({
      cloneRoot: windowsPath("c:/work/clone"),
      ports: ports(windows, {
        realpaths: {
          [windowsPath("c:/work/clone")]: windowsPath("C:/work/clone"),
        },
      }),
    }),
    { ok: false, reason: "clone_root_not_canonical" },
    "case is not folded: a differently spelled root is refused",
  );
  assert.deepEqual(
    await read({
      cloneRoot: "/",
      ports: ports(files, { realpaths: { "/": "/" } }),
    }),
    {
      ok: false,
      reason: "clone_root_not_canonical",
    },
  );
});

/* The request -------------------------------------------------------- */

test("the request goes to the one fixed host, carries the key only in its header, and asks for no fallback", () => {
  const sentinel = "SENTINEL-KEY-7f3a9c";
  const request = buildModelRequest({
    apiKey: sentinel,
    model: DEFAULT_MODEL,
    system: "system",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(request.url, MODEL_ENDPOINT);
  assert.equal(new URL(request.url).host, "api.anthropic.com");
  assert.deepEqual(Object.keys(request.headers).sort(), ["anthropic-version", "content-type", "x-api-key"]);
  assert.equal(request.headers["x-api-key"], sentinel);
  assert.equal(request.headers["anthropic-version"], ANTHROPIC_VERSION);
  assert.ok(!request.body.includes(sentinel));
  const body = JSON.parse(request.body);
  assert.deepEqual(Object.keys(body).sort(), ["max_tokens", "messages", "model", "system", "tools"]);
  assert.deepEqual(
    body.tools.map((tool) => tool.name),
    ["read_file"],
  );
  assert.equal(body.max_tokens, SESSION_LIMITS.maxOutputTokens);
});

test("the tool budget and the fixed inputs fit inside the request limit (docs/policy/engineering-agent.md §6)", () => {
  assert.ok(SESSION_LIMITS.maxUserContentBytes >= INPUT_LIMITS.workRunTotal);
  assert.ok(SESSION_LIMITS.maxUserContentBytes >= INPUT_LIMITS.registrationRound);
  const fixed = SESSION_LIMITS.maxSystemBytes + SESSION_LIMITS.maxUserContentBytes + SESSION_LIMITS.maxToolBytes;
  assert.ok(fixed < SESSION_LIMITS.maxRequestBytes, "room is left for the model's own turns");
});

test("an oversize input or a request grown past the limit ends the session", async () => {
  const noRead = async () => ({ ok: false, reason: "denied" });
  const never = async () => {
    throw new Error("must not be called");
  };
  const base = {
    apiKey: "k",
    system: "s",
    userContent: "task",
    readFile: noRead,
  };
  assert.deepEqual(
    await runModelSession({
      ...base,
      system: "s".repeat(SESSION_LIMITS.maxSystemBytes + 1),
      transport: never,
    }),
    { ok: false, reason: "input_too_large" },
  );
  assert.deepEqual(
    await runModelSession({
      ...base,
      userContent: "u".repeat(SESSION_LIMITS.maxUserContentBytes + 1),
      transport: never,
    }),
    { ok: false, reason: "input_too_large" },
  );
  const { transport, requests } = scripted([
    reply("tool_use", [
      {
        type: "thinking",
        thinking: "x".repeat(SESSION_LIMITS.maxRequestBytes),
        signature: "sig",
      },
      { type: "tool_use", id: "t", name: "read_file", input: { path: "a" } },
    ]),
  ]);
  assert.deepEqual(await runModelSession({ ...base, transport }), {
    ok: false,
    reason: "request_too_large",
  });
  assert.equal(requests.length, 1, "the oversize request was never sent");
});

/**
 * The module's capability guard, over its own syntax tree and types. It is a
 * function so the fixtures below can show what it catches.
 */
const FORBIDDEN_NAMES = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "navigator",
  "globalThis",
  "global",
  "window",
  "self",
  "process",
  "WebAssembly",
  "Function",
  "eval",
  "require",
  "module",
  "constructor",
  "prototype",
  "__proto__",
  "Reflect",
  "Proxy",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "Worker",
  "importScripts",
  "Deno",
  "Bun",
  "console",
  "prepareStackTrace",
  "captureStackTrace",
  "getPrototypeOf",
  "setPrototypeOf",
  "defineProperty",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

const isAssertion = (node) => ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);

/**
 * Assertion targets that cannot make a value callable, numeric or a byte
 * array: `const`, `string`, `string[]`, records and object shapes whose values
 * are `unknown`, and the module's content block. A union is allowed when every
 * member is.
 */
const allowedAssertionTarget = (type) => {
  if (ts.isUnionTypeNode(type)) return type.types.every(allowedAssertionTarget);
  if (ts.isArrayTypeNode(type)) return allowedAssertionTarget(type.elementType);
  if (type.kind === ts.SyntaxKind.StringKeyword || type.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName.getText();
    if (name === "const" || name === "ContentBlock") return (type.typeArguments ?? []).length === 0;
    if (name === "Record") {
      const [key, value] = type.typeArguments ?? [];
      return key?.kind === ts.SyntaxKind.StringKeyword && value?.kind === ts.SyntaxKind.UnknownKeyword;
    }
    return false;
  }
  if (ts.isTypeLiteralNode(type)) {
    return type.members.every(
      (member) => ts.isPropertySignature(member) && member.type?.kind === ts.SyntaxKind.UnknownKeyword,
    );
  }
  return false;
};

/** An expression that produces a value, as opposed to a name being declared or a type. */
const isValueUse = (node) => {
  if (!(ts.isIdentifier(node) || ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
    return false;
  }
  const parent = node.parent;
  if (ts.isIdentifier(node)) {
    if (ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent) || ts.isTypeQueryNode(parent)) return false;
    if ((ts.isPropertyAccessExpression(parent) && parent.name === node) || ts.isPropertyAssignment(parent) && parent.name === node) {
      return false;
    }
    if (
      (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) ||
        ts.isPropertySignature(parent) || ts.isTypeAliasDeclaration(parent) || ts.isImportSpecifier(parent) ||
        ts.isBindingElement(parent) || ts.isShorthandPropertyAssignment(parent)) &&
      parent.name === node
    ) {
      return false;
    }
  }
  return true;
};

/** `JSON.parse(...)` assigned straight into a variable declared `unknown`: the one place `any` is accepted. */
const isParseIntoUnknown = (node, checker) => {
  if (!ts.isCallExpression(node) || node.expression.getText() !== "JSON.parse") return false;
  const parent = node.parent;
  const declaredUnknown = (declaration) =>
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    declaration.type?.kind === ts.SyntaxKind.UnknownKeyword;
  if (ts.isVariableDeclaration(parent)) return declaredUnknown(parent);
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node &&
    ts.isIdentifier(parent.left)
  ) {
    return declaredUnknown(checker.getSymbolAtLocation(parent.left)?.valueDeclaration);
  }
  return false;
};

const libDirectory = new URL("../lib/", import.meta.url);

const capabilityProblems = (text) => {
  const fileName = fileURLToPath(new URL("engineeringAgentModelCall.guard.ts", libDirectory));
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ["node"],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, ...rest) =>
    path.resolve(name) === fileName
      ? ts.createSourceFile(name, text, language, true)
      : getSourceFile(name, language, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => path.resolve(name) === fileName || fileExists(name);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => (path.resolve(name) === fileName ? text : readFile(name));
  const program = ts.createProgram([fileName], options, host);
  const checker = program.getTypeChecker();
  const source = program.getSourceFiles().find((file) => path.resolve(file.fileName) === fileName);

  // A module the checker rejects cannot be reasoned about by its types.
  const problems = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)].map(
    (diagnostic) => `type error ${diagnostic.code}`,
  );
  const visit = (node) => {
    // Types are only evidence while the module tells the checker nothing it did
    // not infer: no `any` written or flowing, assertions only to the closed list
    // of harmless shapes, and no predicate, assertion signature, overload,
    // ambient declaration, non-null or definite assignment.
    if (node.kind === ts.SyntaxKind.AnyKeyword) problems.push("any");
    if (isAssertion(node) && !allowedAssertionTarget(node.type)) {
      problems.push(`assertion to ${node.type.getText(source)}`);
    }
    if (ts.isTypePredicateNode(node)) problems.push("type predicate");
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body === undefined) {
      problems.push("overload or bodiless declaration");
    }
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) {
      problems.push("ambient declaration");
    }
    if (ts.isModuleDeclaration(node)) problems.push("namespace or global augmentation");
    if (ts.isNonNullExpression(node)) problems.push("non-null assertion");
    if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.exclamationToken) {
      problems.push("definite assignment");
    }
    if (isValueUse(node) && checker.getTypeAtLocation(node).flags & ts.TypeFlags.Any && !isParseIntoUnknown(node, checker)) {
      problems.push(`value typed any: ${node.getText(source).slice(0, 40)}`);
    }
    if (ts.isBindingElement(node) && node.propertyName && ts.isComputedPropertyName(node.propertyName)) {
      problems.push("destructuring by a computed key");
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const from = node.moduleSpecifier?.text;
      if (from !== undefined && from !== "node:crypto") problems.push(`import ${from}`);
    }
    if (ts.isImportEqualsDeclaration(node)) problems.push("import =");
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      problems.push("dynamic import");
    if (ts.isMetaProperty(node)) problems.push("meta property");
    if (node.kind === ts.SyntaxKind.WithStatement) problems.push("with");
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && FORBIDDEN_NAMES.has(node.text.replace(/^#/, ""))) {
      problems.push(node.text);
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && FORBIDDEN_NAMES.has(node.text)) {
      problems.push(`"${node.text}"`);
    }
    if (ts.isIdentifier(node) && node.text === "Object") {
      const parent = node.parent;
      if (!(ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "keys")) {
        problems.push("Object other than Object.keys");
      }
    }
    // Indexing is allowed on byte arrays by number and nowhere else: a byte
    // array's elements are numbers, so no index reaches a function through it.
    if (ts.isElementAccessExpression(node)) {
      const receiver = checker.getTypeAtLocation(node.expression).getSymbol()?.getName();
      const index = checker.getTypeAtLocation(node.argumentExpression);
      if (receiver !== "Uint8Array" || !(index.flags & ts.TypeFlags.NumberLike)) {
        problems.push("index other than a byte array by number");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
};

/**
 * The guard catches honest regressions; it is not a sandbox. TypeScript's
 * checker is not sound (array covariance, method parameter bivariance), so a
 * deliberately disguised edit can still pass it. docs/policy/engineering-agent.md
 * §8 therefore enforces this module with two things: this syntactic check and an
 * independent implementation review bound to the module. This digest is that
 * binding -- any change to the module fails here until the digest is updated,
 * which is when the review of the new text happens. The module is control
 * plane (docs/policy/engineering-agent.md §4), so the agent can never push that
 * change itself.
 */
const REVIEWED_MODULE_SHA256 = "a670802ce8436639e49a9256cd8bb2f962f02a1b0f162904a13ff512ae9c6f92";

test("the model call module is the text its last independent review read", () => {
  const text = readFileSync(new URL("engineeringAgentModelCall.ts", libDirectory), "utf8").replace(/\r\n/g, "\n");
  assert.equal(sha256(text), REVIEWED_MODULE_SHA256);
});

test("the model call module cannot reach the network, the environment or code evaluation except through its transport", () => {
  const own = readFileSync(new URL("engineeringAgentModelCall.ts", libDirectory), "utf8");
  assert.deepEqual(capabilityProblems(own), []);
});

test("the capability guard catches each way around it", () => {
  const fixtures = {
    "a network global": 'fetch("https://other.example/");\n',
    "a request object": "export const x = new XMLHttpRequest();\n",
    "a socket": 'export const x = new WebSocket("wss://other.example/");\n',
    "the global object": "export const x = globalThis.process.env.SECRET;\n",
    "Node's global": "export const x = global;\n",
    "an aliased constructor": 'const F = Function;\nexport const x = F("return 1")();\n',
    "a constructor chain": 'export const x = ({}).constructor.constructor("return 1")();\n',
    "a constructor by literal key": 'export const x = ({})["constructor"];\n',
    "a constructor by built key":
      'const k = "constr" + "uctor";\nexport const x = ({} as Record<string, unknown>)[k];\n',
    reflection: 'export const x = Reflect.get({}, "a");\n',
    "a prototype walk": "export const x = Object.getPrototypeOf(async () => {});\n",
    "an aliased eval": 'const e = eval;\nexport const x = e("1");\n',
    WebAssembly: "export const x = WebAssembly.compile(new Uint8Array());\n",
    "a timer": "export const x = setTimeout(() => {}, 1);\n",
    "a dynamic import": 'export const x = import("node:child_process");\n',
    "a static import": 'import { spawn } from "node:child_process";\nexport const x = spawn;\n',
    "a re-export": 'export { spawn } from "node:child_process";\n',
    "import.meta": "export const x = import.meta.url;\n",
    "a key asserted to be a number":
      'const k = ("constr" + "uctor") as unknown as number;\nconst F = ((() => 0) as any)[k][k];\nconst p = "pro" + "cess";\nexport const x = F("return " + p)().env;\n',
    "a receiver asserted to be a byte array":
      'const k: number = JSON.parse("0");\nexport const x = ({ a: 1 } as unknown as Uint8Array)[k];\n',
    "a record indexed by a string": 'const o: Record<string, () => void> = {};\nconst k = "a";\no[k]();\n',
    "destructuring by a built key": 'const { ["cons" + "tructor"]: c } = {} as Record<string, unknown>;\nexport const x = c;\n',
    "an explicit any": "export const x = (() => 0) as any;\n",
    "logging": 'console.log("the key");\n',
    "a stack trace hook": "Error.prepareStackTrace = () => 0;\n",
    "a type error": 'export const x: number = "not a number";\n',
    "a generic assertion":
      'function lie<T>(x: unknown): T {\n  return x as T;\n}\nconst key = lie<number>("constr" + "uctor");\nexport const x = lie<Uint8Array>(() => 0)[key];\n',
    "an assertion to a callable": "export const x = (0 as unknown) as () => void;\n",
    "any flowing from a parse": 'const k: number = JSON.parse("0");\nexport const x = new Uint8Array(1)[k];\n',
    "any flowing from an array check":
      "const v: unknown = [];\nif (Array.isArray(v)) {\n  const [f] = v;\n  f();\n}\n",
    "a type predicate": "const isBytes = (v: unknown): v is Uint8Array => true;\nexport const x = isBytes(0);\n",
    "an assertion signature": "function check(v: unknown): asserts v is number {}\nexport const x = check;\n",
    "an overload":
      "function f(x: string): number;\nfunction f(x: unknown): unknown {\n  return x;\n}\nexport const x = f(\"a\");\n",
    "an ambient declaration": "declare const bytes: Uint8Array;\nexport const x = bytes[0];\n",
    "a non-null assertion": "const m = new Map<string, number>();\nexport const x = m.get(\"a\")!;\n",
    "a definite assignment": "let b!: Uint8Array;\nexport const x = b[0];\n",
  };
  for (const [label, text] of Object.entries(fixtures)) {
    assert.notDeepEqual(capabilityProblems(text), [], label);
  }
  assert.deepEqual(
    capabilityProblems(
      "const b = new Uint8Array(2);\nlet i = 0;\ni += 1;\nexport const x = b[i] + b[0] + Object.keys({}).length;\n",
    ),
    [],
  );
});

/* The answer --------------------------------------------------------- */

const answer = (overrides = {}) =>
  JSON.stringify({
    manifest: { summary: "Fix x", tests: ["tests/x.test.mjs"] },
    patch: "diff --git a/x b/x\n",
    ...overrides,
  });

test("the answer is exactly manifest and patch, within limits", () => {
  assert.equal(parseModelResult(answer()).ok, true);
  assert.deepEqual(parseModelResult(answer({ patch: "  " })), {
    ok: false,
    reason: "no_change",
  });
  for (const text of [
    "Here is the patch: " + answer(),
    answer({ extra: 1 }),
    JSON.stringify({
      manifest: { summary: "x", tests: [], notes: "y" },
      patch: "p",
    }),
    answer({ patch: "p".repeat(64 * 1024 + 1) }),
    JSON.stringify({
      manifest: { summary: "x".repeat(2049), tests: [] },
      patch: "p",
    }),
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

const reply = (stop_reason, content) => ({
  status: 200,
  json: { stop_reason, content },
});

test("a tool loop answers every read_file call in one message and returns the parsed answer", async () => {
  const { transport, requests } = scripted([
    reply("tool_use", [
      { type: "thinking", thinking: "", signature: "sig" },
      {
        type: "tool_use",
        id: "t1",
        name: "read_file",
        input: { path: "lib/a.ts" },
      },
      {
        type: "tool_use",
        id: "t2",
        name: "read_file",
        input: { path: ".env" },
      },
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
  assert.deepEqual(await run([reply("refusal", [])]), {
    ok: false,
    reason: "refused",
  });
  assert.deepEqual(await run([reply("max_tokens", [])]), {
    ok: false,
    reason: "output_limit",
  });
  assert.deepEqual(await run([{ status: 529, json: {} }]), {
    ok: false,
    reason: "provider_error",
    status: 529,
  });
  assert.deepEqual(await run([new Error("socket hang up")]), {
    ok: false,
    reason: "provider_error",
  });
  assert.deepEqual(await run([reply("pause_turn", [])]), {
    ok: false,
    reason: "unexpected_response",
  });
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
