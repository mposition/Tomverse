// Check every root-config input with the installed compiler, in serial processes.
// Ambient/global inputs accompany every batch. Next's generated validator is
// partitioned only at its independent top-level route-check blocks.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const self = fileURLToPath(import.meta.url);
const canonical = path => ts.sys.useCaseSensitiveFileNames ? resolve(path) : resolve(path).toLowerCase();
const sha = text => createHash("sha256").update(text).digest("hex");
const format = diagnostics => ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: name => name, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n",
});
const loadConfig = file => {
  const raw = ts.readConfigFile(file, ts.sys.readFile);
  if (raw.error) throw new Error(format([raw.error]));
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, dirname(file), undefined, file);
  if (parsed.errors.length) throw new Error(format(parsed.errors));
  if (parsed.projectReferences?.length) throw new Error("Use the project's reference build for referenced configurations.");
  return parsed;
};

function rebaseImports(text, original, virtual) {
  const source = ts.createSourceFile(original, text, ts.ScriptTarget.Latest, true);
  const edits = [];
  const visit = node => {
    if (ts.isStringLiteral(node) && node.text.startsWith(".") &&
      (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent) ||
        ts.isExternalModuleReference(node.parent) ||
        (ts.isLiteralTypeNode(node.parent) && ts.isImportTypeNode(node.parent.parent)))) {
      let path = relative(dirname(virtual), resolve(dirname(original), node.text)).split(sep).join("/");
      if (!path.startsWith(".")) path = `./${path}`;
      edits.push({ start: node.getStart(source), end: node.end, text: JSON.stringify(path) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}

// Share interface augmentations without importing an entire UI/test module into
// every batch. Its implementation is still a normal root. Value-dependent or
// unfamiliar augmentation forms retain the original module as a shared input.
function interfaceAugmentation(source) {
  const declarations = source.statements.filter(node => ts.isModuleDeclaration(node) &&
    (node.flags & ts.NodeFlags.GlobalAugmentation));
  if (!declarations.length || declarations.some(node => !node.body || !ts.isModuleBlock(node.body) ||
    node.body.statements.some(member => !ts.isInterfaceDeclaration(member)))) return null;
  const identifiers = new Set();
  const scan = node => { if (ts.isIdentifier(node)) identifiers.add(node.text); ts.forEachChild(node, scan); };
  declarations.forEach(scan);
  const types = source.statements.filter(node => ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node));
  const required = new Set();
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const node of types) if (identifiers.has(node.name.text) && !required.has(node)) {
      required.add(node); scan(node); expanded = true;
    }
  }
  const values = new Set();
  const bindings = name => {
    if (ts.isIdentifier(name)) values.add(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) bindings(element.name);
  };
  for (const node of source.statements) {
    if (ts.isVariableStatement(node)) node.declarationList.declarations.forEach(decl => bindings(decl.name));
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) ||
      (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name) && !(node.flags & ts.NodeFlags.GlobalAugmentation))) && node.name) values.add(node.name.text);
  }
  if ([...values].some(name => identifiers.has(name))) return null;
  const imports = [];
  const printer = ts.createPrinter();
  for (const node of source.statements) {
    if (ts.isImportEqualsDeclaration(node)) {
      if (identifiers.has(node.name.text)) imports.push(node.getFullText(source));
    } else if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (!clause) { imports.push(node.getFullText(source)); continue; }
      const name = clause.name && identifiers.has(clause.name.text) ? clause.name : undefined;
      let named = clause.namedBindings;
      if (named && ts.isNamedImports(named)) {
        const elements = named.elements.filter(item => identifiers.has(item.name.text));
        named = elements.length ? ts.factory.updateNamedImports(named, elements) : undefined;
      } else if (named && !identifiers.has(named.name.text)) named = undefined;
      if (name || named) imports.push(printer.printNode(ts.EmitHint.Unspecified,
        ts.factory.updateImportDeclaration(node, node.modifiers,
          ts.factory.updateImportClause(clause, clause.isTypeOnly, name, named), node.moduleSpecifier, node.attributes), source));
    }
  }
  return ["export {};", ...imports, ...types.filter(node => required.has(node)).map(node => node.getFullText(source)),
    ...declarations.map(node => node.getFullText(source))].join("\n");
}

