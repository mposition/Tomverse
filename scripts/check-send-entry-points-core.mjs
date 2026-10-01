import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, posix, relative, sep } from "node:path";

import ts from "typescript";

/**
 * Who may put a message on the wire.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.4 (C41),
 * docs/policy/email-notifications.md section 9.8.
 *
 * Every customer-facing send goes through `sendWithAddressLock()`, which takes
 * the address lock, asks suppression again inside it and submits in the same
 * scope. A send made anywhere else skips all three, and the failure is silent:
 * the message goes out, the recipient is somebody who had withdrawn, and the
 * record says the check was made.
 *
 * So the rule is a file allowlist over the ways to reach the provider, and the
 * reason each entry is on it is written down beside it.
 *
 * ## Why this is per file, and why that shaped the code
 *
 * A file-level check cannot tell a submission made inside the lock from one
 * made beside it. That is not a weakness to work around -- it is what forced
 * two decisions:
 *
 *  - the lanes hand `sendWithAddressLock()` a *message* rather than a callback,
 *    so they never import an entry point at all;
 *  - the notification queue's operator alerts live in their own module, because
 *    a queue file carrying both kinds could not be allowlisted without also
 *    allowing a customer send in the same file to skip the lock. That module
 *    decides its own recipient, so being on this list does not make it a way to
 *    send anywhere.
 *
 * ## Why this parses rather than greps
 *
 * The first version matched `import { name } from "…/lib/email"` with a regular
 * expression, and an independent review listed what walked past it: a
 * re-export, a namespace import, a dynamic `await import()`, and
 * `const p = emailProvider(); p.send(…)`. Each of those is a send, and each
 * would have been green. It is a syntax question, so it is answered with the
 * syntax tree.
 */

/** The module that owns the two send functions. */
const EMAIL_MODULE = /(^|\/)lib\/email$/;

/** The three ways a message reaches the provider. */
export const SEND_ENTRY_POINTS = [
  "deliverEmailOnce",
  "sendTransactionalEmail",
  "emailProvider().send",
];

/**
 * Where production source lives, defined once.
 *
 * The first version scanned `app/` and `lib/` for `.ts` and `.tsx`, which left
 * `.mjs`, the repository root and anything else outside those two directories
 * unscanned -- and a second copy of the same scope in a test that checked the
 * same rule. Both read this now.
 */
export const SEND_SCAN = {
  roots: ["app", "components", "lib", "packages", "scripts"],
  /** Files at the repository root are scanned too; directories are not. */
  extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"],
  skipDirectories: ["node_modules", ".next", ".git", "__tests__", "coverage"],
  /** A test is not a sender, and neither is this check. */
  skipFile: (path) =>
    /\.test\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)tests\//.test(path) ||
    /(^|\/)check-send-entry-points(-core)?\.mjs$/.test(path),
};

/**
 * The files allowed to use one, and why each is allowed.
 *
 * Adding an entry is a decision about who may bypass the address lock, so the
 * reason is required and is read by a person, not by this script.
 */
export const SEND_ALLOWLIST = {
  "lib/email.ts":
    "Defines the two entry points. The only place that calls emailProvider().send for them.",
  "lib/emailSendLock.ts":
    "The helper itself: the lock, the suppression re-check and the submission in one scope.",
  "lib/operationalMonitoring.ts":
    "Operator alerts about this system, to our own mailboxes. No customer address is involved.",
  "lib/providerMonitoring.ts":
    "The provider probe. It exists to find out whether sending works at all.",
  "lib/operatorNotificationSend.ts":
    "The notification queue's operator alerts. It resolves the operator address itself and refuses any other, so being here is not a way to send anywhere.",
  "app/api/admin/test-email/route.ts":
    "The administrator's own diagnostic, to their own address. Suppression here would report a blocked mailbox as a broken configuration (section 7.4, C35).",
};

const namesFromImportClause = (clause) => {
  const names = [];
  if (!clause) return names;
  // `import mail from "…"` and `import * as mail from "…"` both hand the whole
  // module over, so every export is reachable through them.
  if (clause.name) names.push("*");
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) names.push("*");
    else {
      for (const element of clause.namedBindings.elements) {
        names.push((element.propertyName ?? element.name).text);
      }
    }
  }
  return names;
};

/**
 * What a file uses to reach the provider, by parsing it.
 *
 * Returns the entry-point names, plus `"lib/email (whole module)"` when a file
 * takes the module itself -- a namespace import or a `export * from` carries
 * both functions whatever it does with them afterwards.
 */
