import path from "node:path";
import ts from "typescript";

const STRING_LIKE_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.JsxText,
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

function scriptKind(fileName) {
  switch (path.extname(fileName).toLowerCase()) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    case ".json":
      return ts.ScriptKind.JSON;
    default:
      return ts.ScriptKind.TS;
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

export function findQuestionRunsInsideStrings(text, fileName) {
  if (path.extname(fileName).toLowerCase() === ".md") {
    return markdownProseSegments(text).flatMap((segment) =>
      questionMatches(segment.text, segment.offset)
    );
  }

  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName)
  );
  const matches = [];
  const visit = (node) => {
    if (STRING_LIKE_KINDS.has(node.kind)) {
      const start = node.getStart(sourceFile);
      matches.push(...questionMatches(text.slice(start, node.end), start));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches;
}