export function createTypecheckPlan(configPath, outputDir, batchSize = 128, routeBatchSize = 24) {
  const config = loadConfig(configPath);
  const roots = config.fileNames.map(path => resolve(path));
  const globals = [], globalRoots = [], ordinary = [], validators = [], virtualFiles = {};
  const inputHashes = {};
  for (const file of roots) {
    const text = readFileSync(file, "utf8");
    inputHashes[file] = sha(text);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    if (/[\\/]\.next[\\/](?:dev[\\/])?types[\\/]validator\.ts$/.test(file)) {
      if (!text.startsWith("// This file is generated automatically by Next.js")) throw new Error(`Unknown generated validator: ${file}`);
      const blocks = source.statements.filter(ts.isBlock);
      const header = source.statements.filter(node => !ts.isBlock(node));
      if (!blocks.length || header.some(node => !ts.isImportDeclaration(node) && !ts.isTypeAliasDeclaration(node) &&
        !ts.isInterfaceDeclaration(node) && !ts.isExportDeclaration(node))) throw new Error(`Unsupported validator structure: ${file}`);
      const parts = [];
      for (let start = 0; start < blocks.length; start += routeBatchSize) {
        const virtual = join(outputDir, `validator-${validators.length}-${parts.length}.ts`);
        const group = blocks.slice(start, start + routeBatchSize);
        virtualFiles[virtual] = rebaseImports([...header, ...group].map(node => node.getFullText(source)).join("\n"), file, virtual);
        parts.push(virtual);
      }
      validators.push({ file, blocks: blocks.length, parts });
    } else if (source.isDeclarationFile || !ts.isExternalModule(source)) {
      globals.push(file); globalRoots.push(file);
    } else {
      const augmented = source.statements.some(node => ts.isModuleDeclaration(node) &&
        ((node.flags & ts.NodeFlags.GlobalAugmentation) || ts.isStringLiteral(node.name)));
      const isolated = augmented ? interfaceAugmentation(source) : null;
      if (isolated) {
        const virtual = join(outputDir, `global-${globals.length}.ts`);
        virtualFiles[virtual] = rebaseImports(isolated, file, virtual);
        globals.push(virtual); ordinary.push(file);
      } else if (augmented) { globals.push(file); globalRoots.push(file); }
      else ordinary.push(file);
    }
  }
  const batches = [];
  for (let start = 0; start < ordinary.length; start += batchSize) batches.push([...globals, ...ordinary.slice(start, start + batchSize)]);
  for (const validator of validators) for (const part of validator.parts) batches.push([...globals, part]);
  if (!batches.length && globals.length) batches.push(globals);
  const covered = new Set([...globalRoots, ...ordinary, ...validators.map(row => row.file)]);
  if (covered.size !== roots.length || roots.some(file => !covered.has(file))) throw new Error("Incomplete root coverage");
  return { configPath, options: { ...config.options, noEmit: true, incremental: false }, roots, inputHashes,
    configHash: sha(readFileSync(configPath)), globals, batches, validators, virtualFiles };
}

