/**
 * The control-plane slice: product files whose change can alter what the
 * control plane does even though the control plane's own files are untouched.
 *
 * docs/policy/engineering-agent.md §4 ("통제 평면에 닿는 제품 파일") and
 * version 6 item 2 are the contract. The entry points are the gate files that
 * run in the application (the runtime control plane); the slice is every file
 * they import, directly or through other files, and every file that code
 * names by path. Another product file is not in the slice merely because the
 * deployed image contains it.
 *
 * Configuration is part of it too: an environment variable the control plane
 * or the slice reads, and every AppSetting key, is a name a change may not add.
 *
 * The analysis fails closed. A file that does not parse, an import TypeScript
 * cannot resolve to tracked code, a bare specifier that is neither a runtime
 * builtin, a declared dependency nor a workspace package, or a runtime
 * control-plane module that assembles what it loads fails the whole patch --
 * never one file. It runs in the app, which may use the TypeScript compiler;
 * it resolves modules the way `tsc` does with this repository's tsconfig.
 */

import { builtinModules } from "node:module";

import ts from "typescript";

import { classifyPath } from "./agentAuthorityFiles.ts";

export type SourceFile = { path: string; text: string };

export type SliceProblem = { path: string; specifier: string | null; problem: string };

const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const ROOT = "/repo";

/**
 * The runtime control plane: control-plane code that runs in the product.
 * Root files (`proxy.ts`, `instrumentation.ts`, framework configuration) are
 * included. Control-plane code outside the app is `isGateOutsideRuntime`.
 */
export const isRuntimeControlPlane = (path: string) =>
  isAppRuntimeCode(path) && classifyPath(path) === "control-plane";

/**
 * Gate code that runs outside the app: scripts, CI and operator tooling,
 * build and framework configuration, the mobile apps. What it imports or names
 * is in the slice like a runtime gate's (policy version 6 item 2). Tests are
 * left out -- an unchanged test stays the oracle, and the evidence reads no
 * text for the tests the image leaves out -- and so is the vendored AMUX
 * server, a separate program whose text the evidence does not read either.
 */
export const isGateOutsideRuntime = (path: string) =>
  CODE_FILE.test(path) && !isAppRuntimeCode(path) && classifyPath(path) === "control-plane" &&
  !path.startsWith("tests/") && !path.startsWith("vendor/");

/**
 * Gate files that are not code but run or steer what runs: workflows and
 * actions, shell scripts, container and deploy configuration, the root
 * manifest's scripts. A repository path they spell out (`require("./docs/x.json")`
 * in a workflow step) is in the slice, and so is every file a glob they spell
 * out matches (`cat docs/ops/*.json`). Comment lines do not count, nor do a
 * workflow's trigger filters (`paths:`, `branches:` and the like), which
 * choose when it runs, not what it reads.
 */
export const isTextGate = (path: string) =>
  !path.startsWith("vendor/") &&
  // Any manifest's scripts may be what a gate runs, product packages' too.
  (/(?:^|\/)package\.json$/.test(path) ||
  (classifyPath(path) === "control-plane" &&
  (/^\.github\/(?:workflows|actions)\/.+\.ya?ml$/.test(path) || /\.(?:sh|ps1)$/.test(path) ||
    /(?:^|\/)Dockerfile[^/]*$/.test(path) ||
    /^(?:\.railway\/.+|railway[^/]*)\.(?:json|toml)$/.test(path))));

// A forward or back slash separates segments: PowerShell spells `.\docs\x.json`.
const TEXT_PATH = /[A-Za-z0-9_.@*?{},[\]-]+(?:[/\\][A-Za-z0-9_.@*?{},[\]-]+)+/g;
const TRIGGER_FILTER = /^(\s*)(?:paths|paths-ignore|branches|branches-ignore|tags|tags-ignore):(.*)$/;

