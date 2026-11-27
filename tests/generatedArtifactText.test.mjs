import assert from "node:assert/strict";
import test from "node:test";

import { unzipSync } from "fflate";

import {
  admitArchiveSpec,
  admitDocumentSpec,
  admitTextFileSpec,
  isSafeArchivePath,
} from "../lib/generatedArtifactCore.ts";
import {
  TextContentError,
  admitTextContent,
  findMarkupProblem,
  findSvgScript,
  renderArchive,
  renderDocumentMarkdown,
  renderDocumentText,
  renderTextFile,
} from "../lib/generatedArtifactText.ts";

// docs/policy/generated-artifacts.md sections 3 and 4.
//
// Source code, markup and config are the one place the model authors the
// bytes, so everything that made a *specification* safe has to be applied to
// the text instead: a bounded size, an extension this application chose, a
// structural check where malformed means useless, and no path a zip entry can
// escape through.

const decode = (bytes) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);

const text = (format, content, filename = `file.${format}`) =>
  decode(renderTextFile({ filename, format, content }));

/* -------------------------------------------------------------------------- */
/* Authored text                                                                */
/* -------------------------------------------------------------------------- */

test("a source file is stored exactly as written, with a trailing newline", () => {
  const source = "def add(a, b):\n    return a + b";
  assert.equal(text("py", source), `${source}\n`);
});

test("Windows line endings are normalised so the file opens the same anywhere", () => {
  assert.equal(text("py", "a = 1\r\nb = 2\r\n"), "a = 1\nb = 2\n");
});

test("Korean and emoji survive the round trip as UTF-8", () => {
  const content = '# 설정\nname: "톰버스 🚀"';
  assert.equal(text("yaml", content), `${content}\n`);
});

test("malformed JSON is refused rather than delivered", () => {
  assert.throws(
    () => text("json", '{"a": 1,}'),
    (error) => error instanceof TextContentError && error.code === "CONTENT_MALFORMED"
  );
  assert.equal(text("json", '{"a": 1}'), '{"a": 1}\n');
});

test("malformed YAML is refused rather than delivered", () => {
  assert.throws(() => text("yaml", "a:\n  - 1\n b: 2"), TextContentError);
  assert.equal(text("yml", "a: 1"), "a: 1\n");
});

test("unbalanced XML is refused, valid XML is not", () => {
  assert.throws(() => text("xml", "<a><b></a>"), TextContentError);
  assert.equal(text("xml", "<a><b/></a>"), "<a><b/></a>\n");
});

test("HTML void elements do not read as unbalanced", () => {
  const page = "<html><head><meta charset=\"utf-8\"></head><body><br><img src=\"a.png\"></body></html>";
  assert.equal(text("html", page), `${page}\n`);
});

// The SVG rule is the one with teeth: an SVG is markup a browser will execute
// if it is opened directly, so a script inside one is a script this
// application would have written.
test("an SVG carrying a script is refused", () => {
  assert.throws(
    () => text("svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    TextContentError
  );
  assert.throws(
    () => text("svg", '<svg xmlns="http://www.w3.org/2000/svg" onload="go()"></svg>'),
    TextContentError
  );
  assert.throws(
    () => text("svg", '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:go()">x</a></svg>'),
    TextContentError
  );
});

test("a plain SVG is delivered", () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
  assert.equal(text("svg", svg), `${svg}\n`);
});

test("a file with no <svg> element is not an SVG", () => {
  assert.throws(() => text("svg", "<div>hello</div>"), TextContentError);
});

test("an empty file is refused, because a download of nothing is a failure", () => {
  const admission = admitTextFileSpec({
    filename: "empty.py",
    format: "py",
    content: "",
  });
  assert.equal(admission.ok, false);
});

test("the scanners report the first problem and nothing beyond it", () => {
  assert.equal(findMarkupProblem("<a></a>"), null);
  assert.match(findMarkupProblem("<a>"), /never closed/);
  assert.match(findMarkupProblem("<a></b>"), /was expected/);
  assert.equal(findSvgScript("<svg><rect/></svg>"), null);
  assert.match(findSvgScript("<svg><script>x</script></svg>"), /script/i);
});