function worker(planPath, index) {
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  // This cache starts empty in each fresh run directory. The compiler itself
  // invalidates diagnostics for changed/affected files as batch roots change.
  const options = { ...plan.options, incremental: true, tsBuildInfoFile: join(dirname(planPath), "state.tsbuildinfo") };
  const virtual = new Map(Object.entries(plan.virtualFiles).map(([file, text]) => [canonical(file), text]));
  const host = ts.createIncrementalCompilerHost(options);
  const originalGet = host.getSourceFile.bind(host), originalExists = host.fileExists.bind(host), originalRead = host.readFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, fresh) => {
    const text = virtual.get(canonical(file));
    if (text === undefined) return originalGet(file, languageVersion, onError, fresh);
    const source = ts.createSourceFile(file, text, languageVersion, true);
    source.version = sha(text);
    return source;
  };
  host.fileExists = file => virtual.has(canonical(file)) || originalExists(file);
  host.readFile = file => virtual.get(canonical(file)) ?? originalRead(file);
  const program = ts.createIncrementalProgram({ rootNames: plan.batches[index], options, host });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) process.stderr.write(format(diagnostics));
  if (diagnostics.some(row => row.category === ts.DiagnosticCategory.Error)) return 1;
  const emitted = program.emit(); // noEmit writes only the per-run build-info cache.
  if (emitted.diagnostics.length) process.stderr.write(format(emitted.diagnostics));
  return emitted.diagnostics.some(row => row.category === ts.DiagnosticCategory.Error) ? 1 : 0;
}

export function runBoundedTypecheck({ configPath = resolve("tsconfig.json"), batchSize = 128, routeBatchSize = 24,
  heapMb = 4096, outputRoot = resolve(".tmp") } = {}) {
  mkdirSync(outputRoot, { recursive: true });
  const output = mkdtempSync(join(outputRoot, "typecheck-bounded-"));
  const plan = createTypecheckPlan(resolve(configPath), output, batchSize, routeBatchSize);
  const planPath = join(output, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan));
  console.log(`[typecheck-bounded] TypeScript ${ts.version}; ${plan.roots.length} roots, ${plan.globals.length} shared global inputs, ${plan.batches.length} serial batches, ${heapMb} MB per process`);
  let completed = 0;
  for (const [index, files] of plan.batches.entries()) {
    const result = spawnSync(process.execPath, [`--max-old-space-size=${heapMb}`, self, "--worker", planPath, String(index)], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) return { status: result.status ?? 1, completed, output };
    completed += 1;
    console.log(`[typecheck-bounded] ${completed}/${plan.batches.length} passed (${files.length} roots including shared inputs)`);
  }
  const current = loadConfig(plan.configPath).fileNames.map(path => resolve(path));
  if (JSON.stringify(current) !== JSON.stringify(plan.roots) || sha(readFileSync(plan.configPath)) !== plan.configHash ||
    plan.roots.some(file => sha(readFileSync(file)) !== plan.inputHashes[file])) throw new Error("Typecheck inputs changed during execution");
  const evidence = { compiler: ts.version, roots: plan.roots.length, completedBatches: completed,
    generatedRouteChecks: plan.validators.reduce((sum, row) => sum + row.blocks, 0),
    allRootsCovered: true, sourceUnchanged: true, noEmit: true, incrementalCacheScope: "fresh_run_only",
    inputDigest: sha(JSON.stringify(plan.inputHashes)) };
  writeFileSync(join(output, "result.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(`[typecheck-bounded] Complete: ${JSON.stringify(evidence)}`);
  return { status: 0, completed, output, evidence };
}

if (process.argv[1] && resolve(process.argv[1]) === self) {
  try {
    if (process.argv[2] === "--worker") process.exitCode = worker(process.argv[3], Number(process.argv[4]));
    else {
      const options = {};
      for (let i = 2; i < process.argv.length; i += 2) {
        const key = { "--project": "configPath", "--batch-size": "batchSize", "--route-batch-size": "routeBatchSize", "--heap-mb": "heapMb" }[process.argv[i]];
        if (!key || !process.argv[i + 1]) throw new Error("Unknown or incomplete typecheck option");
        options[key] = key === "configPath" ? (isAbsolute(process.argv[i + 1]) ? process.argv[i + 1] : resolve(process.argv[i + 1])) : Number(process.argv[i + 1]);
        if (key !== "configPath" && (!Number.isSafeInteger(options[key]) || options[key] <= 0)) throw new Error("Typecheck sizes must be positive integers");
      }
      process.exitCode = runBoundedTypecheck(options).status;
    }
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
