// Finds object keys that appear more than once in a JSON document.
//
// JSON allows a repeated key syntactically, and every reader keeps exactly one
// of them -- `JSON.parse` keeps the last. So a duplicate is invisible: the file
// is valid, the tooling is happy, and one of the two entries simply does not
// exist as far as anything that reads the parsed object is concerned. It
// surfaces only when something parses and re-serialises the file, at which
// point the other entry is dropped from the bytes too. That is how the
// duplicate `report:provider-data-destinations` in this repository's
// package.json was found.
//
// The dangerous case is the one where the two values DIFFER: the file says one
// thing and every reader does the other. That cannot be detected by comparing
// values, because by the time a parser has an object the loser is already gone.
// It has to be caught in the raw text, before parsing -- which is what this
// does.
//
// A line-based regex would be the obvious shortcut and is wrong: a string value
// containing `":` ( `"note": "see \"x\": here"` ) reads as a key to it, and a
// key written on the same line as another is invisible to it. So this walks the
// document the way a parser does, tracking only what it needs -- where objects
// begin and end, and which keys each one has seen.

/**
 * @typedef {object} DuplicateKey
 * @property {string} path  JSON path of the owning object, e.g. `scripts`.
 * @property {string} key   The repeated key.
 * @property {number[]} lines 1-based line numbers, in document order.
 */

/** Characters JSON treats as insignificant between tokens. */
const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/**
 * Scans a JSON document for duplicate object keys.
 *
 * Returns every repeated key with the lines it was declared on. The scan is
 * lenient about anything it does not need to understand -- numbers, booleans,
 * `null` and malformed trailing content are skipped as opaque runs of
 * characters -- because the question here is only "which keys did each object
 * declare". Validity is `JSON.parse`'s job and the caller's to ask separately.
 *
 * @param {string} source Raw JSON text.
 * @returns {DuplicateKey[]} Duplicates in document order, innermost first.
 */
export function duplicateJsonKeys(source) {
  /** @type {DuplicateKey[]} */
  const duplicates = [];

  let index = 0;
  let line = 1;

  /** Advances one character, keeping the line counter honest. */
  const advance = () => {
    if (source[index] === "\n") line += 1;
    index += 1;
  };

  const skipWhitespace = () => {
    while (index < source.length && WHITESPACE.has(source[index])) advance();
  };

  /**
   * Reads a JSON string starting at the opening quote and returns its decoded
   * value. Only `\\` and `\"` need real handling: any other escape cannot end
   * the string early, and the exact character it denotes does not change
   * whether two keys are the same -- except `\u`, which can spell a character
   * another key writes literally. `JSON.parse` resolves that for us.
   */
  const readString = () => {
    const start = index;
    advance(); // opening quote
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") {
        advance();
        advance();
        continue;
      }
      advance();
      if (char === '"') break;
    }
    const raw = source.slice(start, index);
    try {
      return JSON.parse(raw);
    } catch {
      // An unterminated or otherwise malformed string. Compare the raw bytes
      // rather than giving up -- a duplicate is still a duplicate, and the
      // parse error will be reported by the caller's own JSON.parse.
      return raw;
    }
  };

  /**
   * Skips any value. Objects and arrays recurse so that nested objects are
   * checked too; everything else is consumed as an opaque run.
   *
   * @param {string} path JSON path of this value, for reporting.
   */
  const readValue = (path) => {
    skipWhitespace();
    const char = source[index];
    if (char === "{") return readObject(path);
    if (char === "[") return readArray(path);
    if (char === '"') return void readString();
    // A primitive: consume until something that can only be structural.
    while (
      index < source.length &&
      !WHITESPACE.has(source[index]) &&
      ![",", "}", "]"].includes(source[index])
    ) {
      advance();
    }
  };

  /** @param {string} path */
  const readArray = (path) => {
    advance(); // `[`
    for (let element = 0; index < source.length; element += 1) {
      skipWhitespace();
      if (source[index] === "]") {
        advance();
        return;
      }
      if (source[index] === ",") {
        advance();
        element -= 1;
        continue;
      }
      readValue(`${path}[${element}]`);
    }
  };

  /** @param {string} path */
  const readObject = (path) => {
    advance(); // `{`
    /** @type {Map<string, number[]>} */
    const seen = new Map();

    while (index < source.length) {
      skipWhitespace();
      if (source[index] === "}") {
        advance();
        break;
      }
      if (source[index] === ",") {
        advance();
        continue;
      }
      if (source[index] !== '"') {
        // Not a key. Malformed input; step over it rather than looping.
        advance();
        continue;
      }

      const keyLine = line;
      const key = readString();
      const lines = seen.get(key);
      if (lines) lines.push(keyLine);
      else seen.set(key, [keyLine]);

      skipWhitespace();
      if (source[index] === ":") advance();
      readValue(path ? `${path}.${key}` : key);
    }

    // Reported after the object closes, so nested objects are listed before
    // the object that contains them -- the innermost duplicate first, which is
    // the one a reader needs to look at.
    for (const [key, lines] of seen) {
      if (lines.length > 1) duplicates.push({ path, key, lines });
    }
  };

  skipWhitespace();
  readValue("");
  return duplicates;
}

/**
 * Formats one duplicate as a single reviewable line.
 *
 * @param {string} file Repository-relative path, for the message.
 * @param {DuplicateKey} duplicate
 * @returns {string}
 */
export function describeDuplicate(file, duplicate) {
  const location = duplicate.path ? `${duplicate.path}.` : "";
  return (
    `${file}: "${location}${duplicate.key}" is declared ` +
    `${duplicate.lines.length} times, on lines ${duplicate.lines.join(", ")}. ` +
    "Every reader keeps one of them."
  );
}