const globPattern = (glob: string) => {
  let source = "";
  let braces = 0;
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (glob.startsWith("**/", index)) {
      // Zero or more directories.
      source += "(?:.*/)?";
      index += 2;
    } else if (glob.startsWith("**", index)) {
      source += ".*";
      index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "{") {
      source += "(?:";
      braces += 1;
    } else if (char === "}" && braces > 0) {
      source += ")";
      braces -= 1;
    } else if (char === "," && braces > 0) source += "|";
    // A shell class negates with `!`, a regular expression with `^`. Outside
    // braces a comma is a comma.
    else if (char === "[") source += glob[index + 1] === "!" ? (index += 1, "[^") : "[";
    else if (char === "]") source += char;
    else source += char.replace(/[.+^$()|\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${source}$`);
  } catch {
    // A glob this cannot read means every file below its fixed head.
    const head = glob.slice(0, glob.search(/[*?{[]/));
    return new RegExp(`^${head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  }
};

/**
 * What a text gate spells out, outside comment lines and workflow trigger
 * filters: exact paths, and the globs it reads through, both as written (the
 * caller reads them as repository paths the way it reads any named path).
 */
export const textGatePaths = (path: string, text: string): { exact: Set<string>; globs: string[] } => {
  const exact = new Set<string>();
  const globs: string[] = [];
  const workflow = /^\.github\/workflows\/.+\.ya?ml$/.test(path);
  // Trigger filters live only in the workflow's top-level `on:` block; the
  // same keys elsewhere (a step's `with: paths:`) name what it reads.
  let inTriggers = false;
  let filterIndent: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) inTriggers = workflow && /^(?:on|"on"|'on'):\s*(?:#.*)?$/.test(line);
    if (filterIndent !== null) {
      // A filter's list sits deeper than its key, or level with it as `- item`.
      if (indent > filterIndent || (indent === filterIndent && /^\s*-/.test(line))) continue;
      filterIndent = null;
    }
    const filter = inTriggers ? TRIGGER_FILTER.exec(line) : null;
    if (filter) {
      if (filter[2].trim() === "") filterIndent = filter[1].length;
      continue;
    }
    for (const match of line.matchAll(TEXT_PATH)) {
      // A comma separates paths outside braces; a bracket with no partner is
      // the list around the path, not part of it.
      const pieces = match[0].includes("{") ? [match[0]] : match[0].split(",");
      for (const piece of pieces) {
        let token = piece.replace(/[.]+$/, "");
        // `[docs/x.json]` is a one-item list, not a character class.
        const listed = /^\[([^[\]]*)\]$/.exec(token);
        if (listed) token = listed[1];
        if (!token.includes("]")) token = token.replace(/^\[+/, "");
        if (!token.includes("[")) token = token.replace(/\]+$/, "");
        token = normalisePathText(token.replace(/^[{}]+/, ""));
        if (!token.includes("/")) continue;
        // A path behind a runner variable (`$GITHUB_WORKSPACE/patch/x`,
        // `${{ github.workspace }}/x.json`) keeps the variable as its first
        // segments; every tail of the path is read as well.
        const segments = token.split("/");
        for (let start = 0; start < segments.length - 1; start += 1) {
          // A tail starting at a wildcard would read the whole tree.
          if (start > 0 && /[*?{[]/.test(segments[start])) continue;
          const tail = segments.slice(start).join("/");
          if (/[*?{[]/.test(tail)) globs.push(tail);
          else exact.add(tail);
        }
      }
    }
    // A single segment can be a top-level directory it reads (`find docs`,
    // `cp -r ./public out`); the caller treats every exact path as a directory
    // as well. An absolute one (`/app`, the image root) is a destination, and a
    // `key:` is YAML.
    for (const word of line.split(/[\s"'`=(),;[\]{}|&<>]+/)) {
      if (word === "" || word.startsWith("/") || word.endsWith(":") || word.startsWith("$")) continue;
      const single = word.replace(/^(?:\.[/\\])+/, "").replace(/[/\\]+$/, "");
      if (/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(single)) exact.add(single);
    }
  }
  return { exact, globs };
};

/* ------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* ------------------------------------------------------------------------- */

const parse = (file: SourceFile) => ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, false);

/** Whether the parser reported anything; a file it cannot read is not a graph node. */
export const hasParseErrors = (source: ts.SourceFile) =>
  ((source as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length > 0;

const isStringLiteral = (node: ts.Node | undefined) =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

export type CodeFacts = {
  /** `import(x)`/`require(x)` with a computed argument, `require.resolve`, `createRequire`, `import.meta.glob`. */
  runtimeLoader: boolean;
  /** A call through a computed member: `table[name](...)`. */
  computedCall: boolean;
  /** `process.env[expr]` with a computed key. */
  computedEnv: boolean;
  /** Any access to the AppSetting model. */
  appSettingAccess: boolean;
  /** Imports a builtin that loads or runs code by a name it is given. */
  loadingBuiltin: boolean;
  /** Of those, one that loads code into this process (not a child process). */
  inProcessLoad: boolean;
};

/** The objects that hold a module loader. */
const LOADER_HOSTS = new Set(["module", "require", "globalThis", "global", "process"]);

/**
 * Whether a callee may be the module loader: "require" for `require`,
 * `x.require` and `x["require"]`; "unknown" for a loader host's member reached
 * by a computed key (`module[key]`), which could be it; null otherwise. Another
 * object's computed member (`handlers[type]()`) is reflection, not loading: a
 * change that adds a load through it edits a file the gates follow, which is
 * in the slice already.
 */
const calleeMayRequire = (callee: ts.Expression): "require" | "unknown" | null => {
  if (ts.isIdentifier(callee)) return callee.text === "require" ? "require" : null;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === "require" ? "require" : null;
  if (ts.isElementAccessExpression(callee)) {
    const key = callee.argumentExpression;
    if (isStringLiteral(key)) return (key as ts.StringLiteral).text === "require" ? "require" : null;
    const host = unwrap(callee.expression);
    return ts.isIdentifier(host) && LOADER_HOSTS.has(host.text) ? "unknown" : null;
  }
  return null;
};

/** An expression with its parentheses and type assertions taken off. */
const unwrap = (node: ts.Expression): ts.Expression => {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
  return current;
};

const isRequireReference = (node: ts.Node) =>
  (ts.isIdentifier(node) && node.text === "require") ||
  (ts.isPropertyAccessExpression(node) && node.name.text === "require") ||
  (ts.isElementAccessExpression(node) && isStringLiteral(node.argumentExpression) &&
    (node.argumentExpression as ts.StringLiteral).text === "require");

/** What runs code from text. */
const DYNAMIC_CODE = new Set(["eval", "Function", "AsyncFunction", "GeneratorFunction", "AsyncGeneratorFunction"]);

/**
 * The host whose loader is handed on by handing on the host itself:
 * `module.require`. Node puts no `require` on `globalThis` or `global`.
 */
const ESCAPING_HOSTS = new Set(["module"]);

/** Facts read from the syntax tree, so the same words in a comment or string do not count. */
export const codeFacts = (source: ts.SourceFile): CodeFacts => {
  const facts: CodeFacts = {
    runtimeLoader: false, computedCall: false, computedEnv: false, appSettingAccess: false, loadingBuiltin: false,
    inProcessLoad: false,
  };
  // The loader may only be called on the spot. A `require` reference that is
  // not the callee of a call -- `const load = module.require.bind(module)`,
  // `run(require)` -- hands the loader on, and so does a loader host itself
  // handed on (`run(module)`), so either counts as a computed load.
  const called = new Set<ts.Node>();
  const notValues = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      notValues.add(node.name);
      notValues.add(unwrap(node.expression));
    }
    if (ts.isElementAccessExpression(node) && isStringLiteral(node.argumentExpression)) {
      notValues.add(unwrap(node.expression));
    }
    if (ts.isTypeOfExpression(node)) notValues.add(unwrap(node.expression));
    // Type positions name types, not values.
    if (ts.isTypeReferenceNode(node)) notValues.add(node.typeName);
    if (ts.isQualifiedName(node)) notValues.add(node.left);
    if (ts.isTypeQueryNode(node)) notValues.add(node.exprName);
    // Names that declare or label something, not references.
    if ((ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node) || ts.isMethodSignature(node) || ts.isVariableDeclaration(node) ||
        ts.isParameter(node) || ts.isFunctionDeclaration(node) || ts.isBindingElement(node) ||
        ts.isImportSpecifier(node)) &&
        node.name !== undefined) {
      notValues.add(node.name);
    }
    if (isRequireReference(node) && !called.has(node) && !notValues.has(node)) facts.runtimeLoader = true;
    if (ts.isIdentifier(node) && ESCAPING_HOSTS.has(node.text) && !notValues.has(node)) facts.runtimeLoader = true;
    if (ts.isElementAccessExpression(node) && !isStringLiteral(node.argumentExpression)) {
      const host = unwrap(node.expression);
      if (ts.isIdentifier(host) && LOADER_HOSTS.has(host.text)) facts.runtimeLoader = true;
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      called.add(callee);
      if (callee.kind === ts.SyntaxKind.ImportKeyword && !isStringLiteral(node.arguments[0])) {
        facts.runtimeLoader = true;
      }
      // `require(name)`, `module.require(name)`, `module["require"](name)`,
      // whatever `require` is bound to here: a local helper of that name is
      // still read as the loader, and so is a loader host's member called
      // through a computed key (`module[key](name)`).
      const may = calleeMayRequire(callee);
      if ((may === "require" && !isStringLiteral(node.arguments[0])) || may === "unknown") {
        facts.runtimeLoader = true;
      }
      // A call through an element access -- `table[name]()` or `table["gate"]()`
      // -- is reflection this does not resolve to a symbol, literal key or not.
      if (ts.isElementAccessExpression(callee)) {
        facts.computedCall = true;
      }
    }
    if (ts.isIdentifier(node) && node.text === "createRequire") facts.runtimeLoader = true;
    // Code run from text: `eval` and the Function constructors in any value
    // use -- called, handed on (`const F = Function`), or reached as a member
    // (`globalThis.eval`, `x["Function"]`) -- and any `.constructor` called or
    // constructed, which reaches Function from any function value.
    if (ts.isIdentifier(node) && DYNAMIC_CODE.has(node.text) && !notValues.has(node)) facts.runtimeLoader = true;
    if (ts.isPropertyAccessExpression(node) && DYNAMIC_CODE.has(node.name.text)) facts.runtimeLoader = true;
    if (ts.isElementAccessExpression(node) && isStringLiteral(node.argumentExpression) &&
        DYNAMIC_CODE.has((node.argumentExpression as ts.StringLiteral).text)) facts.runtimeLoader = true;
    if ((ts.isCallExpression(node) || ts.isNewExpression(node))) {
      const callee = unwrap(node.expression);
      if ((ts.isPropertyAccessExpression(callee) && callee.name.text === "constructor") ||
          (ts.isElementAccessExpression(callee) && isStringLiteral(callee.argumentExpression) &&
            (callee.argumentExpression as ts.StringLiteral).text === "constructor")) facts.runtimeLoader = true;
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") facts.runtimeLoader = true;
      if (ts.isMetaProperty(node.expression) && node.name.text === "glob") facts.runtimeLoader = true;
      if (node.name.text === "appSetting") facts.appSettingAccess = true;
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "process" &&
      node.expression.name.text === "env" &&
      !isStringLiteral(node.argumentExpression)
    ) {
      facts.computedEnv = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const builtinUse = loadsThroughBuiltin(source);
  facts.loadingBuiltin = builtinUse.inProcess || builtinUse.childProcess;
  facts.inProcessLoad = builtinUse.inProcess;
  return facts;
};

/**
 * Programs that run code they are handed, the repository's included, by
 * name, path or platform suffix (`/usr/bin/node`, `node.exe`, `python3.12`),
 * and the wrappers that run another program (`env`, `sudo`).
 */
const isCodeRunner = (program: string) => {
  const base = (program.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1|sh)$/, "");
  // A runner missing from this list is a gap; the policy note records it.
  return /^(?:node(?:js)?\d*|tsx|ts-node|vite-node|nodemon|npx|npm|pnpm|pnpx|yarn|corepack|bun|bunx|deno|bash|sh|zsh|dash|ksh|fish|pwsh|powershell|cmd|python[\d.]*|uv|uvx|pipx|poetry|pipenv|perl|ruby|php|java|env|sudo|doas|xargs|nohup|time|timeout|nice|exec)$/.test(base);
};
const SAFE_MODULE_IMPORTS = new Set(["isBuiltin", "builtinModules"]);

/**
 * Whether a child-process call `(program, args?, options?, callback?)` is
 * proven not to run a shell, which would turn the program into a shell line.
 * Options must be an object literal with no spread, no computed key and no
 * `shell` other than `false`; anything the options could be but this cannot
 * read -- a variable in their place -- is not proven.
 */
const shellProvenOff = (args: ts.NodeArray<ts.Expression>) => {
  // A trailing callback first; then `(args, options)`, `(args)` or `(options)`.
  const rest = args.slice(1).map(unwrap);
  while (rest.length > 0 && (ts.isArrowFunction(rest[rest.length - 1]) || ts.isFunctionExpression(rest[rest.length - 1]))) {
    rest.pop();
  }
  // Only an array literal is the argument list for certain; an object literal
  // in that place is the options (`execFile(file, options, callback)`). A
  // second argument after the list is the options. Anything else is unknown.
  const candidates = rest.filter((argument, index) =>
    !(index === 0 && (ts.isArrayLiteralExpression(argument) ||
      (rest.length >= 2 && !ts.isObjectLiteralExpression(argument) && ts.isIdentifier(argument)))));
  return candidates.every((argument) => ts.isObjectLiteralExpression(argument) &&
    argument.properties.every((property) => {
      if (ts.isSpreadAssignment(property)) return false;
      const name = property.name;
      if (name === undefined || ts.isComputedPropertyName(name)) return false;
      const text = ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : null;
      if (text !== "shell") return true;
      return ts.isPropertyAssignment(property) && property.initializer.kind === ts.SyntaxKind.FalseKeyword;
    }));
};

/** Every name an assignment target writes, through any destructuring. */
const writtenNames = (target: ts.Node, into: Set<string>): void => {
  const node = ts.isExpression(target) ? unwrap(target) : target;
  if (ts.isIdentifier(node)) into.add(node.text);
  else if (ts.isArrayLiteralExpression(node)) node.elements.forEach((element) => writtenNames(element, into));
  else if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isShorthandPropertyAssignment(property)) into.add(property.name.text);
      else if (ts.isPropertyAssignment(property)) writtenNames(property.initializer, into);
      else if (ts.isSpreadAssignment(property)) writtenNames(property.expression, into);
    }
  } else if (ts.isSpreadElement(node)) writtenNames(node.expression, into);
  else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    // A default value: `[code = "0"] = …` writes `code`.
    writtenNames(node.left, into);
  }
};

/**
 * The texts an inline worker's source argument can be: a literal, a `const`
 * of the file bound to one and never assigned, or a parameter of a function
 * of the file -- declared once, never assigned, exported or handed on -- whose
 * every call in the file passes one of those. Null when any is something else.
 */
const workerSourceTexts = (source: ts.SourceFile, argument: ts.Expression): string[] | null => {
  const literal = (node: ts.Expression) => {
    const value = unwrap(node);
    return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) ? value.text : null;
  };
  const exported = (node: ts.Node) =>
    (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [])
      .some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const declarations = new Map<string, number>();
  const declare = (name: string) => declarations.set(name, (declarations.get(name) ?? 0) + 1);
  const constants = new Map<string, string | null>();
  const functions = new Map<string, { exported: boolean }>();
  const parameters = new Map<string, { fn: string; index: number }[]>();
  const calls = new Map<string, ts.CallExpression[]>();
  const assigned = new Set<string>();
  const notReferences = new Set<ts.Node>();
  const references = new Map<string, number>();
  const statementDeclarations = new Set<ts.Node>();
  const addParameters = (fn: string, list: ts.NodeArray<ts.ParameterDeclaration>) =>
    list.forEach((parameter, index) => {
      if (ts.isIdentifier(parameter.name)) {
        parameters.set(parameter.name.text, [...(parameters.get(parameter.name.text) ?? []), { fn, index }]);
      }
    });
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
        declare(name);
        statementDeclarations.add(declaration);
        notReferences.add(declaration.name);
        const init = declaration.initializer;
        constants.set(name, isConst && init !== undefined ? literal(init) : null);
        const bound = init === undefined ? null : unwrap(init);
        if (isConst && bound !== null && (ts.isArrowFunction(bound) || ts.isFunctionExpression(bound))) {
          functions.set(name, { exported: exported(node) });
          addParameters(name, bound.parameters);
        }
      }
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !statementDeclarations.has(node)) {
      // Any other binding (a loop, a catch): known to be nothing.
      declare(node.name.text);
      notReferences.add(node.name);
      constants.set(node.name.text, null);
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      declare(node.name.text);
      notReferences.add(node.name);
      functions.set(node.name.text, { exported: exported(node) });
      addParameters(node.name.text, node.parameters);
    }
    // Every other binding of a name counts too: a parameter, a destructured
    // or imported name, a class shadows a const of the same name somewhere,
    // and names are matched without scopes.
    if ((ts.isParameter(node) || ts.isBindingElement(node) || ts.isImportSpecifier(node) ||
        ts.isImportClause(node) || ts.isNamespaceImport(node) || ts.isClassDeclaration(node)) &&
        node.name !== undefined && ts.isIdentifier(node.name)) {
      declare(node.name.text);
      notReferences.add(node.name);
    }
    // Every name an assignment writes, destructuring included (`[code] = …`,
    // `({ code } = …)`), and every name a `for … of`/`for … in` writes.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      writtenNames(node.left, assigned);
    }
    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
      writtenNames(node.initializer, assigned);
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(unwrap(node.operand))) {
      assigned.add((unwrap(node.operand) as ts.Identifier).text);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(unwrap(node.expression))) {
      const callee = unwrap(node.expression) as ts.Identifier;
      calls.set(callee.text, [...(calls.get(callee.text) ?? []), node]);
      notReferences.add(callee);
    }
    if (ts.isPropertyAccessExpression(node)) notReferences.add(node.name);
    if (ts.isIdentifier(node) && !notReferences.has(node)) {
      references.set(node.text, (references.get(node.text) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const resolveText = (node: ts.Expression): string | null => {
    const direct = literal(node);
    if (direct !== null) return direct;
    const value = unwrap(node);
    if (!ts.isIdentifier(value) || assigned.has(value.text) || declarations.get(value.text) !== 1) return null;
    return constants.get(value.text) ?? null;
  };
  const direct = resolveText(argument);
  if (direct !== null) return [direct];
  const value = unwrap(argument);
  if (!ts.isIdentifier(value) || constants.has(value.text) || assigned.has(value.text) ||
      declarations.get(value.text) !== 1) return null;
  const owners = parameters.get(value.text) ?? [];
  if (owners.length !== 1) return null;
  const { fn, index } = owners[0];
  const owner = functions.get(fn);
  // A function exported, assigned, declared twice or handed on as a value
  // (`export { fn }`, `run(fn)`, `const alias = fn`) can be called with
  // anything from elsewhere.
  if (owner === undefined || owner.exported || assigned.has(fn) || declarations.get(fn) !== 1 ||
      (references.get(fn) ?? 0) > 0) return null;
  const sites = calls.get(fn) ?? [];
  if (sites.length === 0) return null;
  const texts: string[] = [];
  for (const site of sites) {
    const passed = site.arguments[index];
    const text = passed === undefined ? null : resolveText(passed);
    if (text === null) return null;
    texts.push(text);
  }
  return texts;
};

/**
 * Whether a file runs code through a builtin that loads or runs what it is
 * given by name: `node:module` beyond `isBuiltin`/`builtinModules`, `vm`,
 * `cluster`, a `Worker` on a path, a child process that is not a literal,
 * non-runner program, `exec` (a shell line) or `fork` (a module path). An
 * inline worker (`eval: true`) runs source in this very file, whose own
 * `require("x")` lines `embeddedSpecifiers` follows.
 */
const loadsThroughBuiltin = (source: ts.SourceFile): { inProcess: boolean; childProcess: boolean } => {
  const builtin = (text: string) => {
    const match = /^(?:node:)?(module|vm|worker_threads|child_process|cluster)(?:\/.*)?$/.exec(text);
    return match ? match[1] : null;
  };
  const processRunners = new Set<string>();
  const workers = new Set<string>();
  const allowed = new Set<ts.Node>();
  const destructured = new Set<ts.Node>();
  let inProcess = false;
  let childProcess = false;
  // A child process is a separate program; everything else runs in this one.
  const mark = (which: string | null) => {
    if (which === "child_process") childProcess = true;
    else inProcess = true;
  };
  // One name taken from a builtin, by a named import or a destructured require.
  const judge = (which: string, imported: string, local: string) => {
    if (which === "module" && !SAFE_MODULE_IMPORTS.has(imported)) inProcess = true;
    if (which === "vm" || which === "cluster") inProcess = true;
    if (which === "worker_threads" && imported === "Worker") workers.add(local);
    if (which === "child_process") {
      if (/^(?:exec|execSync|fork)$/.test(imported)) childProcess = true;
      else processRunners.add(local);
    }
  };
  // First every binding taken from a builtin, wherever it is written (an
  // import may follow the code that uses it), then every use.
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const which = builtin(node.moduleSpecifier.text);
      const clause = node.importClause;
      // A type-only import binds no value.
      if (which !== null && !clause?.isTypeOnly) {
        const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings.elements : null;
        if (clause?.name !== undefined || named === null) {
          // A default or namespace import hands on the whole builtin.
          if (clause !== undefined) mark(which);
        } else {
          for (const element of named) {
            if (!element.isTypeOnly) judge(which, (element.propertyName ?? element.name).text, element.name.text);
          }
        }
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier) &&
        builtin(node.moduleSpecifier.text) !== null) mark(builtin(node.moduleSpecifier.text));
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteral(node.moduleReference.expression) && builtin(node.moduleReference.expression.text) !== null) {
      mark(builtin(node.moduleReference.expression.text));
    }
    // `const { parentPort } = require("node:worker_threads")`: each name is
    // judged as a named import is. The declaration is visited before its call.
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined) {
      const call = unwrap(node.initializer);
      const which = ts.isCallExpression(call) && isStringLiteral(call.arguments[0]) &&
        calleeMayRequire(unwrap(call.expression)) === "require"
        ? builtin((call.arguments[0] as ts.StringLiteral).text) : null;
      const plain = node.name.elements.every((element) => element.dotDotDotToken === undefined &&
        ts.isIdentifier(element.name) && (element.propertyName === undefined || ts.isIdentifier(element.propertyName)));
      if (which !== null && plain) {
        destructured.add(call);
        for (const element of node.name.elements) {
          judge(which, ((element.propertyName ?? element.name) as ts.Identifier).text, (element.name as ts.Identifier).text);
        }
      }
    }
    // Any other `require("node:child_process")` and the like in code (not in
    // an inline worker's source string, which is text here) hands on the
    // whole builtin.
    if (ts.isCallExpression(node) && !destructured.has(node) && isStringLiteral(node.arguments[0]) &&
        builtin((node.arguments[0] as ts.StringLiteral).text) !== null &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword || calleeMayRequire(unwrap(node.expression)) === "require")) {
      mark(builtin((node.arguments[0] as ts.StringLiteral).text));
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  // `const run = promisify(execFile)` is execFile by another name, in any order.
  for (let grew = true; grew;) {
    grew = false;
    const aliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined &&
          ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) &&
          node.initializer.expression.text === "promisify" && node.initializer.arguments.length === 1) {
        const wrapped = unwrap(node.initializer.arguments[0]);
        if (ts.isIdentifier(wrapped) && processRunners.has(wrapped.text) && !processRunners.has(node.name.text)) {
          processRunners.add(node.name.text);
          grew = true;
        }
      }
      ts.forEachChild(node, aliases);
    };
    aliases(source);
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee) && processRunners.has(callee.text)) {
        const program = node.arguments[0];
        if (program === undefined || !isStringLiteral(program) || !shellProvenOff(node.arguments) ||
            isCodeRunner((program as ts.StringLiteral).text)) childProcess = true;
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && workers.has(node.expression.text)) {
      const options = node.arguments?.[1];
      const inline = options !== undefined && ts.isObjectLiteralExpression(options) &&
        options.properties.some((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) &&
          property.name.text === "eval" && property.initializer.kind === ts.SyntaxKind.TrueKeyword);
      const sourceArgument = node.arguments?.[0];
      // An inline worker runs source this file holds: every text it can be is
      // read as code, and a computed load there is one here.
      const texts = inline && sourceArgument !== undefined ? workerSourceTexts(source, sourceArgument) : null;
      if (texts === null) inProcess = true;
      else {
        for (const text of texts) {
          const code = ts.createSourceFile("worker.js", text, ts.ScriptTarget.Latest, false);
          const inner = hasParseErrors(code) ? null : codeFacts(code);
          if (inner === null || inner.runtimeLoader || inner.loadingBuiltin) inProcess = true;
        }
      }
    }
    // A runner or Worker name used anywhere but as the callee checked above,
    // the promisify argument, or its own declaration hands it on.
    if (ts.isImportSpecifier(node)) {
      allowed.add(node.name);
      if (node.propertyName !== undefined) allowed.add(node.propertyName);
    }
    if (ts.isVariableDeclaration(node)) {
      allowed.add(node.name);
      // Only `const run = promisify(execFile)` -- whose alias is tracked --
      // may take a runner; `promisify(execFile)("node", …)` hands it on.
      if (ts.isIdentifier(node.name) && node.initializer !== undefined && ts.isCallExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "promisify" &&
          node.initializer.arguments[0] !== undefined) {
        allowed.add(unwrap(node.initializer.arguments[0]));
      }
    }
    if (ts.isCallExpression(node)) allowed.add(unwrap(node.expression));
    if (ts.isNewExpression(node)) allowed.add(node.expression);
    if (ts.isIdentifier(node) && !allowed.has(node)) {
      if (processRunners.has(node.text)) childProcess = true;
      if (workers.has(node.text)) inProcess = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { inProcess, childProcess };
};

