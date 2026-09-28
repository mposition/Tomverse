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
 * - callers: product modules that import a control-plane module directly --
 *   they decide whether and how a gate is called.
 *
 * Environment variables and setting keys the control plane reads are part of
 * the slice too: a change that adds a mention of one is a change to the slice.
 *
 * The analysis fails closed. An import it cannot resolve, or a runtime
 * control-plane module that assembles what it loads, fails the whole patch --
 * never one file. It runs in the app, which may use the TypeScript parser; it
 * does not resolve types or follow callbacks, and says so by staying
 * conservative rather than precise.
 */

import ts from "typescript";

import { classifyPath } from "./agentAuthorityFiles.ts";

export type SourceFile = { path: string; text: string };

export type SliceProblem = { path: string; specifier: string | null; problem: string };

const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Workspace packages the app imports by name, and where their source lives. */
export const WORKSPACE_PACKAGE_ENTRIES: Readonly<Record<string, string>> = {
  "@tomverse/chat-core": "packages/chat-core/src/index.ts",
  "@tomverse/ui-tokens/tokens.css": "packages/ui-tokens/src/tokens.css",
};

/**
 * The runtime control plane: control-plane code that runs in the product.
 * Scripts, tests, workflows, schema and documents are control-plane too, but
 * they do not run inside the app; what they execute is the credential
 * analysis's concern, not this one's.
 */
export const isRuntimeControlPlane = (path: string) =>
  CODE_FILE.test(path) &&
  classifyPath(path) === "control-plane" &&
  !/^(?:scripts|tests|\.github|prisma|docs|\.[^/]+)\//.test(path);

const isStringLiteral = (node: ts.Node | undefined) =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

/**
 * Whether a file assembles what it loads: `import(x)` or `require(x)` with an
 * argument that is not a string literal, `require.resolve`, `createRequire`,
 * or `import.meta.glob`. Read from the syntax tree, so the same words in a
 * comment or a string do not count.
 */
export const hasRuntimeLoader = (file: SourceFile): boolean => {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, false);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword && !isStringLiteral(node.arguments[0])) found = true;
      if (ts.isIdentifier(callee) && callee.text === "require" && !isStringLiteral(node.arguments[0])) {
        found = true;
      }
    }
    if (ts.isIdentifier(node) && node.text === "createRequire") found = true;
    if (
      ts.isPropertyAccessExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        (ts.isMetaProperty(node.expression) && node.name.text === "glob"))
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
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
 * Resolves one specifier to a tracked path, `external` for a package from
 * node_modules or a runtime builtin, or `null` when it names repository code
 * that cannot be found -- which fails the analysis.
 */
export const resolveSpecifier = (
  from: string,
  specifier: string,
  tracked: ReadonlySet<string>,
): string | "external" | null => {
  if (Object.hasOwn(WORKSPACE_PACKAGE_ENTRIES, specifier)) {
    const entry = WORKSPACE_PACKAGE_ENTRIES[specifier];
    return tracked.has(entry) ? entry : null;
  }
  if (specifier.startsWith("@tomverse/")) return null;
  let base: string | null;
  if (specifier.startsWith("@/")) base = normalise(specifier.slice(2));
  else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = normalise(`${dirname(from)}/${specifier}`);
  } else return "external";
  if (base === null) return null;

  const candidates = [base];
  const extension = /\.(?:js|jsx|mjs|cjs)$/.exec(base);
  if (extension) {
    const stem = base.slice(0, -extension[0].length);
    candidates.push(...RESOLVE_EXTENSIONS.map((ext) => stem + ext));
  }
  candidates.push(...RESOLVE_EXTENSIONS.map((ext) => base + ext));
  candidates.push(...RESOLVE_EXTENSIONS.map((ext) => `${base}/index${ext}`));
  return candidates.find((candidate) => tracked.has(candidate)) ?? null;
};

/** Every module specifier a file names statically, including literal dynamic imports and requires. */
export const importSpecifiers = (file: SourceFile): string[] =>
  ts.preProcessFile(file.text, true, true).importedFiles.map((reference) => reference.fileName);

export type ImportGraph = { edges: Map<string, Set<string>>; problems: SliceProblem[] };