export const sendEntryPointUses = (source, path = "file.ts") => {
  const used = new Set();
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);

  /** Variables that hold the provider port, so `p.send()` is found too. */
  const providerHolders = new Set();

  const moduleIsEmail = (specifier) => {
    if (!specifier || !ts.isStringLiteral(specifier)) return false;
    const importer = path.replaceAll("\\", "/");
    const named = specifier.text.replaceAll("\\", "/");
    const withoutAlias = named.replace(/^@\//, "");
    const resolved = withoutAlias.startsWith(".")
      ? posix.normalize(posix.join(posix.dirname(importer), withoutAlias))
      : posix.normalize(withoutAlias);
    const withoutExtension = resolved.replace(/\.[cm]?[jt]sx?$/, "");
    return EMAIL_MODULE.test(withoutExtension);
  };

  const noteNames = (names) => {
    for (const name of names) {
      if (name === "*") used.add("lib/email (whole module)");
      else if (SEND_ENTRY_POINTS.includes(name)) used.add(name);
    }
  };

  const visit = (node) => {
    // import … from "…/lib/email"
    if (ts.isImportDeclaration(node) && moduleIsEmail(node.moduleSpecifier)) {
      // `import type { … }` erases at build time and sends nothing.
      if (!node.importClause?.isTypeOnly) {
        noteNames(namesFromImportClause(node.importClause));
      }
    }

    // export { … } from "…/lib/email", and `export * from`
    if (ts.isExportDeclaration(node) && moduleIsEmail(node.moduleSpecifier)) {
      if (!node.isTypeOnly) {
        if (!node.exportClause) used.add("lib/email (whole module)");
        else if (ts.isNamespaceExport(node.exportClause)) {
          used.add("lib/email (whole module)");
        } else {
          noteNames(
            node.exportClause.elements.map(
              (element) => (element.propertyName ?? element.name).text
            )
          );
        }
      }
    }

    if (ts.isCallExpression(node)) {
      // await import("…/lib/email")
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (moduleIsEmail(node.arguments[0])) used.add("lib/email (whole module)");
      }

      // emailProvider().send(…), and the same through a variable.
      if (ts.isPropertyAccessExpression(node.expression)) {
        const target = node.expression.expression;
        const method = node.expression.name.text;
        const isProviderCall =
          ts.isCallExpression(target) &&
          ts.isIdentifier(target.expression) &&
          target.expression.text === "emailProvider";
        const isProviderHolder =
          ts.isIdentifier(target) && providerHolders.has(target.text);
        if (method === "send" && (isProviderCall || isProviderHolder)) {
          used.add("emailProvider().send");
        }
      }
    }

    // const provider = emailProvider()
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "emailProvider"
    ) {
      providerHolders.add(node.name.text);
    }

    ts.forEachChild(node, visit);
  };

  // Two passes: a variable may be declared after the call that uses it in
  // source order only in pathological code, but the cost of being sure is one
  // more walk.
  visit(tree);
  visit(tree);

  return [...used];
};

/**
 * Files that reach the provider without being allowed to.
 *
 * `path` is repository-relative with forward slashes, so the answer does not
 * depend on which operating system ran the check.
 */
export const sendEntryPointViolations = (files) =>
  files
    .map((file) => ({
      path: file.path,
      uses: sendEntryPointUses(file.source, file.path),
    }))
    .filter((file) => file.uses.length > 0)
    .filter((file) => !Object.hasOwn(SEND_ALLOWLIST, file.path));

/**
 * Allowlist entries that no longer use an entry point.
 *
 * Reported, not failed: a file may lose its send while the decision that put it
 * on the list still stands. But a list nobody prunes stops describing anything,
 * and the next reader cannot tell which entries are load-bearing.
 */
export const staleAllowlistEntries = (files) => {
  const using = new Set(
    files
      .filter((file) => sendEntryPointUses(file.source, file.path).length > 0)
      .map((file) => file.path)
  );
  return Object.keys(SEND_ALLOWLIST).filter((path) => !using.has(path));
};

/**
 * Every production source file, by the one definition of what that means.
 *
 * Here rather than in the script so the gate and the test that asserts the same
 * rule cannot disagree about what "production source" is. They did: the gate
 * walked two directories and the test asked git for a third set
 * (independent review, 2026-09-18).
 */
export const productionSourceFiles = (root) => {
  const found = [];
  const take = (full) => {
    const path = relative(root, full).split(sep).join("/");
    if (!SEND_SCAN.extensions.includes(extname(path))) return;
    if (SEND_SCAN.skipFile(path)) return;
    found.push({ path, source: readFileSync(full, "utf8") });
  };

  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      if (SEND_SCAN.skipDirectories.includes(entry)) continue;
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) walk(full);
      else take(full);
    }
  };

  for (const name of SEND_SCAN.roots) {
    const directory = join(root, name);
    try {
      if (statSync(directory).isDirectory()) walk(directory);
    } catch {
      // A root this repository does not have. Not an error: the same list is
      // read by a test running against the same tree.
    }
  }
  // The repository root itself, files only.
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (!statSync(full).isDirectory()) take(full);
  }
  return found;
};
