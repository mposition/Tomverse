import path from "node:path";

// Finds runs of `?` that are almost certainly mojibake -- text that lost its
// encoding in a round-trip -- while ignoring the many legitimate `?` in source
// code. Precision comes from knowing which byte ranges are string literals,
// template text and JSX text; `??` in code is nullish coalescing, and a `?` in
// a comment, an identifier or a URL is not corruption either.
//
// This used to ask the TypeScript compiler for that answer via
// `ts.createSourceFile`. TypeScript 7 is the native port and no longer ships
// the JavaScript compiler API (#278), which made a dependency on it a standing
// block on the toolchain -- so the ranges are found by scanning here instead.
//
// A scanner, not a parser: it never builds a tree, resolves a type or cares
// what the code means. It only has to know where a token starts and ends, which
// is the whole question being asked. The one genuinely ambiguous case in the
// grammar -- whether `<` opens a JSX element, `/` opens a regular expression --
// is decided the way every lexer decides it, from whether the previous
// significant token can be the left side of a binary operator.

// Deliberately generous: an identifier only has to be told apart from
// punctuation here, so accepting any non-ASCII letter costs nothing and
// avoids splitting an identifier the scanner would then misread.
const IDENT_START = /[A-Za-z_$\u00AA-\uFFFF]/;
const IDENT_PART = /[A-Za-z0-9_$\u00AA-\uFFFF]/;

