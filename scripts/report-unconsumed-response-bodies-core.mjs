// Finds `fetch()` call sites whose `Response` body may never be consumed.
//
// Why this exists, and what it is allowed to claim.
//
// `/api/*` answers `private, no-store` (lib/apiCacheControlPolicy.ts). What was
// measured alongside that -- on Chromium, against a `next start` build of this
// application at Next 16.3.0 -- is that a response whose body is never consumed
// did not reach `requestfinished`, while the same unconsumed body did under
// `private, no-cache` and `public, max-age=60`. The mechanism is not
// established, and no specification promises either behaviour. So this report
// is not "these are bugs": it is "these are the places where the question can
// be asked at all", and a person answers it.
//
// ## What the classification does and does not do
//
// It walks the syntax and asks one question per call site: does *every* path
// from the response being bound to control leaving its scope pass through a
// read of the body? That is a real reachability walk over statements --
// `if`/`else`, early `return`, `throw`, ternaries -- not a keyword search, so
// `res.ok ? res.json() : discardResponseBody(res)` is recognised as consumed on
// both arms while `res.ok ? res.json() : null` is not.
//
// What it deliberately does not do is decide whether an unread path can
// actually be taken. `if (cancelled) return;` before a read is an unread path
// in the syntax and may be unreachable in practice; only a person knows. Nor
// does it follow a response into another function, across a module, or through
// a promise stored in a variable.
//
//   leaks       at least one path leaves the scope without reading the body.
//               A fact about the source, not a verdict about the program.
//   consumed    every path this can see reads it.
//   escapes     the response leaves the scope -- returned, stored, handed to a
//               function -- so its consumer is somewhere this cannot see.
//               Reported, never judged.
//
// `runtime` splits the browser from the server because the measurement only
// covers the browser. An unconsumed body in a Node route handler has its own
// cost in undici's connection pool; that is a real concern and a different one,
// and nothing here has measured it.

/** Methods that consume a `Response` body. */
const BODY_READERS = new Set([
  "json",
  "text",
  "blob",
  "arrayBuffer",
  "formData",
  "bytes",
]);

/** Helpers in this repository whose whole job is to consume a body. */
const DISCARD_HELPERS = new Set(["discardResponseBody"]);

export const FINDING_KINDS = ["leaks", "consumed", "escapes"];

/** `consumed`: every path reads. `open`: falls through unread. `leak`: exits unread. */
const CONSUMED = "consumed";
const OPEN = "open";
const LEAK = "leak";