export const buildImportGraph = (
  files: readonly SourceFile[],
  tracked: ReadonlySet<string>,
): ImportGraph => {
  const edges = new Map<string, Set<string>>();
  const problems: SliceProblem[] = [];
  for (const file of files) {
    if (!CODE_FILE.test(file.path)) continue;
    const targets = new Set<string>();
    for (const specifier of importSpecifiers(file)) {
      const resolved = resolveSpecifier(file.path, specifier, tracked);
      if (resolved === null) problems.push({ path: file.path, specifier, problem: "unresolved_import" });
      else if (resolved !== "external") targets.add(resolved);
    }
    if (isRuntimeControlPlane(file.path) && hasRuntimeLoader(file)) {
      problems.push({ path: file.path, specifier: null, problem: "runtime_loader_in_control_plane" });
    }
    edges.set(file.path, targets);
  }
  return { edges, problems };
};

const ENV_NAME = /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\])/g;
const SETTING_KEY =
  /["'`]((?:feature|amux|engineering|marketing|billing|chat|admin|email|memory|image|router|review)\.[A-Za-z0-9._-]+)["'`]/g;

/** Environment variable names and setting keys a file reads. */
export const configurationNames = (text: string): Set<string> => {
  const names = new Set<string>();
  for (const match of text.matchAll(ENV_NAME)) names.add(match[1] ?? match[2]);
  for (const match of text.matchAll(SETTING_KEY)) names.add(match[1]);
  return names;
};

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

/**
 * The slice for one change set, computed against the base tree. A changed
 * product file is in the slice if the base slice holds it, if its new version
 * imports a control-plane module directly, or if its added lines mention a
 * configuration name the control plane or the slice reads.
 */
export const computeControlPlaneSlice = (input: {
  baseFiles: readonly SourceFile[];
  changes: readonly SliceChange[];
}): SliceResult => {
  const tracked = new Set(input.baseFiles.map((file) => file.path));
  const base = buildImportGraph(input.baseFiles, tracked);
  if (base.problems.length > 0) return { status: "failed", problems: base.problems };

  const isProduct = (path: string) => classifyPath(path) === "product";

  // Dependencies: everything product the runtime control plane reaches.
  const dependencies = new Set<string>();
  const queue = [...base.edges.keys()].filter(isRuntimeControlPlane);
  const seen = new Set(queue);
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const target of base.edges.get(current) ?? []) {
      if (seen.has(target)) continue;
      seen.add(target);
      if (isProduct(target)) dependencies.add(target);
      queue.push(target);
    }
  }

  // Callers: product modules that import a control-plane module directly.
  const callers = new Set<string>();
  for (const [path, targets] of base.edges) {
    if (!isProduct(path)) continue;
    if ([...targets].some((target) => classifyPath(target) === "control-plane")) callers.add(path);
  }

  const slice = new Set([...dependencies, ...callers]);
  const names = new Set<string>();
  for (const file of input.baseFiles) {
    if (isRuntimeControlPlane(file.path) || slice.has(file.path)) {
      for (const name of configurationNames(file.text)) names.add(name);
    }
  }

  const slicePaths = new Set<string>();
  const problems: SliceProblem[] = [];
  const resultTracked = new Set(tracked);
  for (const change of input.changes) {
    if (change.status !== "deleted") resultTracked.add(change.path);
  }
  for (const change of input.changes) {
    for (const path of [change.path, change.previousPath].filter((p): p is string => p !== undefined)) {
      if (slice.has(path)) slicePaths.add(path);
    }
    if (change.status !== "deleted" && CODE_FILE.test(change.path)) {
      for (const specifier of importSpecifiers({ path: change.path, text: change.newText })) {
        const resolved = resolveSpecifier(change.path, specifier, resultTracked);
        if (resolved === null) {
          problems.push({ path: change.path, specifier, problem: "unresolved_import" });
        } else if (resolved !== "external" && classifyPath(resolved) === "control-plane") {
          slicePaths.add(change.path);
        }
      }
    }
    for (const name of names) {
      if (change.addedText.includes(name)) {
        slicePaths.add(change.path);
        break;
      }
    }
  }
  if (problems.length > 0) return { status: "failed", problems };
  return { status: "analysed", slicePaths, baseSliceSize: slice.size };
};
