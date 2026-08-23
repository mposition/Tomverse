import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHIVE_FATAL_EXTENSIONS,
  ASSOCIATION_OWNER_MEDIA_TYPES,
  ARCHIVE_TOLERATED_BINARY_EXTENSIONS,
  CHAT_ATTACHMENT_FORMATS,
  CHAT_ATTACHMENT_MEDIA_TYPES,
  EXECUTABLE_ATTACHMENT_EXTENSIONS,
  GUEST_CHAT_ATTACHMENT_MEDIA_TYPES,
  OTHER_ARCHIVE_EXTENSIONS,
  REFUSED_ATTACHMENT_EXTENSIONS,
  attachmentFileExtension,
  attachmentKindForFormat,
  chatAttachmentAcceptAttribute,
  chatAttachmentExtensionsByGroup,
  formatByMediaType,
  providerMediaTypeForFormat,
  resolveChatAttachmentFormat,
} from "../lib/chatAttachmentFormats.ts";
import { GUEST_ACCEPTED_MEDIA_TYPES } from "../lib/guestAttachmentPolicy.ts";

// The whole point of the registry is that four surfaces stop disagreeing, so
// most of what is worth asserting here is agreement -- and the resolution
// matrix that used to live, differently, in each of them.

const resolve = (filename, declaredMediaType) =>
  resolveChatAttachmentFormat({ filename, declaredMediaType });

test("no two formats claim the same extension, filename or canonical type", () => {
  const extensions = new Map();
  const filenames = new Map();
  const mediaTypes = new Map();
  for (const format of CHAT_ATTACHMENT_FORMATS) {
    for (const extension of format.extensions) {
      assert.equal(
        extensions.get(extension),
        undefined,
        `.${extension} is claimed by both ${extensions.get(extension)} and ${format.id}`
      );
      extensions.set(extension, format.id);
    }
    for (const filename of format.filenames || []) {
      assert.equal(filenames.get(filename), undefined, filename);
      filenames.set(filename, format.id);
    }
    assert.equal(
      mediaTypes.get(format.mediaType),
      undefined,
      `${format.mediaType} is claimed twice`
    );
    mediaTypes.set(format.mediaType, format.id);
  }
});

test("a supported extension is never also on a refusal list", () => {
  // The two lists answer opposite questions, and an extension on both would
  // make which answer you get depend on the order the checks happen to run.
  for (const format of CHAT_ATTACHMENT_FORMATS) {
    for (const extension of format.extensions) {
      assert.equal(
        REFUSED_ATTACHMENT_EXTENSIONS.has(extension),
        false,
        `.${extension} is both supported and refused`
      );
      assert.equal(ARCHIVE_FATAL_EXTENSIONS.has(extension), false, extension);
    }
  }
  // ZIP specifically: it is a supported container, so it must not sit in the
  // "every other archive format" list that refuses renamed containers.
  assert.equal(OTHER_ARCHIVE_EXTENSIONS.has("zip"), false);
  assert.equal(EXECUTABLE_ATTACHMENT_EXTENSIONS.has("sh"), false);
  assert.equal(EXECUTABLE_ATTACHMENT_EXTENSIONS.has("bat"), true);
});

test("build output stays refused as an upload even though an archive tolerates it", () => {
  // Two different questions. Attaching a `.jar` is still refused for the
  // reason every library is; finding one inside a source archive is not a
  // reason to refuse the archive.
  for (const extension of ARCHIVE_TOLERATED_BINARY_EXTENSIONS) {
    assert.equal(
      EXECUTABLE_ATTACHMENT_EXTENSIONS.has(extension),
      true,
      `.${extension} must stay refused as a direct upload`
    );
    assert.equal(REFUSED_ATTACHMENT_EXTENSIONS.has(extension), true, extension);
    assert.equal(resolve(`build/thing.${extension}`, ""), null, extension);
  }
  // And a program the reader could run is never tolerated anywhere.
  for (const extension of ["exe", "msi", "bat", "cmd", "dll"]) {
    assert.equal(ARCHIVE_TOLERATED_BINARY_EXTENSIONS.has(extension), false, extension);
  }
});

test("the guest subset is derived, so the two guest lists cannot drift", () => {
  assert.deepEqual(
    [...GUEST_ACCEPTED_MEDIA_TYPES].sort(),
    [...GUEST_CHAT_ATTACHMENT_MEDIA_TYPES].sort()
  );
  // And it is a subset of what an account may send, never a superset.
  for (const mediaType of GUEST_CHAT_ATTACHMENT_MEDIA_TYPES) {
    assert.equal(CHAT_ATTACHMENT_MEDIA_TYPES.has(mediaType), true, mediaType);
  }
});

