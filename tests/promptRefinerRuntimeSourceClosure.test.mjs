import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

import {
  PROMPT_REFINER_RUNTIME_IMPORT_ROOTS,
  PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT,
  PROMPT_REFINER_RUNTIME_SOURCE_PATHS,
  PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES,
} from "../lib/promptRefinerStageAdmissionCore.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const repositoryRootReal = realpathSync.native(repositoryRoot);
const rootPackage = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
assert.ok(Array.isArray(rootPackage.workspaces), "package.json workspaces must be an array");

const repositoryPath = (absolute) => {
  const real = realpathSync.native(absolute);
  const path = relative(repositoryRootReal, real).replaceAll("\\", "/");
  assert.equal(
    path === ".." || path.startsWith("../") || isAbsolute(path),
    false,
    `resolved local runtime import escaped repository: ${real}`
  );
  return path;
};

const workspacePackageDirectories = rootPackage.workspaces.flatMap((pattern) => {
  assert.match(pattern, /^[^*]+\*$/, `unsupported workspace pattern ${pattern}`);
  const parent = join(repositoryRoot, pattern.slice(0, -1));
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name))
    .filter((directory) => existsSync(join(directory, "package.json")));
});

const workspacePackages = new Map(
  workspacePackageDirectories.map((directory) => {
    const manifestPath = join(directory, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(typeof manifest.name, "string", `workspace has no name: ${manifestPath}`);
    return [manifest.name, { directory, manifest }];
  })
);
assert.equal(workspacePackages.size, workspacePackageDirectories.length, "workspace names must be unique");

const configFile = ts.readConfigFile(join(repositoryRoot, "tsconfig.json"), ts.sys.readFile);
assert.equal(configFile.error, undefined);
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repositoryRoot);
assert.deepEqual(parsedConfig.errors, []);
const compilerOptions = parsedConfig.options;

// JavaScript permits every object to become a capability source through a
// computed property such as `value[key]`, where `key` later resolves to
// `constructor`.  Trying to enumerate every spelling is not fail-closed.  The
// existing runtime closure therefore gets one deliberately narrow exception:
// its already-reviewed data-indexing expressions are frozen as an exact
// path/position/text snapshot.  Any new or moved non-static element access must
// be reviewed and must update this digest before the closure gate can pass.
//
// 2026-09-20: repinned for moved positions only. A comment in
// `lib/marketingAutomationAccess.ts` was rewritten and shifted the lines under
// it; the count assertion above still held, and the inventory compared without
// line and column -- `path + expression text` for every entry -- came back
// byte-identical, so nothing was added, removed or changed. Only the snapshot's
// positions moved.
//
// 2026-09-21: the AMUX review adds one system-actor string literal and extends
// the watched-schema review comment in `lib/marketingAutomationAccess.ts`.
// The entry count and the same position-free inventory remain identical; only
// later source positions in those two files moved.
//
// 2026-09-21: merging confirmatory shadow v4 with that AMUX baseline preserves
// all 228 reviewed expressions. The combined marketing review comment and
// Prompt Refiner source positions move the position-bound snapshot once more.
const REVIEWED_DYNAMIC_ELEMENT_ACCESS_COUNT = 228;
const REVIEWED_DYNAMIC_ELEMENT_ACCESS_SHA256 = [
  "aef84a56d3987369ba874236dc340de6",
  "3338c274ebc34afb36a24616ba0a7c47",
].join("");