/**
 * `require("x")` and `import("x")` written inside a string or template in
 * the file -- the source an inline worker runs -- read as import specifiers.
 */
export const embeddedSpecifiers = (source: ts.SourceFile): string[] => {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    // Read as code, the way the worker runs it, so `require /* x */ ("./y")`
    // counts as it does there. Only text that can hold a load is parsed.
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /require|import/.test(node.text)) {
      const code = ts.createSourceFile("embedded.js", node.text, ts.ScriptTarget.Latest, false);
      if (!hasParseErrors(code)) found.push(...importSpecifiersOf(code));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

/** Kept for callers and tests that ask the narrower question. */
export const hasRuntimeLoader = (file: SourceFile) => codeFacts(parse(file)).runtimeLoader;

/**
 * Every module specifier a file names statically, read from the syntax tree:
 * imports and re-exports (type-only included), `import x = require()`, literal
 * dynamic imports and requires, and `import("x")` types.
 */
export const importSpecifiersOf = (source: ts.SourceFile): string[] => {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (ts.isStringLiteral(expression)) found.push(expression.text);
    } else if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      // `require("x")`, `module.require("x")` and `module["require"]("x")` alike.
      const isRequire = calleeMayRequire(unwrap(node.expression)) === "require";
      if ((isImport || isRequire) && first !== undefined && isStringLiteral(first)) {
        found.push((first as ts.StringLiteral).text);
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const literal = node.argument.literal;
      if (ts.isStringLiteral(literal)) found.push(literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

export const importSpecifiers = (file: SourceFile): string[] => importSpecifiersOf(parse(file));

/**
 * The code the Next.js runtime loads: application code and the root entry
 * points. Tests, scripts, the mobile app, the Rust crates and tooling
 * configuration are built and run elsewhere, so they are not nodes here.
 */
const RUNTIME_ROOT_FILES = new Set([
  "proxy.ts",
  "instrumentation.ts",
  "instrumentation-client.ts",
  "next.config.ts",
  "sentry.server.config.ts",
  "sentry.edge.config.ts",
]);
export const isAppRuntimeCode = (path: string) =>
  CODE_FILE.test(path) &&
  (RUNTIME_ROOT_FILES.has(path) || /^(?:app|components|lib|locales|packages|types|hooks)\//.test(path));

/* ------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* ------------------------------------------------------------------------- */

export type Resolver = (from: string, specifier: string) => string | "external" | null;

const NODE_BUILTINS = new Set(builtinModules);

const packageNameOf = (specifier: string) => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

const dirname = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
};

const normalise = (path: string): string | null => {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(segment);
  }
  return out.join("/");
};

/**
 * Builds the resolver for one tree: TypeScript's own module resolution over
 * the tracked files, with this repository's tsconfig; asset imports resolved
 * as plain paths; workspace packages through their manifests; and every other
 * bare specifier accepted as external only if it is a runtime builtin or a
 * dependency the root manifest declares.
 */
export const createResolver = (files: readonly SourceFile[]): { resolve: Resolver; problems: SliceProblem[] } => {
  const problems: SliceProblem[] = [];
  const byPath = new Map(files.map((file) => [file.path, file.text]));
  const directories = new Set<string>();
  for (const path of byPath.keys()) {
    for (let dir = dirname(path); dir !== ""; dir = dirname(dir)) directories.add(dir);
  }

  const tsconfigText = byPath.get("tsconfig.json");
  let options: ts.CompilerOptions = {};
  if (tsconfigText === undefined) problems.push({ path: "tsconfig.json", specifier: null, problem: "tsconfig_missing" });
  else {
    const parsed = ts.parseConfigFileTextToJson("tsconfig.json", tsconfigText);
    if (parsed.error) problems.push({ path: "tsconfig.json", specifier: null, problem: "tsconfig_unparseable" });
    else {
      const converted = ts.convertCompilerOptionsFromJson(parsed.config?.compilerOptions ?? {}, ROOT, "tsconfig.json");
      options = { ...converted.options, pathsBasePath: ROOT } as ts.CompilerOptions;
    }
  }

  const strip = (absolute: string) =>
    absolute.startsWith(`${ROOT}/`) ? absolute.slice(ROOT.length + 1) : null;
  const host: ts.ModuleResolutionHost = {
    fileExists: (absolute) => {
      const path = strip(absolute.replace(/\\/g, "/"));
      return path !== null && byPath.has(path);
    },
    readFile: (absolute) => {
      const path = strip(absolute.replace(/\\/g, "/"));
      return path === null ? undefined : byPath.get(path);
    },
    directoryExists: (absolute) => {
      const path = strip(absolute.replace(/\\/g, "/"));
      return path === "" || (path !== null && directories.has(path)) || absolute === ROOT;
    },
    realpath: (absolute) => absolute,
    getCurrentDirectory: () => ROOT,
  };

  // Packages the lockfile installs at the top of node_modules: declared
  // dependencies and the transitive ones hoisted beside them. A bare specifier
  // naming anything else is not something this tree can load.
  const installed = new Set<string>();
  const lockText = byPath.get("package-lock.json");
  if (lockText === undefined) {
    problems.push({ path: "package-lock.json", specifier: null, problem: "lockfile_missing" });
  } else {
    try {
      const lock = JSON.parse(lockText) as { packages?: Record<string, unknown> };
      for (const key of Object.keys(lock.packages ?? {})) {
        const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
        if (match) installed.add(match[1]);
      }
    } catch {
      problems.push({ path: "package-lock.json", specifier: null, problem: "lockfile_unparseable" });
    }
  }
  const declared = installed;

  const workspaces = new Map<string, { dir: string; manifest: Record<string, unknown> }>();
  for (const [path, text] of byPath) {
    const match = /^packages\/([^/]+)\/package\.json$/.exec(path);
    if (!match) continue;
    try {
      const manifest = JSON.parse(text) as Record<string, unknown>;
      if (typeof manifest.name === "string") workspaces.set(manifest.name, { dir: `packages/${match[1]}`, manifest });
    } catch {
      problems.push({ path, specifier: null, problem: "manifest_unparseable" });
    }
  }

  const resolveWorkspace = (specifier: string): string | null => {
    const name = packageNameOf(specifier);
    const workspace = workspaces.get(name);
    if (workspace === undefined) return null;
    const subpath = `.${specifier.slice(name.length)}`;
    const exportsField = workspace.manifest.exports;
    let target: unknown;
    if (typeof exportsField === "string" && subpath === ".") target = exportsField;
    else if (exportsField && typeof exportsField === "object") target = (exportsField as Record<string, unknown>)[subpath];
    else if (subpath === ".") target = workspace.manifest.main;
    if (typeof target !== "string") return null;
    const resolved = normalise(`${workspace.dir}/${target}`);
    return resolved !== null && byPath.has(resolved) ? resolved : null;
  };

  const resolve: Resolver = (from, specifier) => {
    const assetPath = /\.(?:css|scss|svg|png|jpe?g|gif|webp|ico|txt|md|woff2?)$/i.test(specifier);
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (assetPath && (relative || specifier.startsWith("@/"))) {
      const path = normalise(relative ? `${dirname(from)}/${specifier}` : specifier.slice(2));
      return path !== null && byPath.has(path) ? path : null;
    }
    const result = ts.resolveModuleName(specifier, `${ROOT}/${from}`, options, host).resolvedModule;
    if (result !== undefined) {
      const path = strip(result.resolvedFileName.replace(/\\/g, "/"));
      if (path !== null && byPath.has(path)) return path;
    }
    if (relative || specifier.startsWith("@/") || specifier.startsWith("/")) return null;
    const workspace = resolveWorkspace(specifier);
    if (workspace !== null) return workspace;
    if (workspaces.has(packageNameOf(specifier))) return null;
    const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
    if (NODE_BUILTINS.has(bare) || NODE_BUILTINS.has(packageNameOf(bare))) return "external";
    return declared.has(packageNameOf(specifier)) ? "external" : null;
  };

  return { resolve, problems };
};

/* ------------------------------------------------------------------------- */
/* Configuration names                                                        */
/* ------------------------------------------------------------------------- */

const ENV_NAME = /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\])/g;
const KEY_LIKE = /^[A-Za-z][A-Za-z0-9_.:-]{2,80}$/;

