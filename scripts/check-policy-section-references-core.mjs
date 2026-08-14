// The classification behind `check:policy-section-references`, as pure
// functions so it can be tested without a repository.
//
// The script owns which files are read and which are excluded; everything
// about *what a citation means* is here.

/** `§14`, `§9.1`, `§5.2.2.5`. */
export const CITATION = /§(\d+(?:\.\d+)*)/g;

const POLICY_PATH = /docs\/policy\/([A-Za-z0-9._-]+\.md)/g;

/**
 * A policy path followed by the sections it introduces, as in
 * `docs/policy/external-conversation-import-and-memory.md §14, §9.1`.
 *
 * This is the form that binds a number to a document, and the only one a
 * reader can follow without already knowing which document the file is about.
 */
const EXPLICIT =
  /docs\/policy\/([A-Za-z0-9._-]+\.md)((?:[\s,]*(?:and\s+)?§\d+(?:\.\d+)*)+)/;

/** A markdown file that is not a policy document owns its own numbering. */
const FOREIGN_DOCUMENT = /\b[A-Za-z0-9._/-]+\.md\b/;

/**
 * The sections a markdown document has.
 *
 * `## 14. Assistant Profile` and `### 9.1 Prompt boundary` are both in use, so
 * the trailing dot is optional.
 */
export const sectionsFromMarkdown = (text) => {
  const found = new Set();
  for (const line of text.split("\n")) {
    const heading = /^#+\s+(\d+(?:\.\d+)*)[.\s]/.exec(line);
    if (heading) found.add(heading[1]);
  }
  return found;
};

/** Which policy documents a file names anywhere in its text. */
export const policyDocumentsNamedIn = (source, known) => [
  ...new Set(
    [...source.matchAll(POLICY_PATH)]
      .map((match) => `docs/policy/${match[1]}`)
      .filter((path) => known.has(path))
  ),
];

/**
 * Classify every citation in one file.
 *
 * Four outcomes, and only the first two are ever failures:
 *
 *   * `missing` — an explicit citation of a section its document does not
 *     have, or a bare citation of a section **no** policy document has. Wrong
 *     however the file is written.
 *   * `unscoped` — a bare citation the file gives no document to resolve
 *     against. Legible to someone who knows the file; not to anyone else.
 *   * `ambiguous` — a bare citation that could mean two of the documents the
 *     file names.
 *   * `valid` — resolved.
 */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|\/\/\/|#|--)/;

/**
 * The policy documents in scope at each line.
 *
 * A comment block that names a document scopes the bare citations inside it,
 * which is how these files are already written: a header block says which
 * policy it implements and the paragraphs under it say `§14`. A `prisma`
 * model's own `///` block does the same for that model, which matters in a
 * schema covering several policies at once.
 *
 * Falls back to the whole file, so a file with one policy and no block
 * structure still resolves.
 */
const scopeByLine = (source, known) => {
  const lines = source.split("\n");
  const fileScope = policyDocumentsNamedIn(source, known);
  const scopes = new Array(lines.length).fill(null);
  let block = [];
  let inComment = false;

  lines.forEach((line, index) => {
    const isComment = COMMENT_LINE.test(line);
    if (isComment) {
      if (!inComment) block = [];
      inComment = true;
      for (const path of policyDocumentsNamedIn(line, known)) {
        if (!block.includes(path)) block.push(path);
      }
    } else if (line.trim() === "") {
      // A blank line inside a `/** ... */` run does not end it; a blank line
      // between two `//` runs does. Treating both as continuations keeps a
      // header block whole, which is the case that matters.
    } else {
      inComment = false;
      block = [];
    }
    scopes[index] = block.length > 0 ? block : fileScope;
  });
  return scopes;
};

export const classifyFile = ({
  file,
  source,
  sections,
  ownSections = new Set(),
  exempt = new Set(),
  isStandardsLine = (line) => /\bRFCs?\b/i.test(line),
}) => {
  const known = new Set(sections.keys());
  const scopes = scopeByLine(source, known);
  const result = { valid: 0, missing: [], unscoped: [], ambiguous: [] };

  source.split("\n").forEach((line, index) => {
    if (!line.includes("§")) return;
    if (isStandardsLine(line)) return;
    const at = `${file}:${index + 1}`;

    const explicit = EXPLICIT.exec(line);
    if (explicit) {
      const document = `docs/policy/${explicit[1]}`;
      for (const match of explicit[2].matchAll(CITATION)) {
        if (!known.has(document)) {
          result.missing.push(
            `${at}  cites §${match[1]} of ${explicit[1]}, which is not a policy document`
          );
        } else if (!sections.get(document).has(match[1])) {
          result.missing.push(
            `${at}  §${match[1]} does not exist in ${explicit[1]}`
          );
        } else {
          result.valid += 1;
        }
      }
      return;
    }

    // Some other document is named on this line, and it owns its numbering.
    if (FOREIGN_DOCUMENT.test(line.replace(POLICY_PATH, ""))) return;

    for (const match of line.matchAll(CITATION)) {
      const number = match[1];
      if (exempt.has(number)) continue;
      // A document citing its own section.
      if (ownSections.has(number)) continue;

      const anywhere = [...known].some((path) => sections.get(path).has(number));
      if (!anywhere) {
        result.missing.push(`${at}  §${number} exists in no policy document`);
        continue;
      }
      const named = scopes[index] ?? [];
      const holders = named.filter((path) => sections.get(path).has(number));
      if (holders.length === 0) {
        result.unscoped.push(
          `${at}  §${number}` +
            (named.length === 0
              ? " (the file names no policy document)"
              : ` (not in ${named.map(basename).join(", ")})`)
        );
      } else if (holders.length > 1) {
        result.ambiguous.push(
          `${at}  §${number} could mean ${holders.map(basename).join(" or ")}`
        );
      } else {
        result.valid += 1;
      }
    }
  });

  return result;
};

const basename = (path) => path.split("/").pop();