const makeAnalyzer = (ts, isTarget) => {
  const isRead = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      BODY_READERS.has(node.expression.name.text) &&
      isTarget(node.expression.expression)
    ) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "body" &&
      isTarget(node.expression)
    ) {
      return true;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      DISCARD_HELPERS.has(node.expression.text) &&
      node.arguments.some((argument) => isTarget(argument))
    ) {
      return true;
    }
    return false;
  };

  /** Does evaluating this expression always read the body? */
  const consumesExpression = (node) => {
    if (!node) return false;
    if (isRead(node)) return true;
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) {
      return consumesExpression(node.expression);
    }
    if (ts.isNonNullExpression(node) || ts.isAsExpression(node)) {
      return consumesExpression(node.expression);
    }
    if (ts.isConditionalExpression(node)) {
      // Both arms, or the condition itself.
      return (
        consumesExpression(node.condition) ||
        (consumesExpression(node.whenTrue) && consumesExpression(node.whenFalse))
      );
    }
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      if (
        kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        kind === ts.SyntaxKind.BarBarToken ||
        kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        // Only the left side is certain to run.
        return consumesExpression(node.left);
      }
      return consumesExpression(node.left) || consumesExpression(node.right);
    }
    if (ts.isCallExpression(node)) {
      // Arguments always evaluate, and so does the callee expression.
      return (
        consumesExpression(node.expression) ||
        node.arguments.some((argument) => consumesExpression(argument))
      );
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return consumesExpression(node.expression);
    }
    if (ts.isObjectLiteralExpression(node)) {
      // Every property initialiser evaluates, so a read in any of them runs.
      // `return { ok: true, body: await response.json() }` is the shape, and
      // missing it reported `components/memory/MemoryReviewSettings.tsx` --
      // which reads on both paths -- as leaking on the successful one.
      return node.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          consumesExpression(property.initializer)
      );
    }
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.some((element) => consumesExpression(element));
    }
    if (ts.isTemplateExpression(node)) {
      return node.templateSpans.some((span) => consumesExpression(span.expression));
    }
    return false;
  };

  /** Merges the two arms of a branch. */
  const merge = (left, right) => {
    if (left === LEAK || right === LEAK) return LEAK;
    if (left === CONSUMED && right === CONSUMED) return CONSUMED;
    return OPEN;
  };

  const analyzeStatement = (statement) => {
    if (!statement) return OPEN;
    if (ts.isBlock(statement)) return analyzeStatements(statement.statements, 0);
    if (ts.isExpressionStatement(statement)) {
      return consumesExpression(statement.expression) ? CONSUMED : OPEN;
    }
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some((declaration) =>
        consumesExpression(declaration.initializer)
      )
        ? CONSUMED
        : OPEN;
    }
    if (ts.isReturnStatement(statement)) {
      return consumesExpression(statement.expression) ? CONSUMED : LEAK;
    }
    if (ts.isThrowStatement(statement)) {
      return consumesExpression(statement.expression) ? CONSUMED : LEAK;
    }
    if (ts.isIfStatement(statement)) {
      if (consumesExpression(statement.expression)) return CONSUMED;
      return merge(
        analyzeStatement(statement.thenStatement),
        statement.elseStatement ? analyzeStatement(statement.elseStatement) : OPEN
      );
    }
    if (ts.isTryStatement(statement)) {
      // The catch is a path the try's read may never have run on, so a read
      // that only appears in the try block does not settle every path. Report
      // the try block's own answer and let the reviewer see the shape.
      return analyzeStatement(statement.tryBlock);
    }
    if (ts.isSwitchStatement(statement)) {
      if (consumesExpression(statement.expression)) return CONSUMED;
      return OPEN;
    }
    if (
      ts.isForStatement(statement) ||
      ts.isForOfStatement(statement) ||
      ts.isForInStatement(statement) ||
      ts.isWhileStatement(statement) ||
      ts.isDoStatement(statement)
    ) {
      // A loop body may run zero times.
      return OPEN;
    }
    if (ts.isLabeledStatement(statement)) return analyzeStatement(statement.statement);
    return OPEN;
  };

  const analyzeStatements = (statements, from) => {
    for (let index = from; index < statements.length; index += 1) {
      const outcome = analyzeStatement(statements[index]);
      if (outcome === CONSUMED) return CONSUMED;
      if (outcome === LEAK) return LEAK;
    }
    return OPEN;
  };

  /** A function body, which is either a block or a single expression. */
  const analyzeBody = (body) => {
    if (!body) return OPEN;
    if (ts.isBlock(body)) return analyzeStatements(body.statements, 0);
    return consumesExpression(body) ? CONSUMED : OPEN;
  };

  return { analyzeStatements, analyzeBody, consumesExpression, isRead };
};

/** Does the response leave the scope by some route this cannot follow? */
const findsEscape = (ts, scope, isTarget) => {
  let escaped = false;
  const visit = (node) => {
    if (escaped) return;
    if (ts.isReturnStatement(node) && node.expression && isTarget(node.expression)) {
      escaped = true;
      return;
    }
    if (
      ts.isCallExpression(node) &&
      !(
        ts.isIdentifier(node.expression) &&
        DISCARD_HELPERS.has(node.expression.text)
      ) &&
      node.arguments.some((argument) => isTarget(argument))
    ) {
      escaped = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);
  return escaped;
};

/**
 * The name an awaited `fetch()` lands in, and the statement that binds it.
 *
 * Three shapes, all of which appear here and all of which are the same
 * question: `const r = await fetch(…)`, `r = await fetch(…)` into a `let`
 * declared earlier, and `let r = cond ? await other() : await fetch(…)`, where
 * the await is one arm of a ternary. Reading only the first was a real cost --
 * `lib/feedbackClient.ts` reads its body on both paths and was reported as
 * dropping it, which is exactly the kind of finding that teaches a reader to
 * stop trusting the list.
 */
const awaitedBinding = (ts, awaitNode) => {
  let child = awaitNode;
  let current = awaitNode.parent;
  while (current) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      // `parent.parent` is the declaration list, and its parent the statement.
      return { name: current.name.text, statement: current.parent.parent };
    }
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(current.left) &&
      current.right === child
    ) {
      return { name: current.left.text, statement: current.parent };
    }
    if (
      ts.isConditionalExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isAwaitExpression(current)
    ) {
      child = current;
      current = current.parent;
      continue;
    }
    return null;
  }
  return null;
};