/* -------------------------------------------------------------------------- */
/* Document, rendered as text                                                   */
/* -------------------------------------------------------------------------- */

const REPORT = {
  filename: "보고서.md",
  format: "md",
  title: "분기 보고서",
  blocks: [
    { type: "heading", level: 2, text: "요약" },
    { type: "paragraph", text: "매출이 늘었습니다." },
    { type: "bullets", items: ["국내", "해외"] },
    { type: "numbers", items: ["하나", "둘"] },
    { type: "quote", text: "확정 전 수치" },
    { type: "code", language: "sql", text: "SELECT 1;" },
    { type: "table", columns: ["분기", "매출"], rows: [["Q1", 100]] },
    { type: "divider" },
  ],
};

const admitReport = (format) => {
  const admission = admitDocumentSpec({ ...REPORT, format });
  assert.equal(admission.ok, true, JSON.stringify(admission));
  return admission.spec;
};

test("Markdown carries every block as Markdown, not as prose about it", () => {
  const markdown = renderDocumentMarkdown(admitReport("md"));
  assert.match(markdown, /^# 분기 보고서$/m);
  assert.match(markdown, /^## 요약$/m);
  assert.match(markdown, /^- 국내$/m);
  assert.match(markdown, /^1\. 하나$/m);
  assert.match(markdown, /^> 확정 전 수치$/m);
  assert.match(markdown, /```sql\nSELECT 1;\n```/);
  assert.match(markdown, /\| 분기 \| 매출 \|/);
  assert.match(markdown, /^---$/m);
});

test("a backslash in a cell survives, and does not unescape the pipe after it", () => {
  // Escaping the pipe alone wrote `a\|b` as `a\\|b`, which a reader takes as
  // one literal backslash and then an *unescaped* pipe -- so the row broke
  // anyway. The same omission ate the backslash out of a Windows path.
  const admission = admitDocumentSpec({
    filename: "t.md",
    format: "md",
    blocks: [
      {
        type: "table",
        columns: ["a"],
        rows: [["a\\|b"], ["C:\\path|x"]],
      },
    ],
  });
  assert.equal(admission.ok, true);
  const markdown = renderDocumentMarkdown(admission.spec);

  // Read the cell back the way a Markdown reader does: a backslash consumes
  // the character after it, and a bare pipe ends the cell.
  const readCell = (cell) => {
    let out = "";
    for (let index = 0; index < cell.length; index += 1) {
      if (cell[index] === "\\" && index + 1 < cell.length) {
        out += cell[index + 1];
        index += 1;
      } else if (cell[index] === "|") {
        out += "\u0000BREAK";
      } else {
        out += cell[index];
      }
    }
    return out;
  };

  const cells = markdown
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.slice(1, -1).trim());
  for (const [index, expected] of [["a\\|b"], ["C:\\path|x"]].entries()) {
    const row = cells[index + 2];
    assert.equal(readCell(row), expected[0], `row ${index}: ${row}`);
    assert.ok(!readCell(row).includes("BREAK"), `row ${index} breaks the table`);
  }
});

test("a pipe inside a cell does not break the Markdown table", () => {
  const admission = admitDocumentSpec({
    filename: "t.md",
    format: "md",
    blocks: [{ type: "table", columns: ["a|b"], rows: [["c|d"]] }],
  });
  const markdown = renderDocumentMarkdown(admission.spec);
  for (const line of markdown.split("\n").filter((row) => row.startsWith("|"))) {
    assert.equal(line.match(/(?<!\\)\|/g).length, 2, line);
  }
});

test("plain text keeps the structure without the markup", () => {
  const plain = renderDocumentText(admitReport("txt"));
  assert.ok(plain.includes("분기 보고서"));
  assert.ok(plain.includes("요약"));
  assert.ok(plain.includes("국내"));
  assert.ok(!plain.includes("```"));
  // A pipe still appears -- it is how a quoted line is marked in plain text.
  // What must not appear is a Markdown table pretending to be one.
  assert.ok(!plain.includes("| 분기 |"));
  assert.ok(!plain.includes("---|"));
});

/* -------------------------------------------------------------------------- */
/* Archive                                                                      */
/* -------------------------------------------------------------------------- */

const PROJECT = {
  filename: "starter.zip",
  format: "zip",
  entries: [
    { path: "README.md", format: "md", content: "# Starter\n" },
    { path: "src/main.py", format: "py", content: "print('hi')\n" },
    { path: "config/app.json", format: "json", content: '{"port": 3000}' },
  ],
};

const buildArchive = (spec) => {
  const admission = admitArchiveSpec(spec);
  assert.equal(admission.ok, true, JSON.stringify(admission));
  return renderArchive(admission.spec);
};

test("every entry is in the zip, at the path it was given", () => {
  const files = unzipSync(buildArchive(PROJECT));
  assert.deepEqual(Object.keys(files).sort(), [
    "README.md",
    "config/app.json",
    "src/main.py",
  ]);
  assert.equal(decode(files["src/main.py"]), "print('hi')\n");
});

// Refused, not sanitised. Quietly rewriting `../../etc/passwd` to `etc/passwd`
// would deliver an archive whose contents are not where the model said.
test("a path that escapes the archive is refused", () => {
  for (const path of [
    "../escape.py",
    "/absolute.py",
    "C:/windows.py",
    "a\\b.py",
    "./same.py",
    "nested/../up.py",
    "trailing//empty.py",
  ]) {
    assert.equal(isSafeArchivePath(path), false, path);
    const admission = admitArchiveSpec({
      ...PROJECT,
      entries: [{ path, format: "py", content: "x = 1" }],
    });
    assert.equal(admission.ok, false, path);
    assert.equal(admission.code, "UNSAFE_PATH", path);
  }
});

test("an ordinary nested path is allowed", () => {
  for (const path of ["a.py", "src/a.py", "src/deep/a.py", "a-b_c.1.py"]) {
    assert.equal(isSafeArchivePath(path), true, path);
  }
});

test("the same path twice is refused rather than silently overwritten", () => {
  const admission = admitArchiveSpec({
    ...PROJECT,
    entries: [
      { path: "a.py", format: "py", content: "1" },
      { path: "a.py", format: "py", content: "2" },
    ],
  });
  assert.equal(admission.ok, false);
  assert.equal(admission.code, "UNSAFE_PATH");
});

// The rule the archive exists to not break: a zip must not be the way to
// deliver what a direct request is refused.
test("an entry's content is validated exactly as a direct request would be", () => {
  assert.throws(
    () =>
      renderArchive(
        admitArchiveSpec({
          ...PROJECT,
          entries: [{ path: "bad.json", format: "json", content: "{" }],
        }).spec
      ),
    TextContentError
  );
});

test("an entry may not name a format that is not a text format", () => {
  const admission = admitArchiveSpec({
    ...PROJECT,
    entries: [{ path: "book.xlsx", format: "xlsx", content: "x" }],
  });
  assert.equal(admission.ok, false);
  assert.equal(admission.code, "SCHEMA_INVALID");
});

test("the archive bytes are deterministic, so a replay cannot differ", () => {
  assert.deepEqual(buildArchive(PROJECT), buildArchive(PROJECT));
});

test("admitTextContent is what every path shares", () => {
  assert.equal(
    admitTextContent({ filename: "a.py", format: "py", content: "x = 1" }),
    "x = 1\n"
  );
});

/* ------------------------------------------------------------------------ */
/* XML strictness: the errors that make a browser refuse to draw an SVG      */
/* ------------------------------------------------------------------------ */

/**
 * A generated `.svg` carrying `text-anchor` twice on one element was accepted,
 * written, and offered as a finished picture -- and opened as "Attribute
 * text-anchor redefined". The scanner passed it because it never looked at
 * attributes. Each case below is fatal to an XML parser, so each one is a file
 * this product would have claimed to make and could not open.
 */
const FATAL_IN_XML = [
  [
    "the same attribute twice",
    '<svg xmlns="http://www.w3.org/2000/svg"><text x="10" text-anchor="middle" y="20" text-anchor="start">hi</text></svg>',
  ],
  [
    "an unescaped ampersand in text",
    '<svg xmlns="http://www.w3.org/2000/svg"><text>salt & sodium</text></svg>',
  ],
  [
    "an unescaped ampersand in an attribute",
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="a.html?x=1&y=2">x</a></svg>',
  ],
  [
    "tags whose case does not match",
    '<svg xmlns="http://www.w3.org/2000/svg"><Text>hi</text></svg>',
  ],
  [
    "an unquoted attribute value",
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width=100 height="50"/></svg>',
  ],
  [
    "an unclosed element that HTML would forgive",
    '<svg xmlns="http://www.w3.org/2000/svg"><img src="a.png"></svg>',
  ],
];

for (const [label, svg] of FATAL_IN_XML) {
  test(`an SVG with ${label} is refused rather than delivered`, () => {
    assert.throws(() => text("svg", svg), TextContentError);
  });
}

test("an XML file is held to the same rules as an SVG", () => {
  assert.throws(() => text("xml", '<a b="1" b="2"/>'), TextContentError);
  assert.throws(() => text("xml", "<a>Tom & Jerry</a>"), TextContentError);
  assert.equal(text("xml", '<a b="1">Tom &amp; Jerry</a>'), '<a b="1">Tom &amp; Jerry</a>\n');
});

test("HTML keeps every one of those, because a browser does too", () => {
  // Turning strictness on for `.html` would reject ordinary working pages.
  const page =
    '<html><head><meta charset="utf-8"></head><body><BR><img src="a.png">' +
    '<div class=box>Tom & Jerry</div></body></html>';
  assert.equal(text("html", page), `${page}\n`);
});

/*
 * A page a model writes is rejected only when it is broken, not when it is
 * merely HTML. These are the shapes that used to be refused: a "<" inside a
 * script, and end tags the HTML syntax lets an author leave off.
 */
test("an inline script with a less-than comparison is delivered", () => {
  const page =
    "<!DOCTYPE html><html><head><title>a < b</title><style>ul > li { color: red }</style></head>" +
    "<body><script>for (let i = 0; i < 10; i++) { if (i<3 && i>1) log(\"<b>\"); }</script>" +
    "<p>done</p></body></html>";
  assert.equal(text("html", page), `${page}\n`);
  assert.equal(text("htm", page, "page.htm"), `${page}\n`);
  assert.equal(findMarkupProblem(page), null);
});

test("a raw-text element is closed by its own end tag in any case, and only by it", () => {
  const page =
    "<body><SCRIPT type=text/javascript>var s = '<div>' + \"</scripts>\";</SCRIPT>" +
    "<textarea><b>not a tag</textarea><p>x</p></body>";
  assert.equal(findMarkupProblem(page), null);
  // A page cut off inside a script is a truncated page, and is still refused.
  assert.match(findMarkupProblem("<body><script>if (a < b) {"), /<script> is never closed/);
  assert.match(findMarkupProblem("<style>a { color: red }"), /<style> is never closed/);
});

test("a less-than sign that cannot start a tag is text in HTML", () => {
  assert.equal(findMarkupProblem("<p>if x<3 and y < 5 then 2 <3 </p>"), null);
  assert.equal(findMarkupProblem("<p>ends with <"), null);
});

test("HTML end tags that the syntax lets an author omit may be missing", () => {
  const page =
    "<!DOCTYPE html><html><head><title>t</title></head><body>" +
    "<ul><li>one<li>two<ul><li>nested</ul><li>three</ul>" +
    "<p>first paragraph<p>second paragraph" +
    "<table><tr><th>A<th>B<tr><td>1<td>2</table>" +
    "<dl><dt>term<dd>description<dt>next<dd>more</dl>" +
    "<select><option>a<option>b</select>";
  assert.equal(findMarkupProblem(page), null);
  assert.equal(text("html", page), `${page}\n`);
  assert.equal(findMarkupProblem("<html><body><p>no closing html or body"), null);
  assert.equal(findMarkupProblem("<div><p>closed by its parent</div>"), null);
  // A stray </p> and </br> are repaired by a browser rather than refused.
  assert.equal(findMarkupProblem("<div>text</p></div><br></br>"), null);
});

test("HTML that is actually broken is still refused", () => {
  assert.match(findMarkupProblem("<div><span>x</div>"), /<\/div> where <\/span> was expected/);
  assert.match(findMarkupProblem("<ul><li>x<div>y</li></ul>"), /<\/li> where <\/div> was expected/);
  assert.match(findMarkupProblem("<div><ul><li>x"), /<ul> is never closed/);
  assert.match(findMarkupProblem("<div>text"), /<div> is never closed/);
  assert.match(findMarkupProblem("<b></i>"), /was expected/);
  assert.match(findMarkupProblem("</div>"), /nothing open/);
  assert.match(findMarkupProblem("<p>a <b"), /unterminated tag/);
  assert.match(findMarkupProblem('<a href="x>y</a>'), /unterminated attribute value|unterminated tag/);
  assert.match(findMarkupProblem("<p>x</p><!-- never ends"), /unterminated comment/);
  assert.throws(() => text("html", "<div><p>text"), TextContentError);
  assert.throws(() => text("html", "<p>a</p><!-- oops"), TextContentError);
});

test("an HTML page inside a zip gets the same forgiveness as a file on its own", () => {
  const page =
    "<html><body><ul><li>one<li>two</ul><script>for (var i = 0; i < 3; i++) {}</script></body></html>";
  const files = unzipSync(
    buildArchive({
      ...PROJECT,
      entries: [
        { path: "site/index.html", format: "html", content: page },
        { path: "README.md", format: "md", content: "# Site\n" },
      ],
    })
  );
  assert.equal(decode(files["site/index.html"]), `${page}\n`);
  assert.throws(
    () =>
      renderArchive(
        admitArchiveSpec({
          ...PROJECT,
          entries: [{ path: "bad.html", format: "html", content: "<div><span>x</div>" }],
        }).spec
      ),
    TextContentError
  );
});

test("XML and SVG keep the strict rules the HTML pass relaxes", () => {
  // The same shapes HTML now accepts are fatal to an XML parser.
  assert.throws(() => text("xml", "<a><b>text</a>"), TextContentError);
  assert.throws(() => text("xml", "<ul><li>one<li>two</ul>"), TextContentError);
  assert.throws(() => text("xml", "<a>if x < 3</a>"), TextContentError);
  assert.match(findMarkupProblem("<a><b>x</a>", { strict: true }), /<\/a> where <\/b> was expected/);
  assert.match(findMarkupProblem("<p>a</p><p>b", { strict: true }), /<p> is never closed/);
  assert.match(findMarkupProblem("<a>", { strict: true }), /never closed/);
  // A <script> in an SVG is refused before the scanner ever runs.
  assert.throws(
    () => text("svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>if (a < b) {}</script></svg>'),
    /may not contain a <script> element/
  );
  // Case still matters in XML, where it does not in HTML.
  assert.throws(() => text("svg", '<svg xmlns="http://www.w3.org/2000/svg"><Text>hi</text></svg>'), TextContentError);
  assert.equal(findMarkupProblem("<BODY><P>a</p></Body>"), null);
});

test("the references XML does accept still pass", () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><text>A &amp; B &lt; C &#65; &#x42;</text></svg>';
  assert.equal(text("svg", svg), `${svg}\n`);
});

test("a named HTML entity is refused in an SVG, as XML refuses it", () => {
  // `&nbsp;` needs a DTD an SVG a browser opens does not have.
  assert.throws(
    () => text("svg", '<svg xmlns="http://www.w3.org/2000/svg"><text>a&nbsp;b</text></svg>'),
    TextContentError
  );
});

test("a realistic infographic SVG is still accepted", () => {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">',
    '<rect width="400" height="60" fill="#e94b35"/>',
    '<text x="200" y="38" text-anchor="middle" font-size="24" fill="#ffffff">고혈압에 좋은 음식</text>',
    '<g transform="translate(20,80)"><circle cx="20" cy="20" r="18" fill="#e94b35"/>',
    '<text x="50" y="26" font-size="14">바나나 &amp; 시금치</text></g>',
    "</svg>",
  ].join("");
  assert.equal(text("svg", svg), `${svg}\n`);
});