test("the picker's accept attribute offers every format by type and by extension", () => {
  const accept = chatAttachmentAcceptAttribute().split(",");
  for (const format of CHAT_ATTACHMENT_FORMATS) {
    assert.ok(accept.includes(format.mediaType), format.mediaType);
    for (const extension of format.extensions) {
      // The extension alias is what saves a file the picker could not name.
      assert.ok(accept.includes(`.${extension}`), extension);
    }
  }
  const guestAccept = chatAttachmentAcceptAttribute({ guest: true }).split(",");
  for (const entry of guestAccept) assert.ok(accept.includes(entry), entry);
});

test("an extension decides when the browser reports nothing useful", () => {
  // The exact case that made an ordinary text file unattachable: the composer
  // repaired a missing media type for the six Office extensions and for
  // nothing else.
  for (const declared of ["", undefined, null, "application/octet-stream", "*/*"]) {
    assert.equal(resolve("notes.txt", declared)?.mediaType, "text/plain");
    assert.equal(resolve("readme.md", declared)?.mediaType, "text/markdown");
    assert.equal(resolve("rows.csv", declared)?.mediaType, "text/csv");
    assert.equal(resolve("data.json", declared)?.mediaType, "application/json");
    assert.equal(resolve("book.xlsx", declared)?.id, "xlsx");
    assert.equal(resolve("project.zip", declared)?.id, "zip");
  }
});

test("case and mixed case in the extension do not matter", () => {
  assert.equal(resolve("REPORT.PDF", "application/pdf")?.id, "pdf");
  assert.equal(resolve("Photo.JPG", "")?.mediaType, "image/jpeg");
  assert.equal(resolve("Deck.PpTx", "")?.id, "pptx");
});

test("a known alias for the same format is accepted and normalized away", () => {
  assert.equal(resolve("archive.zip", "application/x-zip-compressed")?.mediaType, "application/zip");
  assert.equal(resolve("page.xml", "text/xml")?.mediaType, "application/xml");
  assert.equal(resolve("app.js", "application/javascript")?.mediaType, "text/javascript");
  // Windows reports `.ts` as an MPEG transport stream; a real one still fails
  // the UTF decode later, so honouring the extension costs nothing.
  assert.equal(resolve("index.ts", "video/mp2t")?.mediaType, "text/x-typescript");
});

test("a text format survives the browser's generic text/plain guess", () => {
  assert.equal(resolve("main.py", "text/plain")?.mediaType, "text/x-python");
  assert.equal(resolve("build.yaml", "text/plain")?.mediaType, "application/yaml");
});

test("a name and a type that each name a different format is refused", () => {
  // Not resolved in either direction: trusting the extension lets a caller
  // rename into a parser, and trusting the type hides the file's shape.
  assert.equal(resolve("invoice.png", "application/pdf"), null);
  assert.equal(resolve("notes.txt", "image/png"), null);
  assert.equal(resolve("photo.jpg", "application/zip"), null);
});

test("a declared type alone is never enough", () => {
  // A file called `report` may well be a PDF, but nobody looking at the
  // composer has been told that.
  assert.equal(resolve("report", "application/pdf"), null);
  assert.equal(resolve("blob", "image/png"), null);
});

test("refused extensions are refused whatever type is claimed", () => {
  for (const name of ["tool.exe", "lib.so", "bundle.rar", "run.bat", "mod.wasm"]) {
    assert.equal(resolve(name, "text/plain"), null, name);
    assert.equal(resolve(name, "application/zip"), null, name);
    assert.equal(resolve(name, ""), null, name);
  }
});

test("the extensionless names a source tree is full of resolve as text", () => {
  assert.equal(resolve("Dockerfile", "")?.mediaType, "text/plain");
  assert.equal(resolve("app/Makefile", "")?.mediaType, "text/plain");
  assert.equal(resolve(".gitignore", "")?.mediaType, "text/plain");
});

test("kind follows the category, and only text is text", () => {
  for (const format of CHAT_ATTACHMENT_FORMATS) {
    assert.equal(
      attachmentKindForFormat(format),
      format.category === "text" ? "text" : "file",
      format.id
    );
  }
});

test("a GIF is described to the provider as the PNG it becomes", () => {
  const gif = formatByMediaType("image/gif");
  assert.equal(providerMediaTypeForFormat(gif), "image/png");
  assert.equal(providerMediaTypeForFormat(formatByMediaType("image/png")), "image/png");
  assert.equal(providerMediaTypeForFormat(formatByMediaType("application/pdf")), "application/pdf");
});