/**
 * Every statement list between the binding and the function it lives in.
 *
 * Innermost first. One level is not enough: `lib/feedbackClient.ts` assigns
 * inside a `try` and reads after the `try`/`catch`, so a walk that stopped at
 * the inner block would see nothing after the assignment and call a consumed
 * body a leak.
 */
const statementChain = (ts, node) => {
  const chain = [];
  let child = node;
  let current = node.parent;
  while (current) {
    if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isCaseClause(current)) {
      const index = current.statements.indexOf(child);
      if (index >= 0) {
        chain.push({ statements: current.statements, index, scope: current });
        // A function boundary is where the response's life ends for this walk.
        const owner = current.parent;
        if (
          owner &&
          (ts.isFunctionDeclaration(owner) ||
            ts.isFunctionExpression(owner) ||
            ts.isArrowFunction(owner) ||
            ts.isMethodDeclaration(owner) ||
            ts.isSourceFile(current))
        ) {
          break;
        }
      }
    }
    child = current;
    current = current.parent;
  }
  return chain;
};

/** The `.then(...)` handlers chained onto a call, in order. */
const thenHandlers = (ts, call) => {
  const handlers = [];
  let inner = call;
  let current = call.parent;
  while (
    current &&
    ts.isPropertyAccessExpression(current) &&
    current.expression === inner &&
    ts.isCallExpression(current.parent) &&
    current.parent.expression === current
  ) {
    if (current.name.text === "then") handlers.push(current.parent.arguments[0]);
    inner = current.parent;
    current = current.parent.parent;
  }
  return { handlers, tail: inner };
};

/**
 * Classifies every `fetch()` call site in one file.
 *
 * @param {object} ts the TypeScript compiler namespace
 * @param {string} filePath repository-relative, used for the runtime split
 * @param {string} source the file's text
 */