const unwrapStaticExpression = (node) => {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const staticComputedPropertyValue = (node) => {
  const current = unwrapStaticExpression(node);
  if (
    ts.isStringLiteral(current) ||
    ts.isNoSubstitutionTemplateLiteral(current) ||
    ts.isNumericLiteral(current)
  ) {
    return current.text;
  }
  if (
    ts.isPrefixUnaryExpression(current) &&
    ts.isNumericLiteral(current.operand) &&
    (current.operator === ts.SyntaxKind.PlusToken ||
      current.operator === ts.SyntaxKind.MinusToken)
  ) {
    return current.getText();
  }
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticComputedPropertyValue(current.left);
    const right = staticComputedPropertyValue(current.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
};

const dynamicElementAccessSnapshot = () => {
  const entries = [];
  for (const path of PROMPT_REFINER_RUNTIME_SOURCE_PATHS) {
    if (!/\.(?:[cm]?[jt]sx?)$/.test(path)) continue;
    const source = ts.createSourceFile(
      path,
      readFileSync(join(repositoryRoot, path), "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    const visit = (node) => {
      if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        staticComputedPropertyValue(node.argumentExpression) === null
      ) {
        const location = source.getLineAndCharacterOfPosition(node.getStart(source));
        entries.push(
          `${path}:${location.line + 1}:${location.character + 1}:${node.getText(source)}`
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  entries.sort();
  return {
    entries,
    digest: createHash("sha256").update(entries.join("\n")).digest("hex"),
  };
};

const resolutionOptionsSnapshot = (config) => ({
  baseUrl: config.baseUrl ?? null,
  rootDirs: config.rootDirs ?? null,
  moduleSuffixes: config.moduleSuffixes ?? null,
  paths: config.paths ?? null,
});
const expectedResolutionOptions = Object.freeze({
  baseUrl: null,
  rootDirs: null,
  moduleSuffixes: null,
  paths: {
    "@/*": ["./*"],
    "@tomverse/chat-core": ["./packages/chat-core/src/index.ts"],
  },
});
const assertResolutionOptions = (options) =>
  assert.deepEqual(
    resolutionOptionsSnapshot(options),
    expectedResolutionOptions,
    "resolution-affecting tsconfig options changed; review and recompute the durable closure"
  );
assertResolutionOptions(compilerOptions);

const fixedNonImportPaths = Object.freeze([
  ".gitattributes",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "prisma/schema.prisma",
  "prisma/migrations/20260918130000_prompt_refiner_stage_admission/migration.sql",
  "prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql",
  ...workspacePackageDirectories.map((directory) => repositoryPath(join(directory, "package.json"))).sort(),
]);

const workspaceForSpecifier = (specifier) =>
  [...workspacePackages.entries()]
    .sort(([left], [right]) => right.length - left.length)
    .find(([name]) => specifier === name || specifier.startsWith(`${name}/`)) ?? null;

const exportedWorkspaceTarget = (specifier, workspace) => {
  const [name, value] = workspace;
  const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
  const exports = value.manifest.exports;
  let target = typeof exports === "string" && subpath === "." ? exports : exports?.[subpath];
  if (target && typeof target === "object") {
    target = target.import ?? target.default ?? target.node ?? null;
  }
  assert.equal(
    typeof target,
    "string",
    `unresolved local workspace import ${specifier}; ${name} does not export ${subpath}`
  );
  const absolute = join(value.directory, target);
  assert.ok(existsSync(absolute) && statSync(absolute).isFile(), `workspace export is not a file: ${specifier}`);
  return repositoryPath(absolute);
};

const compilerAliasCouldBeLocal = (specifier) =>
  Object.keys(compilerOptions.paths ?? {}).some((pattern) => {
    const star = pattern.indexOf("*");
    return star === -1
      ? specifier === pattern
      : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
  });

const isInstalledDependencyResolution = (path) =>
  path.replaceAll("\\", "/").split("/").includes("node_modules");

const resolveLocalRuntimeImport = (fromPath, specifier) => {
  const workspace = workspaceForSpecifier(specifier);
  assert.equal(
    specifier.startsWith("@tomverse/") && workspace === null,
    false,
    `unrecognized local workspace import: ${specifier} from ${fromPath}`
  );
  const resolution = ts.resolveModuleName(
    specifier,
    join(repositoryRoot, fromPath),
    compilerOptions,
    ts.sys
  ).resolvedModule;
  if (resolution) {
    const resolvedReal = realpathSync.native(resolution.resolvedFileName);
    const path = relative(repositoryRootReal, resolvedReal);
    // npm installs external packages below node_modules inside the checkout on
    // Linux, while a Windows junction may resolve outside the checkout. Treat
    // both layouts alike. Workspace links realpath back to packages/* and are
    // still included by the local-runtime branch below.
    if (workspace === null && isInstalledDependencyResolution(path)) return null;
    const inside = path !== ".." && !path.startsWith(`..\\`) && !path.startsWith("../") && !isAbsolute(path);
    if (inside) {
      assert.equal(
        resolvedReal.endsWith(".d.ts"),
        false,
        `local runtime import resolved only to a declaration: ${specifier} from ${fromPath}`
      );
      return repositoryPath(resolvedReal);
    }
    assert.equal(
      workspace !== null || specifier.startsWith("@tomverse/"),
      false,
      `local workspace import resolved outside repository: ${specifier} from ${fromPath}`
    );
    return null;
  }
  if (workspace) return exportedWorkspaceTarget(specifier, workspace);
  assert.equal(
    specifier.startsWith(".") || compilerAliasCouldBeLocal(specifier) || specifier.startsWith("@tomverse/"),
    false,
    `unresolved or misclassified local runtime import ${specifier} from ${fromPath}`
  );
  return null;
};

const importDeclarationHasRuntimeValue = (node) => {
  if (!node.importClause) return true;
  if (node.importClause.isTypeOnly) return false;
  if (node.importClause.name) return true;
  const bindings = node.importClause.namedBindings;
  if (ts.isNamespaceImport(bindings)) return true;
  return ts.isNamedImports(bindings) && bindings.elements.some((element) => !element.isTypeOnly);
};

const runtimeImportSpecifiers = (
  path,
  text,
  { allowReviewedDynamicElementAccesses = false } = {}
) => {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const specifiers = [];
  const isNodeModuleSpecifier = (value) =>
    value === "node:module" || value === "module";
  const loaderIdentifiers = new Set(["require"]);
  const createRequireFactories = new Set();
  const moduleNamespaces = new Set();
  const moduleObjectIdentifiers = new Set(["module"]);
  const reflectApplyIdentifiers = new Set();
  const globalStateAliases = new Set();
  const nodeGlobalAliases = new Set();
  const allNodes = [];
  const collect = (node) => {
    allNodes.push(node);
    if (
      ts.isImportDeclaration(node) &&
      node.importClause &&
      !node.importClause.isTypeOnly &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isNodeModuleSpecifier(node.moduleSpecifier.text)
    ) {
      if (node.importClause.name) {
        moduleNamespaces.add(node.importClause.name.text);
      }
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly && (element.propertyName?.text ?? element.name.text) === "createRequire") {
            createRequireFactories.add(element.name.text);
          }
        }
      }
      if (bindings && ts.isNamespaceImport(bindings)) {
        moduleNamespaces.add(bindings.name.text);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      isNodeModuleSpecifier(node.moduleReference.expression.text)
    ) {
      moduleNamespaces.add(node.name.text);
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isNodeModuleSpecifier(node.moduleSpecifier.text) &&
      (!node.exportClause ||
        !ts.isNamedExports(node.exportClause) ||
        node.exportClause.elements.some((element) => !element.isTypeOnly))
    ) {
      assert.fail(`node:module runtime re-export cannot be resolved safely in ${path}`);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const staticStringValue = (node) => {
    const current = unwrapTransparentExpression(node);
    if (
      ts.isStringLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current)
    ) {
      return current.text;
    }
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = staticStringValue(current.left);
      const right = staticStringValue(current.right);
      return left === null || right === null ? null : left + right;
    }
    return null;
  };
  const staticPropertyName = (node) => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      return staticStringValue(node.argumentExpression);
    }
    return null;
  };
  const unwrapTransparentExpression = (node) => {
    let current = node;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  };
  const isInTypePosition = (node) => {
    for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
      if (ts.isTypeNode(current)) return true;
    }
    return false;
  };
  const isReflectApplyReference = (node) =>
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Reflect" &&
    staticPropertyName(node) === "apply";
  const isProcessGetBuiltinModule = (node) =>
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process" &&
    staticPropertyName(node) === "getBuiltinModule";
  const isDynamicCodeReference = (node) =>
    (ts.isIdentifier(node) && (node.text === "eval" || node.text === "Function")) ||
    ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "globalThis" &&
      (staticPropertyName(node) === "eval" || staticPropertyName(node) === "Function"));
  const DANGEROUS_REFLECTION_PROPERTIES = new Set([
    "constructor",
    "__proto__",
    "prototype",
  ]);
  const SAFE_INTRINSIC_PROTOTYPE_MEMBERS = new Map([
    ["Object", new Set()],
    ["RegExp", new Set(["exec"])],
    ["Uint8Array", new Set(["set"])],
    ["TextDecoder", new Set(["decode"])],
  ]);
  const isAllowedIntrinsicPrototypeReference = (node) => {
    if (
      !ts.isPropertyAccessExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      node.name.text !== "prototype" ||
      !SAFE_INTRINSIC_PROTOTYPE_MEMBERS.has(node.expression.text)
    ) {
      return false;
    }
    if (
      node.expression.text === "Object" &&
      ts.isArrayLiteralExpression(node.parent)
    ) {
      return true;
    }
    if (
      (ts.isPropertyAccessExpression(node.parent) ||
        ts.isElementAccessExpression(node.parent)) &&
      node.parent.expression === node
    ) {
      return SAFE_INTRINSIC_PROTOTYPE_MEMBERS.get(node.expression.text).has(
        staticPropertyName(node.parent)
      );
    }
    return (
      ts.isCallExpression(node.parent) &&
      node.parent.arguments.includes(node) &&
      ts.isPropertyAccessExpression(node.parent.expression) &&
      ts.isIdentifier(node.parent.expression.expression) &&
      node.parent.expression.expression.text === "Object" &&
      node.parent.expression.name.text === "getPrototypeOf"
    );
  };
  const containsDynamicCodeReference = (node) => {
    if (isDynamicCodeReference(node)) return true;
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      return containsDynamicCodeReference(node.expression);
    }
    if (ts.isBinaryExpression(node)) {
      return (
        containsDynamicCodeReference(node.left) ||
        containsDynamicCodeReference(node.right)
      );
    }
    if (ts.isConditionalExpression(node)) {
      return (
        containsDynamicCodeReference(node.whenTrue) ||
        containsDynamicCodeReference(node.whenFalse)
      );
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return containsDynamicCodeReference(node.expression);
    }
    return false;
  };

  for (const node of allNodes) {
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      staticComputedPropertyValue(node.argumentExpression) === null &&
      !allowReviewedDynamicElementAccesses
    ) {
      assert.fail(`non-static element access cannot be resolved safely in ${path}`);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      (ts.isStringLiteral(node.arguments[0]) ||
        ts.isNoSubstitutionTemplateLiteral(node.arguments[0])) &&
      isNodeModuleSpecifier(node.arguments[0].text)
    ) {
      assert.fail(`dynamic node:module namespace cannot be resolved safely in ${path}`);
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      DANGEROUS_REFLECTION_PROPERTIES.has(staticPropertyName(node)) &&
      !isAllowedIntrinsicPrototypeReference(node)
    ) {
      assert.fail(`dynamic constructor or prototype capability cannot be resolved safely in ${path}`);
    }
    if (isProcessGetBuiltinModule(node)) {
      assert.fail(`process.getBuiltinModule cannot be resolved safely in ${path}`);
    }
    if (
      ts.isElementAccessExpression(node) &&
      (staticPropertyName(node) === "require" || staticPropertyName(node) === "createRequire")
    ) {
      assert.fail(`computed runtime loader cannot be resolved safely in ${path}`);
    }
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      containsDynamicCodeReference(node.expression)
    ) {
      assert.fail(`eval or Function cannot be resolved safely in ${path}`);
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      containsDynamicCodeReference(node.initializer)
    ) {
      assert.fail(`indirect eval or Function cannot be resolved safely in ${path}`);
    }
  }

  const isModuleRequire = (node) =>
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "module" &&
    node.name.text === "require";
  const isCreateRequireReference = (node) =>
    (ts.isIdentifier(node) && createRequireFactories.has(node.text)) ||
    (ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      moduleNamespaces.has(node.expression.text) &&
      node.name.text === "createRequire");
  const isCreateRequireCall = (node) =>
    ts.isCallExpression(node) &&
    isCreateRequireReference(node.expression);
  const isLoaderExpression = (node) =>
    (ts.isIdentifier(node) && loaderIdentifiers.has(node.text)) ||
    isModuleRequire(node) ||
    isCreateRequireCall(node);
  const isNodeModuleNamespaceLoadCall = (node) => {
    const current = unwrapTransparentExpression(node);
    return (
      ts.isCallExpression(current) &&
      isLoaderExpression(current.expression) &&
      current.arguments.length === 1 &&
      (ts.isStringLiteral(current.arguments[0]) ||
        ts.isNoSubstitutionTemplateLiteral(current.arguments[0])) &&
      isNodeModuleSpecifier(current.arguments[0].text)
    );
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of allNodes) {
      if (!ts.isVariableDeclaration(node) || !node.initializer) continue;
      const unwrappedInitializer = unwrapTransparentExpression(node.initializer);
      if (
        ts.isIdentifier(unwrappedInitializer) &&
        (unwrappedInitializer.text === "process" ||
          unwrappedInitializer.text === "module" ||
          unwrappedInitializer.text === "Reflect")
      ) {
        assert.fail(`indirect runtime capability cannot be resolved safely in ${path}`);
      }
      if (
        ts.isIdentifier(node.name) &&
        ts.isIdentifier(unwrappedInitializer) &&
        unwrappedInitializer.text === "globalThis" &&
        !globalStateAliases.has(node.name.text)
      ) {
        globalStateAliases.add(node.name.text);
        changed = true;
      }
      if (
        path === "lib/prisma.ts" &&
        ts.isIdentifier(node.name) &&
        node.name.text === "globalForPrisma" &&
        ts.isIdentifier(unwrappedInitializer) &&
        unwrappedInitializer.text === "global" &&
        !nodeGlobalAliases.has(node.name.text)
      ) {
        // This is the one reviewed use of Node's legacy `global` alias in the
        // runtime closure.  Bind the exact path, local name, and field below;
        // every other `global` alias remains fail-closed.
        nodeGlobalAliases.add(node.name.text);
        changed = true;
      }
      if (
        (ts.isIdentifier(node.name) || ts.isObjectBindingPattern(node.name)) &&
        ts.isIdentifier(node.initializer) &&
        moduleObjectIdentifiers.has(node.initializer.text)
      ) {
        assert.fail(`indirect module loader cannot be resolved safely in ${path}`);
      }
      if (
        ts.isObjectBindingPattern(node.name) &&
        ts.isCallExpression(node.initializer) &&
        isLoaderExpression(node.initializer.expression) &&
        node.initializer.arguments.length === 1 &&
        ts.isStringLiteral(node.initializer.arguments[0]) &&
        isNodeModuleSpecifier(node.initializer.arguments[0].text)
      ) {
        assert.ok(
          node.name.elements.every(
            (element) =>
              ts.isIdentifier(element.name) &&
              (element.propertyName?.getText(source) ?? element.name.text) ===
                "createRequire"
          ),
          `node:module namespace destructuring cannot be resolved safely in ${path}`
        );
        for (const element of node.name.elements) {
          if (
            ts.isIdentifier(element.name) &&
            (element.propertyName?.getText(source) ?? element.name.text) === "createRequire" &&
            !createRequireFactories.has(element.name.text)
          ) {
            createRequireFactories.add(element.name.text);
            changed = true;
          }
        }
        continue;
      }
      if (!ts.isIdentifier(node.name)) continue;
      if (
        isReflectApplyReference(node.initializer) ||
        (ts.isIdentifier(node.initializer) && reflectApplyIdentifiers.has(node.initializer.text))
      ) {
        if (!reflectApplyIdentifiers.has(node.name.text)) {
          reflectApplyIdentifiers.add(node.name.text);
          changed = true;
        }
      } else if (isCreateRequireReference(node.initializer)) {
        if (!createRequireFactories.has(node.name.text)) {
          createRequireFactories.add(node.name.text);
          changed = true;
        }
      } else if (ts.isIdentifier(node.initializer) && moduleNamespaces.has(node.initializer.text)) {
        if (!moduleNamespaces.has(node.name.text)) {
          moduleNamespaces.add(node.name.text);
          changed = true;
        }
      } else if (
        ts.isCallExpression(node.initializer) &&
        isLoaderExpression(node.initializer.expression) &&
        node.initializer.arguments.length === 1 &&
        ts.isStringLiteral(node.initializer.arguments[0]) &&
        isNodeModuleSpecifier(node.initializer.arguments[0].text)
      ) {
        if (!moduleNamespaces.has(node.name.text)) {
          moduleNamespaces.add(node.name.text);
          changed = true;
        }
      } else if (isLoaderExpression(node.initializer) && !loaderIdentifiers.has(node.name.text)) {
        loaderIdentifiers.add(node.name.text);
        changed = true;
      }
    }
  }

  // A module namespace returned by require/module.require is a capability in
  // exactly the same way as an imported namespace.  Do not let a direct chain
  // bypass the namespace tracking above: `require("node:module").createRequire`
  // and `require("module")._load` would otherwise record only the builtin and
  // silently omit the local module loaded by the chained call.
  for (const node of allNodes) {
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      isNodeModuleNamespaceLoadCall(node.expression)
    ) {
      assert.fail(`direct node:module namespace surface cannot be resolved safely in ${path}`);
    }
  }

  for (const node of allNodes) {
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      moduleNamespaces.has(node.expression.text)
    ) {
      assert.ok(
        ts.isPropertyAccessExpression(node) &&
          staticPropertyName(node) === "createRequire",
        `node:module namespace surface cannot be resolved safely in ${path}`
      );
    }
  }

  const SAFE_GLOBAL_STATE_PROPERTIES = new Set(["__tomverseOperationalState"]);
  const SAFE_OPERATIONAL_STATE_FIELDS = new Set([
    "lastNotifiedAt",
    "dependencies",
  ]);
  const SAFE_OPERATIONAL_STATE_METHODS = new Set(["get", "set"]);
  const operationalStateAliases = new Set();
  const allowedGlobalStateAccesses = new Set();
  const isSafeGlobalStateAccess = (node) =>
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    ts.isIdentifier(unwrapTransparentExpression(node.expression)) &&
    (unwrapTransparentExpression(node.expression).text === "globalThis" ||
      globalStateAliases.has(unwrapTransparentExpression(node.expression).text)) &&
    SAFE_GLOBAL_STATE_PROPERTIES.has(staticPropertyName(node));
  for (const node of allNodes) {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) {
      continue;
    }
    const initializer = unwrapTransparentExpression(node.initializer);
    if (
      !ts.isBinaryExpression(initializer) ||
      initializer.operatorToken.kind !== ts.SyntaxKind.BarBarToken
    ) {
      continue;
    }
    const read = unwrapTransparentExpression(initializer.left);
    const assignment = unwrapTransparentExpression(initializer.right);
    if (
      !isSafeGlobalStateAccess(read) ||
      !ts.isBinaryExpression(assignment) ||
      assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    ) {
      continue;
    }
    const write = unwrapTransparentExpression(assignment.left);
    const initialValue = unwrapTransparentExpression(assignment.right);
    if (
      !isSafeGlobalStateAccess(write) ||
      staticPropertyName(read) !== staticPropertyName(write) ||
      !ts.isObjectLiteralExpression(initialValue)
    ) {
      continue;
    }
    operationalStateAliases.add(node.name.text);
    allowedGlobalStateAccesses.add(read);
    allowedGlobalStateAccesses.add(write);
  }
  const isTransparentAliasInitializer = (node, aliases) => {
    let current = node;
    while (
      current.parent &&
      (ts.isParenthesizedExpression(current.parent) ||
        ts.isAsExpression(current.parent) ||
        ts.isTypeAssertionExpression(current.parent) ||
        ts.isNonNullExpression(current.parent)) &&
      current.parent.expression === current
    ) {
      current = current.parent;
    }
    return (
      ts.isVariableDeclaration(current.parent) &&
      current.parent.initializer === current &&
      ts.isIdentifier(current.parent.name) &&
      aliases.has(current.parent.name.text)
    );
  };

  for (const node of allNodes) {
    if (isInTypePosition(node)) continue;

    if (isSafeGlobalStateAccess(node)) {
      assert.ok(
        path === "lib/operationalMonitoring.ts" &&
          allowedGlobalStateAccesses.has(node),
        `global state capability cannot be resolved safely in ${path}`
      );
    }

    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(unwrapTransparentExpression(node.expression)) &&
      operationalStateAliases.has(unwrapTransparentExpression(node.expression).text)
    ) {
      const field = staticPropertyName(node);
      const methodAccess = node.parent;
      assert.ok(
        SAFE_OPERATIONAL_STATE_FIELDS.has(field) &&
          (ts.isPropertyAccessExpression(methodAccess) ||
            ts.isElementAccessExpression(methodAccess)) &&
          methodAccess.expression === node &&
          SAFE_OPERATIONAL_STATE_METHODS.has(staticPropertyName(methodAccess)) &&
          ts.isCallExpression(methodAccess.parent) &&
          methodAccess.parent.expression === methodAccess,
        `operational state capability cannot be resolved safely in ${path}`
      );
    }

    if (isReflectApplyReference(node)) {
      const parent = node.parent;
      assert.ok(
        (ts.isVariableDeclaration(parent) && parent.initializer === node) ||
          (ts.isCallExpression(parent) && parent.expression === node),
        `indirect Reflect.apply cannot be resolved safely in ${path}`
      );
    }

    if (ts.isCallExpression(node)) {
      const isReflectApply =
        isReflectApplyReference(node.expression) ||
        (ts.isIdentifier(node.expression) && reflectApplyIdentifiers.has(node.expression.text));
      if (isReflectApply) {
        assert.equal(node.arguments.length, 3, `ambiguous Reflect.apply call in ${path}`);
      }
    }

    if (!ts.isIdentifier(node)) continue;
    const parent = node.parent;
    if (node.text === "eval" || node.text === "Function") {
      assert.fail(`eval or Function cannot be resolved safely in ${path}`);
    }
    if (node.text === "global") {
      // Node's `global` is an alias for globalThis.  Only Prisma's exact,
      // field-constrained development singleton alias is reviewed.  Static
      // element access such as global["eval"] and every new alias remain
      // fail-closed.
      assert.ok(
        isTransparentAliasInitializer(node, nodeGlobalAliases),
        `global capability cannot be resolved safely in ${path}`
      );
    }
    if (node.text === "module") {
      assert.ok(
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
          parent.expression === node &&
          staticPropertyName(parent) === "require",
        `module capability cannot be resolved safely in ${path}`
      );
    }
    if (node.text === "process") {
      const isPropertyReceiver =
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === node;
      const property = isPropertyReceiver ? staticPropertyName(parent) : null;
      const isEnvRead = property === "env";
      const isDirectCwdCall =
        property === "cwd" &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent;
      assert.ok(
        isEnvRead || isDirectCwdCall,
        `process capability cannot be resolved safely in ${path}`
      );
    }
    if (node.text === "globalThis") {
      const isSafeProperty =
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === node &&
        SAFE_GLOBAL_STATE_PROPERTIES.has(staticPropertyName(parent));
      assert.ok(
        isSafeProperty || isTransparentAliasInitializer(node, globalStateAliases),
        `globalThis capability cannot be resolved safely in ${path}`
      );
    }
    if (node.text === "Reflect") {
      assert.ok(
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
          parent.expression === node &&
          staticPropertyName(parent) === "apply",
        `Reflect capability cannot be resolved safely in ${path}`
      );
    }
    if (globalStateAliases.has(node.text)) {
      const isDeclaration = ts.isVariableDeclaration(parent) && parent.name === node;
      const isSafeProperty =
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === node &&
        SAFE_GLOBAL_STATE_PROPERTIES.has(staticPropertyName(parent));
      assert.ok(
        isDeclaration || isSafeProperty,
        `globalThis alias cannot be resolved safely in ${path}`
      );
    }
    if (nodeGlobalAliases.has(node.text)) {
      const isDeclaration = ts.isVariableDeclaration(parent) && parent.name === node;
      const isPrismaField =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        parent.name.text === "prisma";
      assert.ok(
        path === "lib/prisma.ts" && (isDeclaration || isPrismaField),
        `global alias cannot be resolved safely in ${path}`
      );
    }
    if (operationalStateAliases.has(node.text)) {
      const isDeclaration = ts.isVariableDeclaration(parent) && parent.name === node;
      const isSafeField =
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === node &&
        SAFE_OPERATIONAL_STATE_FIELDS.has(staticPropertyName(parent));
      assert.ok(
        isDeclaration || isSafeField,
        `operational state alias cannot be resolved safely in ${path}`
      );
    }
    if (reflectApplyIdentifiers.has(node.text)) {
      const isDeclaration = ts.isVariableDeclaration(parent) && parent.name === node;
      const isDirectCall = ts.isCallExpression(parent) && parent.expression === node;
      assert.ok(
        isDeclaration || isDirectCall,
        `indirect Reflect.apply cannot be resolved safely in ${path}`
      );
    }
    if (moduleNamespaces.has(node.text)) {
      const isVariableDeclaration =
        ts.isVariableDeclaration(parent) && parent.name === node;
      const isNamespaceAliasSource =
        ts.isVariableDeclaration(parent) &&
        parent.initializer === node &&
        ts.isIdentifier(parent.name) &&
        moduleNamespaces.has(parent.name.text);
      const isDefaultImport =
        ts.isImportClause(parent) && parent.name === node;
      const isNamespaceImport =
        ts.isNamespaceImport(parent) && parent.name === node;
      const isImportEquals =
        ts.isImportEqualsDeclaration(parent) && parent.name === node;
      const isCreateRequireReceiver =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        parent.name.text === "createRequire";
      assert.ok(
        isVariableDeclaration ||
          isNamespaceAliasSource ||
          isDefaultImport ||
          isNamespaceImport ||
          isImportEquals ||
          isCreateRequireReceiver,
        `indirect node:module namespace use cannot be resolved safely in ${path}`
      );
    }
  }

  for (const node of allNodes) {
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (moduleObjectIdentifiers.has(node.expression.text) ||
        moduleNamespaces.has(node.expression.text) ||
        loaderIdentifiers.has(node.expression.text))
    ) {
      assert.fail(`computed runtime loader cannot be resolved safely in ${path}`);
    }
  }

  const addLiteralSpecifier = (node) => {
    assert.ok(node && ts.isStringLiteral(node), `non-literal runtime import in ${path}`);
    specifiers.push(node.text);
  };
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      importDeclarationHasRuntimeValue(node)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      (!node.exportClause ||
        !ts.isNamedExports(node.exportClause) ||
        node.exportClause.elements.some((element) => !element.isTypeOnly))
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      addLiteralSpecifier(node.arguments[0]);
    } else if (ts.isCallExpression(node) && isLoaderExpression(node.expression)) {
      assert.equal(node.arguments.length, 1, `ambiguous runtime loader call in ${path}`);
      addLiteralSpecifier(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  for (const node of allNodes) {
    if (isCreateRequireCall(node)) {
      const parent = node.parent;
      assert.ok(
        (ts.isVariableDeclaration(parent) && parent.initializer === node) ||
          (ts.isCallExpression(parent) && parent.expression === node),
        `indirect createRequire result cannot be resolved safely in ${path}`
      );
    }
    const isLoaderIdentifier = ts.isIdentifier(node) && loaderIdentifiers.has(node.text);
    const isFactoryReference = isCreateRequireReference(node);
    if (!isLoaderIdentifier && !isFactoryReference && !isModuleRequire(node)) continue;
    const parent = node.parent;
    const isCalled = ts.isCallExpression(parent) && parent.expression === node;
    const isAliased = ts.isVariableDeclaration(parent) && parent.initializer === node;
    const isDeclared = ts.isVariableDeclaration(parent) && parent.name === node;
    const isBindingDeclared = ts.isBindingElement(parent) && parent.name === node;
    const isImportedFactory =
      isFactoryReference &&
      ((ts.isImportSpecifier(parent) && parent.name === node) ||
        (ts.isNamespaceImport(parent) && parent.name === node));
    const isPropertyPart = isModuleRequire(parent) && (parent.expression === node || parent.name === node);
    assert.ok(
      isCalled || isAliased || isDeclared || isBindingDeclared || isImportedFactory || isPropertyPart || isCreateRequireReference(parent),
      `indirect runtime loader use cannot be resolved safely in ${path}: ${node.getText(source)}`
    );
  }
  return specifiers;
};

const localRuntimeImports = (path) => {
  if (!/\.(?:[cm]?[jt]sx?)$/.test(path)) return [];
  return runtimeImportSpecifiers(path, readFileSync(join(repositoryRoot, path), "utf8"), {
    allowReviewedDynamicElementAccesses: true,
  })
    .map((specifier) => resolveLocalRuntimeImport(path, specifier))
    .filter((candidate) => candidate !== null);
};

const runtimeImportClosure = () => {
  const pending = [...PROMPT_REFINER_RUNTIME_IMPORT_ROOTS];
  const closure = new Set();
  while (pending.length > 0) {
    const path = pending.shift();
    if (closure.has(path)) continue;
    assert.ok(existsSync(join(repositoryRoot, path)), `missing runtime import root ${path}`);
    closure.add(path);
    for (const imported of localRuntimeImports(path)) {
      if (!closure.has(imported)) pending.push(imported);
    }
  }
  return [...closure].sort();
};

test("runtime source allowlist is exactly the deterministic local runtime import closure", () => {
  const dynamicAccesses = dynamicElementAccessSnapshot();
  assert.equal(
    dynamicAccesses.entries.length,
    REVIEWED_DYNAMIC_ELEMENT_ACCESS_COUNT,
    "non-static element access inventory changed; review every new or moved access"
  );
  assert.equal(
    dynamicAccesses.digest,
    REVIEWED_DYNAMIC_ELEMENT_ACCESS_SHA256,
    "non-static element access snapshot changed; unreviewed computed access is fail-closed"
  );
  const expected = [...fixedNonImportPaths, ...runtimeImportClosure()];
  const actual = [...PROMPT_REFINER_RUNTIME_SOURCE_PATHS];
  const listed = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((path) => !listed.has(path));
  const extra = actual.filter((path) => !expectedSet.has(path));
  const firstDifferentIndex = actual.findIndex((path, index) => path !== expected[index]);
  assert.equal(
    expected.length,
    PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT,
    `runtime source closure has ${expected.length} file(s), but the declared count is ${PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT}`
  );
  assert.deepEqual(
    actual,
    expected,
    `runtime source path list changed; missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)} firstDifferentIndex=${firstDifferentIndex} actual=${JSON.stringify(actual[firstDifferentIndex])} expected=${JSON.stringify(expected[firstDifferentIndex])}`
  );
  const actualBytes = expected.reduce((total, path) => total + statSync(join(repositoryRoot, path)).size, 0);
  assert.ok(actualBytes > 0);
  assert.ok(actualBytes < PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES);
});

test("closure parser binds aliases and every supported runtime module loading form", () => {
  assert.deepEqual(
    runtimeImportSpecifiers(
      "fixture.ts",
      [
        'import type { TypeOnly } from "./type-only";',
        'import { type NamedTypeOnly } from "./named-type-only";',
        'export type { ExportTypeOnly } from "./export-type-only";',
        'import "./side-effect";',
        'import { type MixedType, runtimeValue } from "./mixed";',
        'export { type ExportType, runtimeExport } from "./re-export";',
        'void import("./dynamic");',
        'require("./required");',
        'const load = require; load("./aliased-required");',
        'module.require("./module-required");',
        'import requiredEquals = require("./import-equals");',
        'import { createRequire as makeRequire } from "node:module";',
        'const localRequire = makeRequire(import.meta.url); localRequire("./created-required");',
        'makeRequire(import.meta.url)("./direct-created-required");',
        'import * as ModuleApi from "node:module"; ModuleApi.createRequire(import.meta.url)("./namespace-created-required");',
        'import ModuleDefault from "node:module"; ModuleDefault.createRequire(import.meta.url)("./default-created-required");',
        'import { createRequire as bareMakeRequire } from "module"; bareMakeRequire(import.meta.url)("./bare-created-required");',
        'const ModuleCjs = require("node:module"); ModuleCjs.createRequire(import.meta.url)("./cjs-created-required");',
        'const { createRequire: cjsCreateRequire } = require("node:module"); cjsCreateRequire(import.meta.url)("./destructured-created-required");',
      ].join("\n")
    ),
    [
      "./side-effect",
      "./mixed",
      "./re-export",
      "./dynamic",
      "./required",
      "./aliased-required",
      "./module-required",
      "./import-equals",
      "node:module",
      "./created-required",
      "./direct-created-required",
      "node:module",
      "./namespace-created-required",
      "node:module",
      "./default-created-required",
      "module",
      "./bare-created-required",
      "node:module",
      "./cjs-created-required",
      "node:module",
      "./destructured-created-required",
    ]
  );
  for (const unsafe of [
    "void import(runtimePath);",
    "const load = require; load(runtimePath);",
    "const load = require; consume(load);",
    "const load = module.require; consume(load);",
    'module["require"]("./computed-module-require");',
    'const moduleAlias = module; moduleAlias["require"]("./aliased-computed-module-require");',
    'const moduleAlias = module; moduleAlias.require("./aliased-module-require");',
    'const loaderName = "require"; module[loaderName]("./dynamic-computed-module-require");',
    'import * as ModuleApi from "node:module"; const factoryName = "createRequire"; ModuleApi[factoryName](import.meta.url)("./dynamic-computed-create-require");',
    'import * as ModuleApi from "node:module"; ModuleApi._load("./hidden");',
    'import ModuleDefault from "node:module"; ModuleDefault._load("./hidden");',
    'const ModuleCjs = require("module"); ModuleCjs._load("./hidden");',
    'const { createRequire, Module } = require("node:module"); createRequire(import.meta.url)("./visible"); Module._load("./hidden");',
    'require("node:module").createRequire(import.meta.url)("./hidden-direct-create-require");',
    'require("module")._load("./hidden-direct-module-load", null, false);',
    'module.require("node:module").createRequire(import.meta.url)("./hidden-module-require-create-require");',
    'const builtinLoader = require; builtinLoader("node:module").createRequire(import.meta.url)("./hidden-aliased-builtin-create-require");',
    'void import("node:module");',
    'export { createRequire as make } from "node:module";',
    'export { createRequire as make } from "module";',
    'process.getBuiltinModule("module").createRequire(import.meta.url)("./builtin-created-require");',
    'process["getBuiltinModule"]("module").createRequire(import.meta.url)("./computed-builtin-created-require");',
    'const processAlias = process; processAlias.getBuiltinModule("module").createRequire(import.meta.url)("./aliased-builtin-created-require");',
    'eval("require(\\"./hidden\\")");',
    '(0, eval)("require(\\"./hidden\\")");',
    'const execute = eval; execute("require(\\"./hidden\\")");',
    'Function("return require(\\"./hidden\\")")();',
    'new Function("return require(\\"./hidden\\")")();',
    'globalThis.eval("require(\\"./hidden\\")");',
    'globalThis["Function"]("return require(\\"./hidden\\")")();',
    'global["process"]["getBuiltinModule"]("module").createRequire(import.meta.url)("./hidden-global-process");',
    'global["eval"]("require(\\"./hidden-global-eval\\")");',
    'global["Function"]("return require(\\"./hidden-global-function\\")")();',
    'const nodeGlobal = global; nodeGlobal.eval("require(\\"./hidden-global-alias\\")");',
    'const globalForPrisma = global as unknown as { prisma: unknown }; void globalForPrisma.prisma;',
    'globalThis.__tomverseOperationalState?.constructor.constructor("return require(\\"./hidden\\")")();',
    'const g = globalThis as any; g.__tomverseOperationalState?.loader("./hidden");',
    '({}).constructor.constructor("return require(\\"./hidden\\")")();',
    '({})["con" + "structor"].constructor("return require(\\"./hidden\\")")();',
    'const key = "constructor"; ({} as any)[key][key]("return require(\\"./hidden\\")")();',
    'const key = `con${"structor"}`; ({} as any)[key][key]("return require(\\"./hidden\\")")();',
    'const parts = ["con", "structor"]; ({} as any)[parts.join("")][parts.join("")]("return require(\\"./hidden\\")")();',
    'Reflect.get(module, "require")("./hidden");',
    'process.mainModule.require("./hidden");',
    'Reflect.apply(eval, globalThis, ["require(\\"./hidden\\")"]);',
    'eval.call(globalThis, "require(\\"./hidden\\")");',
    'Function.call(null, "return require(\\"./hidden\\")")();',
    'import { createRequire } from "node:module"; consume(createRequire(import.meta.url));',
  ]) {
    assert.throws(
      () => runtimeImportSpecifiers("fixture.ts", unsafe),
      /non-literal|cannot be resolved safely/,
      unsafe
    );
  }
});

test("installed dependency declarations are external but workspace sources remain local", () => {
  assert.equal(isInstalledDependencyResolution("node_modules/next-auth/next.d.ts"), true);
  assert.equal(isInstalledDependencyResolution("packages/example/node_modules/dependency/index.d.ts"), true);
  assert.equal(isInstalledDependencyResolution("packages/chat-core/src/index.ts"), false);
  assert.equal(resolveLocalRuntimeImport("lib/promptRefinerStageAdmission.ts", "next-auth/next"), null);
  assert.throws(
    () => resolveLocalRuntimeImport("lib/promptRefinerStageAdmission.ts", "@tomverse/not-a-workspace"),
    /unrecognized local workspace import/
  );
});

test("TypeScript options and workspace metadata control local resolution", () => {
  assert.equal(resolveLocalRuntimeImport("lib/promptRefinerStageAdmission.ts", "@/lib/adminAudit"), "lib/adminAudit.ts");
  assert.equal(resolveLocalRuntimeImport("lib/promptRefinerStageAdmission.ts", "@tomverse/chat-core"), "packages/chat-core/src/index.ts");
  assert.equal(resolveLocalRuntimeImport("lib/promptRefinerStageAdmission.ts", "@tomverse/ui-tokens/tokens.css"), "packages/ui-tokens/src/tokens.css");
  assert.throws(
    () => resolveLocalRuntimeImport("lib/promptRefinerStageAdmission.ts", "@tomverse/ui-tokens"),
    /unresolved local workspace import/
  );
  for (const changed of [
    { ...compilerOptions, paths: { ...compilerOptions.paths, "@/*": ["./shadow/*"] } },
    { ...compilerOptions, baseUrl: join(repositoryRoot, "lib") },
    { ...compilerOptions, rootDirs: [repositoryRoot, join(repositoryRoot, "shadow")] },
    { ...compilerOptions, moduleSuffixes: [".native", ""] },
  ]) {
    assert.throws(() => assertResolutionOptions(changed), /resolution-affecting tsconfig options changed/);
  }
});

test("TypeScript and PostgreSQL enforce the identical ordered runtime source paths", () => {
  const legacyMigration = readFileSync(
    join(repositoryRoot, "prisma/migrations/20260918130000_prompt_refiner_stage_admission/migration.sql"),
    "utf8"
  );
  const migration = readFileSync(
    join(repositoryRoot, "prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql"),
    "utf8"
  );
  const block = legacyMigration.match(/expected_paths CONSTANT TEXT\[\] := ARRAY\[([\s\S]*?)\n\s*\];/);
  assert.ok(block, "migration expected_paths block is missing");
  const sqlPaths = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const addedPath = migration.match(
    /'path', '(prisma\/migrations\/20260921100000_prompt_refiner_confirmatory_shadow_v4\/migration\.sql)'/
  );
  assert.ok(addedPath, "v4 migration extension path is missing");
  sqlPaths.splice(6, 0, addedPath[1]);
  assert.equal(sqlPaths.length, PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT);
  assert.deepEqual(sqlPaths, [...PROMPT_REFINER_RUNTIME_SOURCE_PATHS]);
  const executionManifestFileCount = migration.match(
    /"schemaVersion":"prompt-refiner-shadow-execution-manifest-v2"[\s\S]*?"runtimeSource":\{"fileCount":(\d+),/
  );
  assert.ok(executionManifestFileCount, "migration executionManifest runtimeSource.fileCount is missing");
  assert.equal(
    Number(executionManifestFileCount[1]),
    PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT,
    "migration executionManifest runtimeSource.fileCount differs from the TypeScript runtime source contract"
  );
  assert.match(
    migration,
    /"id" = 'prompt-refiner-shadow-v1'[\s\S]*?"runtimeSourceManifest"->>'schemaVersion' = 'prompt-refiner-runtime-source-manifest-v2'[\s\S]*?"id" = 'prompt-refiner-shadow-v2'[\s\S]*?"runtimeSourceManifest"->>'schemaVersion' = 'prompt-refiner-runtime-source-manifest-v3'/,
    "database stage identity must select the matching runtime manifest generation"
  );
});

test("operator-facing contracts name the enforced runtime source closure size", () => {
  const expectedCount = String(PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT);
  const expectedRuntimeSourceCount = String(runtimeImportClosure().length);
  for (const [path, pattern] of [
    ["prisma/schema.prisma", /exact (\d+)-file runtime import closure/],
    ["docs/ops/prompt-refiner-durable-stage-writer-contract.md", /deployment의 (\d+)개 고정 source 파일/],
    ["docs/ops/prompt-refiner-durable-stage-writer-task.md", /(\d+)-file\/16 MiB bounded exact-byte/],
    ["docs/ops/tomverse-chat-progress.md", /confirmatory v2\/v4 현재 계약은 exact (\d+)-file/],
    ["docs/policy/prompt-refiner-durable-stage-writer-threat-model.md", /검증되는 (\d+)개 고정 path allowlist/],
    ["docs/ops/prompt-refiner-confirmatory-shadow-v4.md", /\*\*(\d+)개 고정 source 파일\*\*/],
  ]) {
    const source = readFileSync(join(repositoryRoot, path), "utf8");
    const found = source.match(pattern);
    assert.ok(found, `${path} has no runtime source closure count`);
    assert.equal(found[1], expectedCount, `${path} runtime source closure count drifted`);
  }

  const contract = readFileSync(
    join(repositoryRoot, "docs/ops/prompt-refiner-confirmatory-shadow-v4.md"),
    "utf8"
  );
  assert.match(
    contract,
    new RegExp(`${expectedCount}개 중 ${expectedRuntimeSourceCount}개는 8개 실행 root의 local TypeScript/JavaScript`),
    "runtime TypeScript/JavaScript source-count contract drifted"
  );
  const stageContract = readFileSync(
    join(repositoryRoot, "docs/ops/prompt-refiner-durable-stage-writer-contract.md"),
    "utf8"
  );
  assert.match(
    stageContract,
    new RegExp(`${expectedCount}개 경로의 순서`),
    "database path-count contract drifted"
  );
  assert.match(
    stageContract,
    new RegExp(`${expectedCount}개 중 ${expectedRuntimeSourceCount}개 TypeScript/JavaScript source`),
    "stage writer runtime-source count drifted"
  );
  const observabilityPolicy = readFileSync(
    join(repositoryRoot, "docs/policy/prompt-refiner-observability.md"),
    "utf8"
  );
  const observabilityClosureCounts = observabilityPolicy.match(
    /고정 (\d+)개 source\r?\n파일의 exact bytes\(개별\/총 size와 SHA-256\)를 canonical manifest로 만든다\. (\d+)개 source는/
  );
  assert.ok(observabilityClosureCounts, "observability policy runtime closure paragraph is missing");
  assert.equal(
    observabilityClosureCounts[1],
    expectedCount,
    "observability policy total source count drifted"
  );
  assert.equal(
    observabilityClosureCounts[2],
    expectedRuntimeSourceCount,
    "observability policy runtime-source count drifted"
  );
});