/** Environment variable names a file reads. */
export const environmentNames = (text: string): Set<string> => {
  const names = new Set<string>();
  for (const match of text.matchAll(ENV_NAME)) names.add(match[1] ?? match[2]);
  return names;
};

/** Every key-shaped string literal in a file, for the AppSetting key corpus. */
const keyLiterals = (source: ts.SourceFile): Set<string> => {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && KEY_LIKE.test(node.text)) {
      found.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

/** Whether added text names a configuration key as a literal or an env var as an identifier. */
const mentions = (addedText: string, name: string) =>
  new RegExp(`(?:["'\`]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`])|(?:\\benv\\.${name}\\b)`).test(addedText);

/* ------------------------------------------------------------------------- */
/* The slice                                                                  */
/* ------------------------------------------------------------------------- */

export type SliceChange = {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied";
  /** The whole resulting file, for code files that exist after the change. */
  newText: string;
  addedText: string;
};

export type SliceResult =
  | { status: "failed"; problems: SliceProblem[] }
  | {
      status: "analysed";
      /** Changed paths (either side) that are in the slice or join it. */
      slicePaths: Set<string>;
      /** Size of the base slice, for the report on what this costs. */
      baseSliceSize: number;
    };

type Graph = {
  edges: Map<string, Set<string>>;
  facts: Map<string, CodeFacts>;
  appSettingKeys: Set<string>;
  /** Per code file, the paths it names as text, exactly or as a directory. */
  named: Map<string, NamedPaths>;
  /** Code files outside the app with no text to read or that do not parse. */
  unreadable: Set<string>;
  /** Code files that load a module by a computed name. */
  loaders: Set<string>;
  problems: SliceProblem[];
};

export type NamedPaths = { exact: Set<string>; prefixes: Set<string> };

const PATH_LIKE = /^[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*$/;
const normalisePathText = (text: string) =>
  text.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
const PATH_CALL = /(?:^|\.)(?:join|resolve)$/;
const BASE_ARGUMENT = /^(?:process\.cwd\(\)|__dirname|import\.meta\.dirname)$/;

/**
 * Repository paths a runtime file names as text, so a file it reads by path
 * joins the slice even though no import reaches it: every path-shaped string
 * literal (exactly, and as a directory when it has a separator), the literal
 * start of every `join`/`resolve` call, and the literal head of every
 * template. A path assembled from nothing literal is not named, but whatever
 * supplies it is runtime code, whose own literals are collected here.
 */
export const namedPaths = (source: ts.SourceFile): NamedPaths => {
  const exact = new Set<string>();
  const prefixes = new Set<string>();
  const add = (raw: string, asPrefix: boolean) => {
    const text = normalisePathText(raw);
    if (text === "" || !PATH_LIKE.test(text)) return;
    exact.add(text);
    if (asPrefix || text.includes("/")) prefixes.add(text);
  };
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node.text, false);
    if (ts.isTemplateExpression(node)) {
      // The head up to its last separator is the directory the template reads under.
      const head = node.head.text.replace(/\\/g, "/");
      add(head.includes("/") ? head.slice(0, head.lastIndexOf("/")) : head, true);
    }
    if (ts.isCallExpression(node) && PATH_CALL.test(node.expression.getText(source))) {
      const parts: string[] = [];
      let index = 0;
      while (index < node.arguments.length && BASE_ARGUMENT.test(node.arguments[index].getText(source))) index += 1;
      for (; index < node.arguments.length; index += 1) {
        const argument = node.arguments[index];
        if (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument)) break;
        parts.push(argument.text);
      }
      if (parts.length > 0) add(parts.join("/"), true);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { exact, prefixes };
};

/** Parses and resolves every code file of one tree. */
const buildGraph = (files: readonly SourceFile[]): Graph => {
  const { resolve, problems } = createResolver(files);
  const edges = new Map<string, Set<string>>();
  const facts = new Map<string, CodeFacts>();
  const appSettingKeys = new Set<string>();
  const named = new Map<string, NamedPaths>();
  for (const file of files) {
    if (!isAppRuntimeCode(file.path)) continue;
    const source = parse(file);
    if (hasParseErrors(source)) {
      problems.push({ path: file.path, specifier: null, problem: "parse_error" });
      continue;
    }
    const fileFacts = codeFacts(source);
    facts.set(file.path, fileFacts);
    if (fileFacts.appSettingAccess) for (const key of keyLiterals(source)) appSettingKeys.add(key);
    named.set(file.path, namedPaths(source));
    // A runtime gate may start a separate program (git, a CLI); loading code
    // into the app by a computed name it may not.
    if (isRuntimeControlPlane(file.path) && (fileFacts.runtimeLoader || fileFacts.inProcessLoad)) {
      problems.push({ path: file.path, specifier: null, problem: "runtime_loader_in_control_plane" });
    }
    const targets = new Set<string>();
    for (const specifier of importSpecifiersOf(source)) {
      const resolved = resolve(file.path, specifier);
      if (resolved === null) problems.push({ path: file.path, specifier, problem: "unresolved_import" });
      else if (resolved !== "external") targets.add(resolved);
    }
    // What an inline worker's source requires; text, so one that names no
    // tracked file adds nothing.
    for (const specifier of embeddedSpecifiers(source)) {
      const resolved = resolve(file.path, specifier);
      if (resolved !== null && resolved !== "external") targets.add(resolved);
    }
    edges.set(file.path, targets);
  }
  // Code outside the app -- gate scripts and tooling, and the tests and
  // helpers they may import -- is read only for the gates' reach. An import it
  // cannot resolve names no tracked file of this tree, so it adds no edge
  // rather than failing; a change that adds that file is read again in the
  // result tree. A file it names exactly (an allowlist, a baseline) steers it;
  // a directory it walks holds what it checks, which the check reads afresh.
  // What cannot be read here -- no text in the evidence (the vendored AMUX
  // server, for one), or no parse -- fails the analysis only if a gate reaches
  // it.
  const unreadable = new Set<string>();
  const loaders = new Set<string>();
  for (const [path, fileFacts] of facts) if (fileFacts.runtimeLoader || fileFacts.loadingBuiltin) loaders.add(path);
  for (const file of files) {
    if (isTextGate(file.path)) {
      if (file.text === "") {
        unreadable.add(file.path);
        continue;
      }
      // What a glob matches is data the gate reads: named like a file below a
      // named directory, not followed as code.
      // A glob is read every way a named path is (from the root, relative to
      // the gate, under the image's /app) before it is matched.
      const { exact, globs } = textGatePaths(file.path, file.text);
      const patterns = globs.flatMap((glob) => pathReadings(file.path, glob)).map(globPattern);
      const matched = new Set(patterns.length === 0 ? [] :
        files.map((other) => other.path).filter((other) => patterns.some((pattern) => pattern.test(other))));
      // A path it spells out may be a directory it reads or copies
      // (`COPY docs/ops /app/docs/ops`): what is below it is data as well.
      named.set(file.path, { exact, prefixes: new Set([...matched, ...exact]) });
      continue;
    }
    if (!CODE_FILE.test(file.path) || isAppRuntimeCode(file.path)) continue;
    const source = file.text === "" ? null : parse(file);
    if (source === null || hasParseErrors(source)) {
      unreadable.add(file.path);
      continue;
    }
    const fileFacts = codeFacts(source);
    if (fileFacts.runtimeLoader || fileFacts.loadingBuiltin) loaders.add(file.path);
    // AppSetting keys are protected wherever they are read, as in the app.
    if (fileFacts.appSettingAccess) for (const key of keyLiterals(source)) appSettingKeys.add(key);
    named.set(file.path, { exact: namedPaths(source).exact, prefixes: new Set() });
    const targets = new Set<string>();
    for (const specifier of importSpecifiersOf(source)) {
      const resolved = resolve(file.path, specifier);
      if (resolved !== null && resolved !== "external") targets.add(resolved);
    }
    for (const specifier of embeddedSpecifiers(source)) {
      const resolved = resolve(file.path, specifier);
      if (resolved !== null && resolved !== "external") targets.add(resolved);
    }
    edges.set(file.path, targets);
  }
  return { edges, facts, appSettingKeys, named, unreadable, loaders, problems };
};

const isProduct = (path: string) => classifyPath(path) === "product";

/** The path and every directory above it, for matching a named directory. */
const selfAndAncestors = (path: string) => {
  const found = [path];
  for (let dir = dirname(path); dir !== ""; dir = dirname(dir)) found.push(dir);
  return found;
};

/**
 * The repository paths a path-shaped text may mean, read from `from`: as
 * written from the root, through the `@/` alias, relative to the file itself
 * (`new URL("../x.json", import.meta.url)`), and below the image's `/app`
 * root (`/app/docs/x.json`, its leading slash already gone). All of them count.
 */
const pathReadings = (from: string, text: string): string[] => {
  const unaliased = text.startsWith("@/") ? text.slice(2) : text;
  return [
    unaliased,
    normalise(`${dirname(from)}/${unaliased}`),
    unaliased.startsWith("app/") ? unaliased.slice(4) : null,
  ].filter((path): path is string => path !== null);
};

/**
 * Every product file the gates reach (docs/policy/engineering-agent.md
 * version 6 item 2). From each gate it follows imports through any code file,
 * test helpers included, and takes every file a followed file names by path
 * -- exactly, or below a directory app runtime code names. A named file is in
 * the slice. A code file named exactly is followed in turn -- a gate may run
 * it -- except under `tests/`, where a runner names the test or fixture it
 * runs as its input, and under `vendor/`, a separate program; a test helper
 * or vendored file a gate imports is still followed. A file under a named
 * directory is data the gate reads: running code from there takes a computed
 * load, which fails the analysis. A product file the gates never reach is not
 * in the slice, although the deployed image contains it.
 *
 * The whole app runtime graph is still built, because an import that does not
 * resolve, or a file that does not parse, anywhere in it fails the analysis.
 * A followed file whose text the evidence does not hold, or a followed
 * product file that loads a module by a computed name, fails it too: what it
 * reaches cannot be known. A gate's own computed load outside the app (a
 * check loading each locale it checks) loads its input, not its logic.
 */
const gateSlice = (graph: Graph, paths: readonly string[]) => {
  const followed = new Set<string>();
  const named = new Set<string>();
  const exact = new Set<string>();
  const prefixes = new Set<string>();
  const problems: SliceProblem[] = [];
  // Every gate, read or not: a gate that cannot be read fails the analysis.
  let frontier = paths.filter((path) => isRuntimeControlPlane(path) || isGateOutsideRuntime(path) || isTextGate(path));
  while (frontier.length > 0) {
    const stack = frontier;
    frontier = [];
    while (stack.length > 0) {
      const path = stack.pop() as string;
      if (followed.has(path)) continue;
      followed.add(path);
      if (graph.unreadable.has(path)) problems.push({ path, specifier: null, problem: "gate_reaches_unreadable_code" });
      if (graph.loaders.has(path) && classifyPath(path) !== "control-plane") {
        problems.push({ path, specifier: null, problem: "gate_reaches_runtime_loader" });
      }
      for (const target of graph.edges.get(path) ?? []) stack.push(target);
      const texts = graph.named.get(path);
      for (const text of texts?.exact ?? []) for (const reading of pathReadings(path, text)) exact.add(reading);
      for (const text of texts?.prefixes ?? []) for (const reading of pathReadings(path, text)) prefixes.add(reading);
    }
    // Whether a file is named and whether it is followed are separate: a file
    // first seen below a named directory may be named exactly later on.
    for (const path of paths) {
      if (followed.has(path)) continue;
      if (exact.has(path) || selfAndAncestors(path).some((dir) => prefixes.has(dir))) named.add(path);
      if (exact.has(path) && CODE_FILE.test(path) && !path.startsWith("tests/") && !path.startsWith("vendor/")) {
        frontier.push(path);
      }
    }
  }
  return { slice: new Set([...followed, ...named].filter(isProduct)), followed, problems };
};

/**
 * The slice for one change set. The base tree gives the slice a changed path
 * may already be in; the result tree gives the one it may have joined --
 * including through a barrel or a registrant the same change adds. A changed file that loads
 * by a computed name, calls through a computed member, reads a computed
 * environment key or touches AppSetting directly is in the slice, as is one
 * whose added lines name a configuration key.
 */
export const computeControlPlaneSlice = (input: {
  baseFiles: readonly SourceFile[];
  changes: readonly SliceChange[];
}): SliceResult => {
  const base = buildGraph(input.baseFiles);
  if (base.problems.length > 0) return { status: "failed", problems: base.problems };
  const { slice: baseSlice, followed: baseFollowed, problems: baseProblems } =
    gateSlice(base, input.baseFiles.map((file) => file.path));
  if (baseProblems.length > 0) return { status: "failed", problems: baseProblems };

  // The names every file the gates run reads -- gates, and every file followed
  // from them, test helpers included -- and every file of the slice.
  const names = new Set<string>(base.appSettingKeys);
  for (const file of input.baseFiles) {
    if (isRuntimeControlPlane(file.path) || baseFollowed.has(file.path) || baseSlice.has(file.path)) {
      for (const name of environmentNames(file.text)) names.add(name);
    }
    // A shell, Dockerfile or workflow reads `$NAME` / `${NAME}` / `${{ env.NAME }}`;
    // PowerShell reads `$env:NAME` / `${env:NAME}`.
    if (isTextGate(file.path)) {
      for (const match of file.text.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)|\benv[.:]([A-Za-z_][A-Za-z0-9_]*)/g)) {
        names.add(match[1] ?? match[2]);
      }
    }
  }

  const removed = new Set(
    input.changes.flatMap((change) =>
      change.status === "deleted"
        ? [change.path]
        : change.status === "renamed" && change.previousPath
          ? [change.previousPath]
          : [],
    ),
  );
  const replaced = new Map(
    input.changes.filter((change) => change.status !== "deleted").map((change) => [change.path, change.newText]),
  );
  const resultFiles: SourceFile[] = [
    ...input.baseFiles
      .filter((file) => !removed.has(file.path) && !replaced.has(file.path))
      .map((file) => file),
    ...[...replaced].map(([path, text]) => ({ path, text })),
  ];
  const result = buildGraph(resultFiles);
  if (result.problems.length > 0) return { status: "failed", problems: result.problems };
  const { slice: resultSlice, problems: resultProblems } = gateSlice(result, resultFiles.map((file) => file.path));
  if (resultProblems.length > 0) return { status: "failed", problems: resultProblems };

  const slicePaths = new Set<string>();
  for (const change of input.changes) {
    for (const path of [change.path, change.previousPath].filter((p): p is string => p !== undefined)) {
      if (baseSlice.has(path)) slicePaths.add(path);
    }
    if (change.status !== "deleted") {
      if (resultSlice.has(change.path)) slicePaths.add(change.path);
      const changeFacts = result.facts.get(change.path);
      if (
        changeFacts !== undefined &&
        (changeFacts.runtimeLoader || changeFacts.computedCall || changeFacts.computedEnv || changeFacts.appSettingAccess)
      ) {
        slicePaths.add(change.path);
      }
    }
    for (const name of names) {
      if (mentions(change.addedText, name)) {
        slicePaths.add(change.path);
        break;
      }
    }
  }
  return { status: "analysed", slicePaths, baseSliceSize: baseSlice.size };
};
