// The bytes the Zernio webhook pipeline fingerprint hashes (S2 plan, S2e/S2f;
// docs/policy/marketing-automation.md §8.1.1).
//
// The policy re-opens verification when code that affects conditions 1-5
// changes: the receiving route, signature check, event id dedupe, storage
// transaction, status mapping and status-query comparison. Hashing the route's
// whole import closure made every unrelated edit to a shared module -- a new
// audit actor, another feature's store function, a back relation added to
// `AdminAuditLog` -- stale a signed record and stop production apply (operator
// decision 2026-10-15: narrow the scope to what decides an event).
//
// So the sources are, deterministically:
// - the webhook modules (MARKETING_WEBHOOK_PIPELINE_FILES) whole;
// - from every other local file the webhook modules reach, only the top-level
//   declarations they use, followed transitively, without comments;
// - nothing from the shared modules (MARKETING_WEBHOOK_PIPELINE_SHARED_MODULES:
//   the audit chain, the database client), which their own tests hold;
// - the watched schema slice and the listed migrations, as before.
//
// Over-inclusion is the safe direction: an identifier that merely shares a
// declaration's name pulls that declaration in.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const isFile = (absolute) => {
  try {
    return statSync(absolute).isFile();
  } catch {
    return false;
  }
};

/** Resolve a local specifier the way the closure test does; null for a package. */
export const resolveLocalSpecifier = (repositoryRoot, fromPath, specifier, exists = isFile) => {
  let base;
  if (specifier.startsWith("@/")) base = path.join(repositoryRoot, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.join(repositoryRoot, path.dirname(fromPath), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, path.join(base, "index.ts")]) {
    if (exists(candidate)) return path.relative(repositoryRoot, candidate).split(path.sep).join("/");
  }
  throw new Error(`${fromPath}: cannot resolve ${specifier}`);
};

const declarationNames = (statement) => {
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    return statement.name ? [statement.name.text] : [];
  }
  if (ts.isVariableStatement(statement)) {
    const names = [];
    const collect = (binding) => {
      if (ts.isIdentifier(binding)) names.push(binding.text);
      else for (const element of binding.elements) if (!ts.isOmittedExpression(element)) collect(element.name);
    };
    for (const declaration of statement.declarationList.declarations) collect(declaration.name);
    return names;
  }
  return null;
};

const isDefaultExport = (statement) =>
  (ts.getModifiers?.(statement) ?? statement.modifiers ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
  );

const PURE_LITERALS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
]);

/**
 * Whether evaluating this initializer can do anything but produce a value from
 * literals, functions and references. Anything not proved pure is treated as
 * an effect: a call, `new`, a property read (a getter), an assignment.
 */
const isPureExpression = (node) => {
  if (node === undefined) return true;
  if (PURE_LITERALS.has(node.kind) || ts.isIdentifier(node)) return true;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  if (ts.isClassExpression(node)) return isPureClass(node);
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return isPureExpression(node.expression);
  }
  if (ts.isPrefixUnaryExpression(node)) return PURE_LITERALS.has(node.operand.kind);
  // An interpolation converts its value to a string, which can call toString.
  if (ts.isTemplateExpression(node)) return false;
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((element) => !ts.isSpreadElement(element) && isPureExpression(element));
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((property) => {
      // A computed key is converted to a property key, which can call toString.
      if (property.name && ts.isComputedPropertyName(property.name) && !PURE_LITERALS.has(property.name.expression.kind)) {
        return false;
      }
      if (ts.isPropertyAssignment(property)) return isPureExpression(property.initializer);
      return (
        ts.isShorthandPropertyAssignment(property) ||
        ts.isMethodDeclaration(property) ||
        ts.isGetAccessorDeclaration(property) ||
        ts.isSetAccessorDeclaration(property)
      );
    });
  }
  return false;
};

