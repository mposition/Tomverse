/**
 * The two lists the merge lane's exclusion reads from the policy documents
 * at a pull request's base (docs/policy/qa-release-agent.md version 4,
 * section 8 item 3 and appendix A):
 * - this agent's own path patterns: the fenced block under appendix A;
 * - the policy tests: every `tests/**` file that AGENTS.md, CLAUDE.md or any
 *   file under docs/policy/ names by path -- a YAML registry there counts as
 *   much as a Markdown policy.
 *
 * Pure: the GitHub adapter reads the files at the base commit and passes
 * their text. A document that cannot be read, or an appendix that cannot be
 * found, is null -- and the exclusion core excludes on null inputs.
 */

const APPENDIX_HEADING = /^## 부록 A\. [^\n]*$/m;
const PATTERN_LINE = /^[A-Za-z0-9_.()[\]*/@-]+$/;

/** The appendix A patterns, or null when the appendix or its block is missing or malformed. */
export function qaReleaseAgentOwnPatterns(policyText: string): string[] | null {
  const heading = APPENDIX_HEADING.exec(policyText);
  if (!heading) return null;
  const rest = policyText.slice(heading.index + heading[0].length);
  const nextHeading = rest.search(/^## /m);
  const section = nextHeading < 0 ? rest : rest.slice(0, nextHeading);
  const block = /^```[^\n]*\n([\s\S]*?)^```$/m.exec(section);
  if (!block) return null;
  const lines = block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0 || !lines.every((line) => PATTERN_LINE.test(line))) return null;
  return lines;
}

/** A test file named by path: a repository-relative path under tests/, with a test source extension. */
const TEST_PATH = /(?<![A-Za-z0-9_./-])tests\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|tsx)(?![A-Za-z0-9_])/g;

/** Every tests/** path the documents name, sorted and without duplicates. */
export function qaReleasePolicyTestPaths(documents: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of documents) {
    for (const match of text.matchAll(TEST_PATH)) {
      const path = match[0];
      // A path with a traversal or an empty segment names nothing in the tree.
      if (path.includes("..") || path.includes("//")) continue;
      found.add(path);
    }
  }
  return [...found].sort();
}

/**
 * Which files at the base are the documents that name policy tests (section 8
 * item 3): every file under docs/policy/, whatever its extension, plus
 * AGENTS.md and CLAUDE.md. Filtering by extension would let a test that only a
 * YAML registry names be merged unattended.
 */
export const isQaReleasePolicyDocument = (path: string): boolean =>
  path === "AGENTS.md" ||
  path === "CLAUDE.md" ||
  (path.startsWith("docs/policy/") && path.length > "docs/policy/".length && !path.endsWith("/"));