test("the formats this change was asked for are actually in the table", () => {
  const expected = {
    "project.zip": "application/zip",
    "still.gif": "image/gif",
    "rows.tsv": "text/tab-separated-values",
    "events.jsonl": "application/x-ndjson",
    "config.yml": "application/yaml",
    "feed.xml": "application/xml",
    "pyproject.toml": "application/toml",
    "settings.ini": "text/x-ini",
    "nginx.conf": "text/x-ini",
    "page.html": "text/html",
    "guide.rst": "text/x-rst",
    "subs.srt": "application/x-subrip",
    "subs.vtt": "text/vtt",
    "meeting.ics": "text/calendar",
    "card.vcf": "text/vcard",
    "main.py": "text/x-python",
    "app.tsx": "text/x-tsx",
    "Main.java": "text/x-java-source",
    "core.cpp": "text/x-c++src",
    "query.sql": "application/sql",
    "deploy.sh": "application/x-sh",
    "task.ps1": "application/x-powershell",
    "style.scss": "text/x-scss",
    "widget.vue": "text/x-vue",
    "schema.graphql": "application/graphql",
    "user.proto": "text/x-protobuf",
    // Office 97-2003 and RTF, read by lib/legacyOffice/**.
    "report.doc": "application/msword",
    "book.xls": "application/vnd.ms-excel",
    "deck.ppt": "application/vnd.ms-powerpoint",
    "letter.rtf": "application/rtf",
  };
  for (const [name, mediaType] of Object.entries(expected)) {
    assert.equal(resolve(name, "")?.mediaType, mediaType, name);
  }
});

test("the legacy Office formats are read, not merely listed", () => {
  // The rule this table is held to: an entry means the product can read the
  // file. These four waited until there was a parser behind them, and the
  // parser is `lib/legacyOffice/**`.
  for (const [name, id] of [
    ["report.doc", "doc"],
    ["book.xls", "xls"],
    ["deck.ppt", "ppt"],
    ["letter.rtf", "rtf"],
  ]) {
    const format = resolve(name, "");
    assert.equal(format?.id, id, name);
    assert.equal(format?.category, "legacy-office", name);
    assert.equal(format?.parser, "legacy-office-extractor", name);
    assert.equal(attachmentKindForFormat(format), "file", name);
    assert.equal(format?.guestAllowed, true, name);
    assert.equal(format?.allowedInArchive, true, name);
  }
  // A compound file is not the ZIP the OOXML path walks, so the two families
  // must not share a category.
  assert.equal(resolve("modern.docx", "")?.category, "office");
});

test("formats explicitly left out of this change stay out", () => {
  // Each of these needs a separate pipeline, not a row in a table.
  for (const name of [
    "scan.tiff",
    "photo.heic",
    "clip.mp4",
    "track.mp3",
    "deck.key",
    "art.psd",
  ]) {
    assert.equal(resolve(name, ""), null, name);
  }
});

test("every format lands in exactly one display group", () => {
  const groups = chatAttachmentExtensionsByGroup();
  const total = Object.values(groups).reduce((sum, list) => sum + list.length, 0);
  const declared = CHAT_ATTACHMENT_FORMATS.reduce(
    (sum, format) => sum + format.extensions.length,
    0
  );
  assert.equal(total, declared);
  assert.ok(groups.archive.includes("zip"));
  assert.ok(groups.image.includes("gif"));
  assert.ok(groups.code.includes("py"));
});

test("the extension reader ignores directories and dotfiles correctly", () => {
  assert.equal(attachmentFileExtension("a/b/c.tar.gz"), "gz");
  assert.equal(attachmentFileExtension("a\\b\\c.MD"), "md");
  assert.equal(attachmentFileExtension(".gitignore"), "");
  assert.equal(attachmentFileExtension("plain"), "");
});

// Windows serves `File.type` from the registry's `Content Type`, which names
// the application that owns the extension rather than the bytes. Word owning
// `.rtf` and Excel owning `.csv` made both refuse on the client, before the
// server saw anything -- found on staging 2026-08-23 through a real file
// picker. Walked from the table so a row cannot quietly lose its alias.
test("an extension owned by an Office application still resolves by name", () => {
    for (const { extension, declared, owner } of ASSOCIATION_OWNER_MEDIA_TYPES) {
        const format = resolveChatAttachmentFormat({
            filename: `report.${extension}`,
            declaredMediaType: declared,
        });
        assert.ok(
            format,
            `.${extension} announced as ${declared} (${owner} owns it) was refused`
        );
        assert.ok(
            format.extensions.includes(extension),
            `.${extension} announced as ${declared} resolved to ${format.id}`
        );
    }
});

// The alias must not become a way to attach the owner's own format under a
// name that says otherwise: the declared type is a hint, and the name leads.
test("the owning application's own extension is unaffected", () => {
    assert.equal(
        resolveChatAttachmentFormat({
            filename: "report.doc",
            declaredMediaType: "application/msword",
        })?.id,
        "doc"
    );
    assert.equal(
        resolveChatAttachmentFormat({
            filename: "report.xls",
            declaredMediaType: "application/vnd.ms-excel",
        })?.id,
        "xls"
    );
});