const isPureClass = (node) =>
  !(ts.getDecorators?.(node) ?? []).length &&
  (node.heritageClauses ?? []).every((clause) => clause.types.every((type) => isPureExpression(type.expression))) &&
  node.members.every((member) => {
    if (ts.isClassStaticBlockDeclaration(member)) return false;
    if ((ts.getDecorators?.(member) ?? []).length) return false;
    if (member.name && ts.isComputedPropertyName(member.name) && !PURE_LITERALS.has(member.name.expression.kind)) {
      return false;
    }
    const isStatic = (ts.getModifiers?.(member) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
    return !(isStatic && ts.isPropertyDeclaration(member) && !isPureExpression(member.initializer));
  });

/** Whether a top-level declaration does something when the module loads. */
const declarationHasEffect = (statement) => {
  if (ts.isVariableStatement(statement)) {
    // Destructuring runs getters, iterators and defaults; only a plain name is judged by its initializer.
    return !statement.declarationList.declarations.every(
      (declaration) => ts.isIdentifier(declaration.name) && isPureExpression(declaration.initializer),
    );
  }
  if (ts.isClassDeclaration(statement)) return !isPureClass(statement);
  if (ts.isEnumDeclaration(statement)) {
    return !statement.members.every((member) => isPureExpression(member.initializer));
  }
  return false;
};

/** A module loaded some other way than a static import cannot be followed. */
const refuseDynamicLoads = (repositoryRoot, filePath, file, exists) => {
  const visit = (node) => {
    let specifier = null;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
        specifier = node.arguments[0] ?? null;
        if (!specifier || !(ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier))) {
          throw new Error(`${filePath}: a dynamic import or require with a computed specifier cannot be followed`);
        }
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      specifier = node.moduleReference.expression;
    }
    if (specifier && resolveLocalSpecifier(repositoryRoot, filePath, specifier.text, exists)) {
      throw new Error(`${filePath}: a dynamic import or require of ${specifier.text} cannot be followed`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
};

/** One file's top-level shape: declarations, exported aliases, import bindings. */
const parseModule = (repositoryRoot, filePath, source, exists) => {
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  refuseDynamicLoads(repositoryRoot, filePath, file, exists);
  const statements = [];
  const declared = new Map(); // local name -> statement index
  const exported = new Map(); // exported name -> { local } | { file, name }
  const imports = new Map(); // local name -> { file, name } (file null: a package)
  const always = []; // statement indexes with effects of their own
  const loads = new Set(); // local modules this one loads at run time
  const loadOrder = []; // every run-time import and re-export, in evaluation order
  file.statements.forEach((statement, index) => {
    statements.push(statement);
    if (ts.isImportDeclaration(statement)) {
      const target = resolveLocalSpecifier(repositoryRoot, filePath, statement.moduleSpecifier.text, exists);
      const clause = statement.importClause;
      if (!clause || !clause.isTypeOnly) loadOrder.push(statement.moduleSpecifier.text);
      if (!clause) {
        if (target) throw new Error(`${filePath}: a side-effect import of ${target} cannot be sliced`);
        return;
      }
      if (target && !clause.isTypeOnly) loads.add(target);
      const specifier = statement.moduleSpecifier.text;
      if (clause.name) imports.set(clause.name.text, { file: target, specifier, name: "default" });
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        if (target) throw new Error(`${filePath}: a namespace import of ${target} cannot be sliced`);
        imports.set(bindings.name.text, { file: null, specifier, name: "*" });
      } else if (bindings) {
        for (const element of bindings.elements) {
          imports.set(element.name.text, { file: target, specifier, name: (element.propertyName ?? element.name).text });
        }
      }
      return;
    }
    if (ts.isExportDeclaration(statement)) {
      const target = statement.moduleSpecifier
        ? resolveLocalSpecifier(repositoryRoot, filePath, statement.moduleSpecifier.text, exists)
        : null;
      if (!statement.exportClause) {
        if (target) throw new Error(`${filePath}: "export *" from ${target} cannot be sliced`);
        return;
      }
      if (!ts.isNamedExports(statement.exportClause)) {
        throw new Error(`${filePath}: a namespace re-export cannot be sliced`);
      }
      if (target && !statement.isTypeOnly) loads.add(target);
      if (statement.moduleSpecifier && !statement.isTypeOnly) loadOrder.push(statement.moduleSpecifier.text);
      for (const element of statement.exportClause.elements) {
        const local = (element.propertyName ?? element.name).text;
        exported.set(
          element.name.text,
          statement.moduleSpecifier ? { file: target, name: local } : { local },
        );
      }
      return;
    }
    if (ts.isExportAssignment(statement)) {
      always.push(index);
      return;
    }
    const names = declarationNames(statement);
    if (names === null) {
      always.push(index);
      return;
    }
    for (const name of names) {
      declared.set(name, index);
      exported.set(name, { local: name });
    }
    if (isDefaultExport(statement)) exported.set("default", { local: names[0] ?? "default" });
    // Runs when the module loads, whether or not anything names it.
    if (declarationHasEffect(statement)) always.push(index);
  });
  return { statements, declared, exported, imports, always, loads, loadOrder };
};

/**
 * The fingerprint sources: [{ path, content }], sorted by path. `readText`
 * reads a repository-relative path (tests substitute content through it).
 */
export const marketingWebhookPipelineSources = ({
  repositoryRoot,
  wholeFiles,
  sharedModules,
  selfModule,
  readText = (relative) => readFileSync(path.join(repositoryRoot, relative), "utf8"),
  exists = isFile,
}) => {
  const whole = new Set(wholeFiles);
  const shared = new Set(sharedModules);
  const modules = new Map();
  const moduleOf = (relative) => {
    if (!modules.has(relative)) modules.set(relative, parseModule(repositoryRoot, relative, readText(relative), exists));
    return modules.get(relative);
  };
  const included = new Map(); // sliced file -> Set(statement index)
  const usedImports = new Map(); // sliced file -> Set(local import name)
  const reachedShared = new Set();
  const pending = [];

  const reach = (file, name) => {
    if (file === null || file === selfModule || whole.has(file)) return;
    if (shared.has(file)) {
      reachedShared.add(file);
      return;
    }
    pending.push([file, name]);
  };
  const followIdentifiers = (relative, node) => {
    const parsed = moduleOf(relative);
    const visit = (child) => {
      if (ts.isIdentifier(child)) {
        const text = child.text;
        if (parsed.declared.has(text)) pending.push([relative, { local: text }]);
        const imported = parsed.imports.get(text);
        if (imported) {
          // Which module and name a local stands for is part of the code: the
          // same declarations wired to swapped imports behave differently.
          if (!usedImports.has(relative)) usedImports.set(relative, new Set());
          usedImports.get(relative).add(text);
          reach(imported.file, imported.name);
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
  };
  // A loaded module is in the sources even with nothing to include: its
  // evaluation order (a re-export-only module has nothing else) still counts.
  const touch = (relative) => {
    if (included.has(relative)) return;
    included.set(relative, new Set());
    for (const always of moduleOf(relative).always) include(relative, always);
  };
  const include = (relative, index) => {
    touch(relative);
    const set = included.get(relative);
    if (set.has(index)) return;
    set.add(index);
    followIdentifiers(relative, moduleOf(relative).statements[index]);
  };

  const codeFiles = wholeFiles.filter((file) => /\.(ts|tsx|mjs)$/.test(file));
  for (const file of codeFiles) {
    const parsed = moduleOf(file);
    for (const imported of parsed.imports.values()) reach(imported.file, imported.name);
    for (const target of parsed.exported.values()) if (target.file) reach(target.file, target.name);
  }

  // Every module the path loads runs its top-level effects, used or not. The
  // shared modules' own imports are theirs, and this module is left out.
  const loaded = new Set();
  const toLoad = [...codeFiles];
  while (toLoad.length > 0) {
    const file = toLoad.pop();
    if (loaded.has(file) || shared.has(file) || file === selfModule) continue;
    loaded.add(file);
    const parsed = moduleOf(file);
    if (!whole.has(file)) touch(file);
    toLoad.push(...parsed.loads);
  }

  while (pending.length > 0) {
    const [file, request] = pending.pop();
    const parsed = moduleOf(file);
    if (typeof request === "object") {
      const index = parsed.declared.get(request.local);
      if (index === undefined) {
        const imported = parsed.imports.get(request.local);
        if (imported) reach(imported.file, imported.name);
        continue;
      }
      include(file, index);
      continue;
    }
    const target = parsed.exported.get(request);
    if (!target) throw new Error(`${file}: does not export ${request}`);
    if (target.file !== undefined) {
      reach(target.file, target.name);
      continue;
    }
    pending.push([file, { local: target.local }]);
  }

  const sources = wholeFiles.map((file) => ({ path: file, content: readText(file) }));
  for (const [file, indexes] of included) {
    const parsed = moduleOf(file);
    const wiring = [...(usedImports.get(file) ?? [])]
      .sort()
      .map((local) => {
        const binding = parsed.imports.get(local);
        return `// import ${local} = ${binding.file ?? `package:${binding.specifier}`}#${binding.name}`;
      });
    // Modules evaluate in import order, so their effects land in that order.
    const order = parsed.loadOrder.map((specifier) => `// load ${specifier}`);
    const content = [
      ...order,
      ...wiring,
      ...[...indexes].sort((left, right) => left - right).map((index) => parsed.statements[index].getText()),
    ].join("\n\n");
    sources.push({ path: file, content: `${content}\n` });
  }
  return {
    sources: sources.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    slicedFiles: [...included.keys()].sort(),
    reachedSharedModules: [...reachedShared].sort(),
  };
};