export function classifyFile(ts, filePath, source) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const findings = [];

  const runtime = runtimeFor(filePath, source);
  const record = (call, kind, note) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(call.getStart());
    const target = call.arguments[0];
    findings.push({
      file: filePath,
      line: line + 1,
      kind,
      runtime,
      note,
      request: target ? target.getText().replace(/\s+/g, " ").slice(0, 72) : "",
    });
  };

  const classifyCall = (call) => {
    const { handlers, tail } = thenHandlers(ts, call);

    if (handlers.length > 0) {
      const handler = handlers[0];
      if (handler && ts.isIdentifier(handler) && DISCARD_HELPERS.has(handler.text)) {
        record(call, "consumed", "then(discardResponseBody)");
        return;
      }
      if (
        handler &&
        (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) &&
        handler.parameters.length > 0 &&
        ts.isIdentifier(handler.parameters[0].name)
      ) {
        const name = handler.parameters[0].name.text;
        const isTarget = (candidate) =>
          ts.isIdentifier(candidate) && candidate.text === name;
        const { analyzeBody } = makeAnalyzer(ts, isTarget);
        const outcome = analyzeBody(handler.body);
        if (outcome === CONSUMED) {
          record(call, "consumed", `then((${name}) => …)`);
        } else if (findsEscape(ts, handler.body, isTarget)) {
          record(call, "escapes", `then((${name}) => …) hands the response on`);
        } else {
          record(call, "leaks", `then((${name}) => …)`);
        }
        return;
      }
      record(call, "escapes", "then() handler does not name the response");
      return;
    }

    const awaitNode = ts.isAwaitExpression(call.parent) ? call.parent : null;
    const binding = awaitNode ? awaitedBinding(ts, awaitNode) : null;
    if (binding) {
      const { name, statement } = binding;
      const isTarget = (candidate) =>
        ts.isIdentifier(candidate) && candidate.text === name;
      const chain = statementChain(ts, statement);
      const { analyzeStatements } = makeAnalyzer(ts, isTarget);
      if (chain.length === 0) {
        record(call, "escapes", `${name} = await fetch(…) in an unknown scope`);
        return;
      }
      const context = chain[chain.length - 1];
      let outcome = OPEN;
      for (const level of chain) {
        outcome = analyzeStatements(level.statements, level.index + 1);
        if (outcome !== OPEN) break;
      }
      if (outcome === CONSUMED) {
        record(call, "consumed", `${name} = await fetch(…)`);
      } else if (findsEscape(ts, context.scope, isTarget)) {
        record(call, "escapes", `${name} = await fetch(…) hands the response on`);
      } else {
        record(
          call,
          "leaks",
          outcome === LEAK
            ? `${name} = await fetch(…); a path returns or throws unread`
            : `${name} = await fetch(…); control falls through unread`
        );
      }
      return;
    }
    if (awaitNode) {
      record(call, "leaks", "await fetch(…) with the response dropped");
      return;
    }
    // The promise's value is either dropped on the spot or it goes somewhere.
    // `void fetch(...)` and a bare expression statement drop it, and nothing
    // will ever read that body. Anything else -- stored in a variable, put in a
    // `Promise.all` array, returned from an arrow, chosen by a ternary -- hands
    // it to a consumer this walk cannot follow, and guessing there is how a
    // report starts naming call sites that are perfectly fine.
    const dropped =
      ts.isExpressionStatement(tail.parent) ||
      (ts.isVoidExpression(tail.parent) &&
        ts.isExpressionStatement(tail.parent.parent));
    if (!dropped) {
      record(call, "escapes", "the promise is stored, returned or passed on");
      return;
    }
    record(call, "leaks", "fetch(…) with no handler and no binding");
  };

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "fetch") ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "fetch"))
    ) {
      classifyCall(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

/**
 * Where the code runs, as far as this can tell.
 *
 * `lib/` is the reason this takes the source and not only the path. It holds
 * both halves -- `lib/perplexityDeepResearch.ts` is a server module and
 * `lib/useBuildInfo.ts` is a React hook -- and calling the whole directory
 * "server" would file browser findings under a runtime the measurement does not
 * cover. Only two signals are trusted: importing `server-only` (server for
 * certain) and a `"use client"` directive (browser for certain). Everything
 * else falls back to the directory, and `lib/` with neither signal is reported
 * as `either` rather than guessed at.
 */
export function runtimeFor(filePath, source = "") {
  if (filePath.startsWith("app/api/")) return "server";
  if (filePath.startsWith("scripts/")) return "server";
  if (filePath.startsWith("tests/")) return "test";
  if (/^\s*(import\s+["']server-only["']|import\s+["']server-only["'];)/m.test(source)) {
    return "server";
  }
  if (/^\s*["']use client["']/m.test(source)) return "browser";
  if (
    filePath.startsWith("components/") ||
    filePath.startsWith("hooks/") ||
    filePath.startsWith("packages/")
  ) {
    return "browser";
  }
  if (filePath.startsWith("lib/")) return "either";
  if (filePath.startsWith("app/")) return "browser";
  return "unknown";
}

/**
 * What the request is aimed at, which decides whether the measurement is even
 * about it.
 *
 * Only a same-origin `/api/*` route that takes the proxy's default gets
 * `private, no-store`. The five routes that choose their own caching do not,
 * and neither does anything cross-origin -- an R2 upload, Sentry, a provider
 * API. Those still hold a body open in whatever runtime issued them, which is a
 * separate question from the one that was measured.
 *
 * @param requestText the first argument's source text, as written
 * @param exceptionPaths pathnames from API_ROUTES_CHOOSING_THEIR_OWN_CACHING
 */
export function classifyRequestTarget(requestText, exceptionPaths = []) {
  const text = requestText ?? "";
  if (/^["'`]https?:\/\//.test(text)) return "cross_origin";
  const literal = text.match(/^["'`](\/[^"'`?]*)/)?.[1];
  if (!literal) return "unresolved";
  const pathname = literal.replace(/\/$/, "") || "/";
  if (exceptionPaths.includes(pathname)) return "api_own_caching";
  return literal.startsWith("/api/") ? "api_default_no_store" : "same_origin_other";
}

export function summarise(findings) {
  const byKind = new Map();
  const byRuntime = new Map();
  for (const finding of findings) {
    byKind.set(finding.kind, (byKind.get(finding.kind) ?? 0) + 1);
    const runtime = finding.runtime ?? runtimeFor(finding.file);
    const bucket = byRuntime.get(runtime) ?? new Map();
    bucket.set(finding.kind, (bucket.get(finding.kind) ?? 0) + 1);
    byRuntime.set(runtime, bucket);
  }
  return { total: findings.length, byKind, byRuntime };
}
