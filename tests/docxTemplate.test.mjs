import assert from "node:assert/strict";
import test from "node:test";

import { unzipSync, zipSync } from "fflate";

import {
  DocxTemplateError,
  loadDocxTemplate,
  renderDocxFromTemplate,
} from "../lib/docxTemplate.ts";
import {
  DOCX_TEMPLATE_PARTS,
  buildDocxTemplate,
  splitParagraph,
} from "./fixtures/officeFixtures.mjs";

// docs/policy/generated-artifacts.md section 13.
//
// Two claims are being pinned here, and they pull in opposite directions:
// the template is preserved (which means copying parts nobody inspected), and
// the template is safe (which means refusing whole classes of them). The tests
// below are the line between those two.

const decoder = new TextDecoder();
const partText = (bytes, name) => decoder.decode(unzipSync(bytes)[name]);

const VALUES = {
  이름: "김민수",
  생년월일: "1990-03-04",
  입사일: "2026-04-01",
  소속팀: "플랫폼팀",
};

/* -------------------------------------------------------------------------- */
/* Substitution                                                                 */
/* -------------------------------------------------------------------------- */

test("a placeholder split across four runs is substituted exactly once", () => {
  const template = loadDocxTemplate(buildDocxTemplate());
  // The fixture writes `안녕하세요 {{이름}} 님.` as five separate runs, which
  // is what Word does on its own. A replace over the raw XML finds nothing.
  const filled = renderDocxFromTemplate(template, VALUES);
  const document = partText(filled, "word/document.xml");
  assert.match(document, /안녕하세요/);
  assert.equal(document.includes("김민수"), true);
  assert.equal(document.includes("{{"), false);
  assert.equal(document.split("김민수").length - 1, 1);
});

test("the template's own placeholder list is read across runs too", () => {
  const template = loadDocxTemplate(buildDocxTemplate());
  assert.deepEqual(
    [...template.placeholders].sort(),
    ["생년월일", "소속팀", "이름", "입사일"].sort()
  );
});

test("placeholders in a header and a footer are filled, not only the body", () => {
  const filled = renderDocxFromTemplate(
    loadDocxTemplate(buildDocxTemplate()),
    VALUES
  );
  assert.match(partText(filled, "word/header1.xml"), /플랫폼팀/);
  assert.match(partText(filled, "word/footer1.xml"), /2026-04-01/);
});

test("a value inherits the formatting of the run the placeholder started in", () => {
  const filled = renderDocxFromTemplate(
    loadDocxTemplate(buildDocxTemplate()),
    VALUES
  );
  const document = partText(filled, "word/document.xml");
  // The fixture's runs all carry <w:b/>; the substituted run must still be
  // inside one that does, rather than having been re-emitted bare.
  const runWithValue = document
    .split("<w:r>")
    .find((run) => run.includes("김민수"));
  assert.match(runWithValue, /<w:b\/>/);
  assert.match(runWithValue, /xml:space="preserve"/);
});

test("XML-significant characters in a value are escaped, not injected", () => {
  const filled = renderDocxFromTemplate(loadDocxTemplate(buildDocxTemplate()), {
    ...VALUES,
    이름: '<w:p>&"drop"</w:p>',
  });
  const document = partText(filled, "word/document.xml");
  assert.match(document, /&lt;w:p&gt;&amp;/);
  // Whatever the value said, the paragraph count is the template's.
  assert.equal(
    document.split("<w:p>").length,
    partText(buildDocxTemplate(), "word/document.xml").split("<w:p>").length
  );
});

test("a newline in a value becomes a real line break", () => {
  const filled = renderDocxFromTemplate(loadDocxTemplate(buildDocxTemplate()), {
    ...VALUES,
    이름: "김민수\n(대리)",
  });
  const document = partText(filled, "word/document.xml");
  assert.match(document, /김민수<\/w:t><w:br\/><w:t xml:space="preserve">\(대리\)/);
});

test("an unresolved placeholder fails the render rather than shipping", () => {
  const template = loadDocxTemplate(buildDocxTemplate());
  assert.throws(
    () => renderDocxFromTemplate(template, { 이름: "김민수" }),
    (error) =>
      error instanceof DocxTemplateError &&
      error.code === "PLACEHOLDER_UNRESOLVED"
  );
});

