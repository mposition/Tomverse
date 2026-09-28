/**
 * The control-plane slice: product files whose change can alter what the
 * control plane does even though the control plane's own files are untouched.
 *
 * docs/policy/engineering-agent.md §4 ("통제 평면에 닿는 제품 파일") is the
 * contract. Two directions count, because both change control-plane
 * behaviour without touching a control-plane path:
 *
 * - dependencies: product modules the runtime control plane imports, directly
 *   or through other product modules -- the control plane executes their code;
 * - callers: product modules from which a control-plane module can be
 *   reached through product modules -- a page that calls a gate through a
 *   barrel decides whether and how it is called as much as the barrel does.
 *
 * Configuration is part of it too: an environment variable the control plane
 * or the slice reads, and every AppSetting key, is a name a change may not add.
 *
 * The analysis fails closed. A file that does not parse, an import TypeScript
 * cannot resolve to tracked code, a bare specifier that is neither a runtime
 * builtin, a declared dependency nor a workspace package, or a runtime
 * control-plane module that assembles what it loads fails the whole patch --
 * never one file. It runs in the app, which may use the TypeScript compiler;
 * it resolves modules the way `tsc` does with this repository's tsconfig, and
 * where it cannot follow code (registries, callbacks, reflection) it moves the
 * changed file to T2 rather than claim precision.
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
 * Scripts, tests, workflows, schema and documents are control-plane too, but
 * they do not run inside the app; what they execute is the credential
 * analysis's concern, not this one's. Root files (`proxy.ts`,
 * `instrumentation.ts`, framework configuration) are included.
 */
export const isRuntimeControlPlane = (path: string) =>
  isAppRuntimeCode(path) && classifyPath(path) === "control-plane";

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
};

/** Facts read from the syntax tree, so the same words in a comment or string do not count. */
export const codeFacts = (source: ts.SourceFile): CodeFacts => {
  const facts: CodeFacts = { runtimeLoader: false, computedCall: false, computedEnv: false, appSettingAccess: false };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword && !isStringLiteral(node.arguments[0])) {
        facts.runtimeLoader = true;
      }
      if (ts.isIdentifier(callee) && callee.text === "require" && !isStringLiteral(node.arguments[0])) {
        facts.runtimeLoader = true;
      }
      // A call through an element access -- `table[name]()` or `table["gate"]()`
      // -- is reflection this does not resolve to a symbol, literal key or not.
      if (ts.isElementAccessExpression(callee)) {
        facts.computedCall = true;
      }
    }
    if (ts.isIdentifier(node) && node.text === "createRequire") facts.runtimeLoader = true;
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
  return facts;
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
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
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
  problems: SliceProblem[];
};

/** Parses and resolves every code file of one tree. */
const buildGraph = (files: readonly SourceFile[]): Graph => {
  const { resolve, problems } = createResolver(files);
  const edges = new Map<string, Set<string>>();
  const facts = new Map<string, CodeFacts>();
  const appSettingKeys = new Set<string>();
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
    if (isRuntimeControlPlane(file.path) && fileFacts.runtimeLoader) {
      problems.push({ path: file.path, specifier: null, problem: "runtime_loader_in_control_plane" });
    }
    const targets = new Set<string>();
    for (const specifier of importSpecifiersOf(source)) {
      const resolved = resolve(file.path, specifier);
      if (resolved === null) problems.push({ path: file.path, specifier, problem: "unresolved_import" });
      else if (resolved !== "external") targets.add(resolved);
    }
    edges.set(file.path, targets);
  }
  return { edges, facts, appSettingKeys, problems };
};

const isProduct = (path: string) => classifyPath(path) === "product";
const isControlPlane = (path: string) => classifyPath(path) === "control-plane";

/** Product files the runtime control plane reaches. */
const dependenciesOf = (graph: Graph) => {
  const dependencies = new Set<string>();
  const queue = [...graph.edges.keys()].filter(isRuntimeControlPlane);
  const seen = new Set(queue);
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const target of graph.edges.get(current) ?? []) {
      if (seen.has(target)) continue;
      seen.add(target);
      if (isProduct(target)) dependencies.add(target);
      queue.push(target);
    }
  }
  return dependencies;
};

/**
 * Product files from which a control-plane module is reachable through product
 * files, plus product files that load modules by a computed name -- they may be
 * reaching the control plane in a way no edge shows.
 */
const callersOf = (graph: Graph) => {
  const reverse = new Map<string, Set<string>>();
  for (const [from, targets] of graph.edges) {
    for (const target of targets) {
      const importers = reverse.get(target) ?? new Set<string>();
      importers.add(from);
      reverse.set(target, importers);
    }
  }
  const callers = new Set<string>();
  const queue: string[] = [];
  for (const path of graph.edges.keys()) {
    if (isControlPlane(path)) queue.push(path);
    else if (isProduct(path) && graph.facts.get(path)?.runtimeLoader) {
      callers.add(path);
      queue.push(path);
    }
  }
  const seen = new Set(queue);
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const importer of reverse.get(current) ?? []) {
      if (seen.has(importer) || !isProduct(importer)) continue;
      seen.add(importer);
      callers.add(importer);
      queue.push(importer);
    }
  }
  return callers;
};

/**
 * The slice for one change set. The base tree gives the slice a changed path
 * may already be in; the result tree gives the callers it may have joined --
 * including through a barrel the same change adds. A changed file that loads
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
  const baseSlice = new Set([...dependenciesOf(base), ...callersOf(base)]);

  const names = new Set<string>(base.appSettingKeys);
  for (const file of input.baseFiles) {
    if (isRuntimeControlPlane(file.path) || baseSlice.has(file.path)) {
      for (const name of environmentNames(file.text)) names.add(name);
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
  const resultCallers = callersOf(result);
  const resultDependencies = dependenciesOf(result);

  const slicePaths = new Set<string>();
  for (const change of input.changes) {
    for (const path of [change.path, change.previousPath].filter((p): p is string => p !== undefined)) {
      if (baseSlice.has(path)) slicePaths.add(path);
    }
    if (change.status !== "deleted") {
      if (resultCallers.has(change.path)) slicePaths.add(change.path);
      // A changed file that imports code the control plane runs can hand it a
      // callback, register into it or mutate what it holds -- none of which an
      // import edge shows. Following that is beyond this analysis, so the file
      // joins the slice instead.
      for (const target of result.edges.get(change.path) ?? []) {
        if (resultDependencies.has(target)) {
          slicePaths.add(change.path);
          break;
        }
      }
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
