// Turning the staging checklist into a blank run record.
//
// Pure: markdown in, a record skeleton out. The script around it owns paths
// and argument handling.
//
// ## Why this is generated rather than copied
//
// The record used to be a table inside the checklist, which is how a signed
// `통과` came to sit above 54 empty boxes. Splitting them fixed that and
// introduced a smaller version of the same problem: the blank record said
// "copy A–G" for eight days after section H was added. A hand-copied item
// list would drift the same way, item by item, and the drift would be
// invisible — a missing row reads exactly like a section nobody ran.
//
// So the item list is read from the checklist at the moment a run starts. The
// skeleton is a fact about the checklist as it is on the day, and the
// `templateRevision` beside it says which day that was.

/** `- [ ] text`, possibly continued on indented following lines. */
const ITEM_START = /^-\s+\[\s?\]\s+(.*)$/;
const SECTION = /^##\s+(.+)$/;
const SUBSECTION = /^###\s+(.+)$/;

/**
 * Every checklist item, in document order, with the heading it sits under.
 *
 * Continuation lines are folded into one string: an item that wraps across
 * four lines is still one thing to judge, and a record with four rows for it
 * would be four judgements nobody made.
 *
 * Sub-headings are carried separately from the section because `C` has four
 * of them and "C" alone would not tell the executor which part of the limit
 * semantics they were looking at.
 */
export function checklistItems(markdown) {
  const items = [];
  let section = null;
  let subsection = null;
  let current = null;

  const flush = () => {
    if (current) items.push(current);
    current = null;
  };

  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const heading = SECTION.exec(line);
    if (heading) {
      flush();
      section = heading[1].trim();
      subsection = null;
      continue;
    }
    const sub = SUBSECTION.exec(line);
    if (sub) {
      flush();
      subsection = sub[1].trim();
      continue;
    }
    const start = ITEM_START.exec(line);
    if (start) {
      flush();
      current = { section, subsection, text: start[1].trim() };
      continue;
    }
    // A continuation is an indented line that is not itself a list item or a
    // block quote. Anything else ends the item.
    if (current && /^\s{2,}\S/.test(raw) && !/^\s*[->]/.test(raw)) {
      current.text = `${current.text} ${line.trim()}`;
      continue;
    }
    if (line.trim() === "") continue;
    flush();
  }
  flush();
  return items;
}

/** `## A. Fail-closed (flag off)` -> `A`. Null for headings with no letter. */
export const sectionLetter = (section) => {
  const match = /^([A-Z])\.\s/.exec(section ?? "");
  return match ? match[1] : null;
};

/** A cell that cannot break the table it sits in. */
const cell = (text) =>
  text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/**
 * The item table an executor fills in.
 *
 * One row per checklist item, results empty. Empty is the honest starting
 * state: `미기록` is what a row *ends* as when it was not run, and pre-filling
 * that would be recording an outcome before the run.
 */
export function renderItemTable(items) {
  const rows = [
    "| 구획 | 항목 | 결과 | 증거 | 후속 티켓 |",
    "|---|---|---|---|---|",
  ];
  let lastGroup = null;
  for (const item of items) {
    const letter = sectionLetter(item.section);
    const group = letter
      ? item.subsection
        ? `${letter} · ${item.subsection}`
        : item.section
      : item.section;
    if (group !== lastGroup) {
      rows.push(`| **${cell(group ?? "")}** | | | | |`);
      lastGroup = group;
    }
    rows.push(`| | ${cell(item.text)} | | | |`);
  }
  return rows.join("\n");
}

/**
 * The blank record for one run.
 *
 * The template supplies the front matter and the prose; only the item section
 * is generated, so a change to how a record is *shaped* stays a change to one
 * file rather than to this code.
 */
export function renderRecord({ template, items, date, deploySha, revision }) {
  const table = renderItemTable(items);
  return template
    .replace(/^templateRevision:.*$/m, `templateRevision: ${revision}`)
    .replace(/^deploySha:.*$/m, `deploySha: ${deploySha}`)
    .replace(
      /^# Staging 검증 실행 — .*$/m,
      `# Staging 검증 실행 — ${date} / ${deploySha.slice(0, 7)}`
    )
    .replace(
      /^\| 배포 SHA \(전체 40자리\) \|.*$/m,
      `| 배포 SHA (전체 40자리) | \`${deploySha}\` |`
    )
    .replace(/^\| template revision \|.*$/m, `| template revision | ${revision} |`)
    .replace(
      /\| 구획 \| 항목 \| 결과 \| 증거 \| 후속 티켓 \|\n\|---\|---\|---\|---\|---\|\n\| A \| \| \| \| \|/,
      table
    );
}