test("a missing required placeholder fails before anything is written", () => {
  const template = loadDocxTemplate(buildDocxTemplate());
  assert.throws(
    () =>
      renderDocxFromTemplate(
        template,
        { ...VALUES, 이름: "   " },
        { requiredPlaceholders: ["이름"] }
      ),
    (error) =>
      error instanceof DocxTemplateError && error.code === "PLACEHOLDER_MISSING"
  );
});

test("a value that itself contains a placeholder is caught, not delivered", () => {
  const template = loadDocxTemplate(buildDocxTemplate());
  assert.throws(
    () => renderDocxFromTemplate(template, { ...VALUES, 이름: "{{이름}}" }),
    (error) =>
      error instanceof DocxTemplateError &&
      error.code === "PLACEHOLDER_UNRESOLVED"
  );
});

test("an over-long value is refused rather than truncated", () => {
  const template = loadDocxTemplate(buildDocxTemplate());
  assert.throws(
    () =>
      renderDocxFromTemplate(template, { ...VALUES, 이름: "가".repeat(5_000) }),
    (error) =>
      error instanceof DocxTemplateError &&
      error.code === "PLACEHOLDER_VALUE_TOO_LONG"
  );
});

/* -------------------------------------------------------------------------- */
/* Preservation                                                                 */
/* -------------------------------------------------------------------------- */

test("styles, theme, image and relationships come through byte-identical", () => {
  const source = buildDocxTemplate();
  const filled = renderDocxFromTemplate(loadDocxTemplate(source), VALUES);
  const before = unzipSync(source);
  const after = unzipSync(filled);
  for (const name of [
    "word/styles.xml",
    "word/theme/theme1.xml",
    "word/media/image1.png",
    "word/_rels/document.xml.rels",
    "[Content_Types].xml",
    "docProps/core.xml",
  ]) {
    assert.deepEqual(after[name], before[name], `${name} was rewritten`);
  }
});

test("the table, the section properties and the drawing survive substitution", () => {
  const filled = renderDocxFromTemplate(
    loadDocxTemplate(buildDocxTemplate()),
    VALUES
  );
  const document = partText(filled, "word/document.xml");
  assert.match(document, /<w:tblStyle w:val="TomverseGrid"\/>/);
  assert.equal(document.split("<w:tr>").length - 1, 3);
  assert.match(document, /<w:headerReference w:type="default" r:id="rId3"\/>/);
  assert.match(document, /<w:footerReference w:type="default" r:id="rId4"\/>/);
  assert.match(document, /<w:pgSz w:w="11906" w:h="16838"\/>/);
  assert.match(document, /<a:blip r:embed="rId5"\/>/);
  assert.match(document, /<w:pStyle w:val="Title"\/>/);
});

test("every part of the template is still in the package", () => {
  const source = buildDocxTemplate();
  const filled = renderDocxFromTemplate(loadDocxTemplate(source), VALUES);
  assert.deepEqual(
    Object.keys(unzipSync(filled)).sort(),
    Object.keys(unzipSync(source)).sort()
  );
});

test("two renders of the same inputs are byte-identical", () => {
  const template = loadDocxTemplate(buildDocxTemplate());
  assert.deepEqual(
    renderDocxFromTemplate(template, VALUES),
    renderDocxFromTemplate(template, VALUES)
  );
});

/* -------------------------------------------------------------------------- */
/* Refusals                                                                     */
/* -------------------------------------------------------------------------- */

test("a macro project is refused, not stripped", () => {
  assert.throws(
    () =>
      loadDocxTemplate(
        buildDocxTemplate({
          overrides: { "word/vbaProject.bin": new Uint8Array([1, 2, 3]) },
        })
      ),
    (error) =>
      error instanceof DocxTemplateError &&
      error.code === "TEMPLATE_MACRO_REFUSED"
  );
});

test("a macro-enabled content type is refused even with no macro part", () => {
  assert.throws(
    () =>
      loadDocxTemplate(
        buildDocxTemplate({
          overrides: {
            "[Content_Types].xml": DOCX_TEMPLATE_PARTS.contentTypes.replace(
              "document.main+xml",
              "document.macroEnabled.main+xml"
            ),
          },
        })
      ),
    (error) =>
      error instanceof DocxTemplateError &&
      error.code === "TEMPLATE_MACRO_REFUSED"
  );
});