// Keywords after which a `/` starts a regular expression rather than dividing,
// and a `<` starts JSX rather than comparing. Everything else that ends a value
// -- an identifier, a literal, `)`, `]` -- means the opposite.
const OPERATOR_KEYWORDS = new Set([
  "await",
  "case",
  "default",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
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

// `.ts` has no JSX: there `<T>expr` is a type assertion, and reading it as an
// element would swallow real code. Everything else the checker walks is parsed
// in the JSX variant, matching how the compiler treats these extensions.
function allowsJsx(fileName) {
  switch (path.extname(fileName).toLowerCase()) {
    case ".tsx":
    case ".jsx":
    case ".js":
    case ".mjs":
    case ".cjs":
      return true;
    default:
      return false;
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
 * Every string-literal, template-text and JSX-text range in a source file, as
 * `{ start, end }` offsets. Ranges include their delimiters, the way the
 * compiler's own token positions did, so a `?` next to a quote keeps the same
 * neighbours it always had.
 *
 * Exported for the tests: the ranges are the contract this file has to get
 * right, and asserting on them directly says more than asserting on the
 * findings they happen to produce today.
 */
export function stringLikeRanges(text, fileName) {
  const jsx = allowsJsx(fileName);
  const ranges = [];
  // What the scanner is reading right now. "code" is ordinary source; "jsxTag"
  // is between `<` and the matching `>`, where quotes are attribute values;
  // "jsxChildren" is between an opening and a closing tag, where everything up
  // to the next `<` or `{` is text.
  const modes = [{ kind: "code", braceDepth: 0, template: false }];
  const mode = () => modes[modes.length - 1];
  // Whether the previous significant token can end a value. It decides `/`
  // (regex vs division) and `<` (JSX vs comparison) and nothing else.
  let prevEndsValue = false;
  let index = 0;

  const readIdentifier = () => {
    const start = index;
    index += 1;
    while (index < text.length && IDENT_PART.test(text[index])) index += 1;
    return text.slice(start, index);
  };

  const readString = (quote) => {
    const start = index;
    index += 1;
    while (index < text.length) {
      const char = text[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      index += 1;
      if (char === quote) break;
      // An unterminated string ends at the newline rather than eating the rest
      // of the file: a scanner that loses its place reports nonsense far away
      // from the actual problem.
      if (char === "\n") break;
    }
    ranges.push({ start, end: index });
  };

  // Reads from a backtick or from the `}` that closes a substitution, up to
  // and including whichever of `${` or the closing backtick comes first.
  const readTemplatePart = () => {
    const start = index;
    index += 1;
    while (index < text.length) {
      const char = text[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "`") {
        index += 1;
        ranges.push({ start, end: index });
        return "end";
      }
      if (char === "$" && text[index + 1] === "{") {
        index += 2;
        ranges.push({ start, end: index });
        return "substitution";
      }
      index += 1;
    }
    ranges.push({ start, end: index });
    return "end";
  };

  const readRegex = () => {
    index += 1;
    let inClass = false;
    while (index < text.length) {
      const char = text[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "\n") break;
      index += 1;
      if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      else if (char === "/" && !inClass) break;
    }
    while (index < text.length && IDENT_PART.test(text[index])) index += 1;
  };

  const skipComment = () => {
    if (text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      return true;
    }
    if (text[index + 1] === "*") {
      index += 2;
      while (index < text.length) {
        if (text[index] === "*" && text[index + 1] === "/") {
          index += 2;
          return true;
        }
        index += 1;
      }
      return true;
    }
    return false;
  };

  // `<` opens an element only where a value may begin and where a tag name,
  // a fragment `>` or a closing `/` follows. `a < b` and `Array<string>` both
  // fail one of those and stay operators.
  const startsJsxElement = () => {
    if (!jsx || prevEndsValue) return false;
    const next = text[index + 1];
    return next === ">" || (next !== undefined && IDENT_START.test(next));
  };

  while (index < text.length) {
    const current = mode();

    if (current.kind === "jsxChildren") {
      const start = index;
      while (
        index < text.length &&
        text[index] !== "<" &&
        text[index] !== "{"
      ) {
        index += 1;
      }
      if (index > start) ranges.push({ start, end: index });
      if (index >= text.length) break;
      if (text[index] === "{") {
        index += 1;
        modes.push({ kind: "code", braceDepth: 0, template: false });
        prevEndsValue = false;
        continue;
      }
      if (text[index + 1] === "/") {
        // Closing tag: consume it and leave this element's children.
        index += 2;
        while (index < text.length && text[index] !== ">") index += 1;
        index += 1;
        modes.pop();
        prevEndsValue = true;
        continue;
      }
      index += 1;
      modes.push({ kind: "jsxTag" });
      continue;
    }

    if (current.kind === "jsxTag") {
      const char = text[index];
      if (char === '"' || char === "'") {
        readString(char);
        continue;
      }
      if (char === "{") {
        index += 1;
        modes.push({ kind: "code", braceDepth: 0, template: false });
        prevEndsValue = false;
        continue;
      }
      if (char === "/" && text[index + 1] === ">") {
        index += 2;
        modes.pop();
        prevEndsValue = true;
        continue;
      }
      if (char === ">") {
        index += 1;
        modes.pop();
        modes.push({ kind: "jsxChildren" });
        continue;
      }
      if (char === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) {
        skipComment();
        continue;
      }
      index += 1;
      continue;
    }

    const char = text[index];

    // Whitespace is not a token: letting it clear `prevEndsValue` would make
    // `bytes / (1024 * 1024)` look like the start of a regular expression and
    // swallow everything up to the next `/`.
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }

    if (char === "/") {
      if (skipComment()) continue;
      if (!prevEndsValue) {
        readRegex();
        prevEndsValue = true;
        continue;
      }
      index += 1;
      prevEndsValue = false;
      continue;
    }

    if (char === '"' || char === "'") {
      readString(char);
      prevEndsValue = true;
      continue;
    }

    if (char === "`") {
      if (readTemplatePart() === "substitution") {
        // The substitution's own `}` is consumed by the mode pushed here, so
        // the enclosing brace depth must not also count it.
        modes.push({ kind: "code", braceDepth: 0, template: true });
        prevEndsValue = false;
      } else {
        prevEndsValue = true;
      }
      continue;
    }

    if (char === "{") {
      current.braceDepth += 1;
      index += 1;
      prevEndsValue = false;
      continue;
    }

    if (char === "}") {
      if (current.braceDepth === 0 && modes.length > 1) {
        // Closes whatever opened this nested code region: a `${}` substitution
        // resumes the template it interrupted, a JSX expression container
        // resumes the element.
        modes.pop();
        if (current.template) {
          if (readTemplatePart() === "substitution") {
            modes.push({ kind: "code", braceDepth: 0, template: true });
            prevEndsValue = false;
          } else {
            prevEndsValue = true;
          }
        } else {
          index += 1;
          prevEndsValue = true;
        }
        continue;
      }
      if (current.braceDepth > 0) current.braceDepth -= 1;
      index += 1;
      prevEndsValue = false;
      continue;
    }

    if (char === "<" && startsJsxElement()) {
      index += 1;
      modes.push({ kind: "jsxTag" });
      continue;
    }

    if (IDENT_START.test(char)) {
      const word = readIdentifier();
      prevEndsValue = !OPERATOR_KEYWORDS.has(word);
      continue;
    }

    if (char >= "0" && char <= "9") {
      index += 1;
      while (index < text.length && /[0-9a-zA-Z._]/.test(text[index])) index += 1;
      prevEndsValue = true;
      continue;
    }

    index += 1;
    prevEndsValue = char === ")" || char === "]";
  }

  return ranges;
}

export function findQuestionRunsInsideStrings(text, fileName) {
  if (path.extname(fileName).toLowerCase() === ".md") {
    return markdownProseSegments(text).flatMap((segment) =>
      questionMatches(segment.text, segment.offset)
    );
  }

  return stringLikeRanges(text, fileName).flatMap((range) =>
    questionMatches(text.slice(range.start, range.end), range.start)
  );
}
