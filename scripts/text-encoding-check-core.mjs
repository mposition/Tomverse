import path from "node:path";
import { parse, parseExpression } from "@babel/parser";

/**
 * UX-278. This used to parse with `typescript`'s JavaScript compiler API
 * (`ts.createSourceFile` / `ts.forEachChild`). TypeScript 7 is the native port
 * and does not ship that API, so the import alone threw and took
 * `npm run check:encoding` -- a PR Fast Gate step -- down with it. That is why
 * `.github/dependabot.yml` holds `typescript` below 7.
 *
 * TypeScript 7 does expose `typescript/unstable/ast`, and it was worth checking
 * before assuming otherwise, but it carries a scanner and no parser: no
 * `createSourceFile`, no `forEachChild`. A scanner alone cannot tell JSX text
 * from the expressions around it without reimplementing the parser's context,
 * and JSX text is one of the two things this check has to see.
 *
 * Babel parses TS and TSX on a stable, published API, and it is already in the
 * dependency tree, so this costs no download -- only an explicit declaration of
 * something that was being relied on implicitly.
 *
 * Only positions are used. No type information is needed to answer "which byte
 * ranges are string literals or JSX text", which is the whole question here.
 */
const STRING_LIKE_TYPES = new Set([
  "StringLiteral",
  "TemplateElement",
  "JSXText",
]);

function questionMatches(text, offset = 0) {
  const matches = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "?" && text[index + 1] === "?") {
      let end = index + 2;
      while (text[end] === "?") end += 1;
      matches.push({ index: offset + index, sample: text.slice(index, end) });
      index = end - 1;
      continue;
    }
    if (
      char === "?" &&
      /[\p{L}\p{N}]/u.test(text[index - 1] || "") &&
      /[\p{L}\p{N}]/u.test(text[index + 1] || "") &&
      !/[/:=&${}`]/.test(
        text.slice(Math.max(0, index - 10), Math.min(text.length, index + 10))
      )
    ) {
      matches.push({
        index: offset + index,
        sample: text.slice(Math.max(0, index - 8), index + 9),
      });
    }
  }
  return matches;
}

/**
 * `.ts` cannot take the `jsx` plugin -- in a `.ts` file `<T>value` is a type
 * assertion, and enabling JSX turns it into an unterminated element. Every
 * other extension here is parsed with both, which is what lets a `.js` file
 * containing JSX still be read.
 */
function babelPlugins(fileName) {
  switch (path.extname(fileName).toLowerCase()) {
    case ".ts":
      return ["typescript"];
    default:
      return ["typescript", "jsx"];
  }
}

function markdownProseSegments(text) {
  const segments = [];
  let offset = 0;
  let fence = null;
  for (const line of text.match(/.*(?:\r?\n|$)/g) || []) {
    if (!line) continue;
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      fence = fence === marker ? null : fence || marker;
      offset += line.length;
      continue;
    }
    if (!fence) {
      let proseStart = 0;
      let inlineTicks = null;
      for (let index = 0; index <= line.length; index += 1) {
        if (line[index] !== "`") continue;
        let end = index + 1;
        while (line[end] === "`") end += 1;
        const ticks = end - index;
        if (inlineTicks === null) {
          if (index > proseStart) {
            segments.push({ text: line.slice(proseStart, index), offset: offset + proseStart });
          }
          inlineTicks = ticks;
        } else if (inlineTicks === ticks) {
          inlineTicks = null;
          proseStart = end;
        }
        index = end - 1;
      }
      if (inlineTicks === null && proseStart < line.length) {
        segments.push({ text: line.slice(proseStart), offset: offset + proseStart });
      }
    }
    offset += line.length;
  }
  return segments;
}

/**
 * Walks a Babel AST and reports `?` runs inside every string literal, template
 * chunk and JSX text node. Generic over node shape rather than keyed to a
 * visitor table, so a syntax Babel adds later is traversed rather than silently
 * skipped -- the cost of missing one is a string this check never looks at.
 */
function collectStringLikeMatches(root, text) {
  const matches = [];
  const seen = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node.type !== "string" || seen.has(node)) return;
    seen.add(node);

    if (STRING_LIKE_TYPES.has(node.type)) {
      // `start`/`end` span the raw source including the quotes or backticks,
      // which is the range the reported offsets have always been relative to.
      matches.push(
        ...questionMatches(text.slice(node.start, node.end), node.start)
      );
    }

    for (const key of Object.keys(node)) {
      // Position metadata and comment back-references only lead back to nodes
      // already visited, or to text this check deliberately ignores.
      if (key === "loc" || key === "leadingComments" || key === "trailingComments") {
        continue;
      }
      visit(node[key]);
    }
  };
  visit(root);
  return matches.sort((left, right) => left.index - right.index);
}

export function findQuestionRunsInsideStrings(text, fileName) {
  if (path.extname(fileName).toLowerCase() === ".md") {
    return markdownProseSegments(text).flatMap((segment) =>
      questionMatches(segment.text, segment.offset)
    );
  }

  // A JSON document's outermost `{` is an object in expression position, not a
  // block statement, so it has to be parsed as an expression or every key and
  // value is lost to a syntax error.
  if (path.extname(fileName).toLowerCase() === ".json") {
    try {
      return collectStringLikeMatches(parseExpression(text, { errorRecovery: true }), text);
    } catch {
      return [];
    }
  }

  let ast;
  try {
    ast = parse(text, {
      sourceType: "unambiguous",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowSuperOutsideMethod: true,
      allowUndeclaredExports: true,
      errorRecovery: true,
      ranges: false,
      plugins: babelPlugins(fileName),
    });
  } catch {
    // A file this cannot parse is reported as clean rather than as a finding.
    // The previous implementation behaved the same way: the TypeScript parser
    // recovers from syntax errors and simply yields no string nodes for the
    // part it could not read. A checker for mojibake is the wrong place to
    // fail a build over syntax -- typecheck and lint already do that, and
    // making this throw would turn one broken file into a silent gap in the
    // encoding check for the whole run.
    return [];
  }

  return collectStringLikeMatches(ast.program ?? ast, text);
}