test("an external relationship is refused", () => {
  assert.throws(
    () =>
      loadDocxTemplate(
        buildDocxTemplate({
          overrides: {
            "word/_rels/document.xml.rels":
              DOCX_TEMPLATE_PARTS.documentRels.replace(
                "</Relationships>",
                '<Relationship Id="rIdX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.invalid/logo.png" TargetMode="External"/></Relationships>'
              ),
          },
        })
      ),
    (error) =>
      error instanceof DocxTemplateError &&
      error.code === "TEMPLATE_EXTERNAL_REFERENCE_REFUSED"
  );
});

test("an OLE relationship type is refused whatever it points at", () => {
  assert.throws(
    () =>
      loadDocxTemplate(
        buildDocxTemplate({
          overrides: {
            "word/_rels/document.xml.rels":
              DOCX_TEMPLATE_PARTS.documentRels.replace(
                "</Relationships>",
                '<Relationship Id="rIdY" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="embeddings/thing.bin"/></Relationships>'
              ),
          },
        })
      ),
    (error) =>
      error instanceof DocxTemplateError && error.code === "TEMPLATE_OLE_REFUSED"
  );
});

test("altChunk is refused", () => {
  assert.throws(
    () =>
      loadDocxTemplate(
        buildDocxTemplate({
          body: `${splitParagraph(["{{이름}}"])}<w:altChunk r:id="rId9"/>`,
        })
      ),
    (error) =>
      error instanceof DocxTemplateError &&
      error.code === "TEMPLATE_ALT_CHUNK_REFUSED"
  );
});

test("a field code that loads external content is refused", () => {
  assert.throws(
    () =>
      loadDocxTemplate(
        buildDocxTemplate({
          body: `<w:p><w:r><w:instrText> INCLUDETEXT "\\\\\\\\server\\\\share\\\\x.docx" </w:instrText></w:r></w:p>`,
        })
      ),
    (error) =>
      error instanceof DocxTemplateError &&
      error.code === "TEMPLATE_FIELD_CODE_REFUSED"
  );
});

test("an embedded object element is refused", () => {
  assert.throws(
    () =>
      loadDocxTemplate(
        buildDocxTemplate({
          body: `<w:p><w:r><w:object><o:OLEObject xmlns:o="urn:schemas-microsoft-com:office:office" ProgID="Package"/></w:object></w:r></w:p>`,
        })
      ),
    (error) =>
      error instanceof DocxTemplateError && error.code === "TEMPLATE_OLE_REFUSED"
  );
});

test("a zip entry that escapes the package is refused, not normalised", () => {
  const parts = unzipSync(buildDocxTemplate());
  const traversal = zipSync(
    { ...parts, "../../etc/passwd": new Uint8Array([1]) },
    { mtime: Date.UTC(2020, 0, 1) }
  );
  assert.throws(
    () => loadDocxTemplate(traversal),
    (error) =>
      error instanceof DocxTemplateError &&
      error.code === "TEMPLATE_UNSAFE_ENTRY"
  );
});

test("an absolute zip entry path is refused", () => {
  const parts = unzipSync(buildDocxTemplate());
  const absolute = zipSync(
    { ...parts, "/etc/shadow": new Uint8Array([1]) },
    { mtime: Date.UTC(2020, 0, 1) }
  );
  assert.throws(
    () => loadDocxTemplate(absolute),
    (error) =>
      error instanceof DocxTemplateError &&
      error.code === "TEMPLATE_UNSAFE_ENTRY"
  );
});

test("a package with no word/document.xml is not a template", () => {
  assert.throws(
    () =>
      loadDocxTemplate(
        buildDocxTemplate({ overrides: { "word/document.xml": null } })
      ),
    (error) =>
      error instanceof DocxTemplateError && error.code === "TEMPLATE_NOT_DOCX"
  );
});

test("bytes that are not a zip at all are refused", () => {
  assert.throws(
    () => loadDocxTemplate(new TextEncoder().encode("not a docx")),
    (error) =>
      error instanceof DocxTemplateError && error.code === "TEMPLATE_UNREADABLE"
  );
});
