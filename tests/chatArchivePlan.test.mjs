import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";

import {
  ChatArchivePlanError,
  planChatArchive,
  totalArchiveExclusions,
} from "../lib/chatArchivePlan.ts";
import {
  CHAT_ARCHIVE_ERROR_CODES as CODES,
  chatArchiveLimits,
} from "../lib/chatArchiveLimits.ts";

/**
 * Every refusal an uploaded ZIP can earn, decided from its central directory
 * before a byte is inflated.
 *
 * The hostile archives are built here, byte by byte, rather than committed as
 * fixtures: a decompression bomb is not something to keep in a repository,
 * and a hand-built directory is the only way to say "this entry claims a size
 * it does not have" at all.
 */

const ACCOUNT = chatArchiveLimits("account");
const GUEST = chatArchiveLimits("guest");

const u16 = (value) => [value & 0xff, (value >> 8) & 0xff];
const u32 = (value) => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 24) & 0xff,
];

/**
 * A ZIP built from field values rather than from content, so an entry can
 * declare anything -- including a size it does not have and a mode that says
 * "symlink".
 */
const buildRawZip = (entries, { entryCountOverride, extraTail = [] } = {}) => {
  const local = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = [...Buffer.from(entry.name, "utf8")];
    const data = [...(entry.data || [])];
    const method = entry.method ?? 0;
    const flags = entry.flags ?? 0;
    const compressed = entry.compressedSize ?? data.length;
    const uncompressed = entry.uncompressedSize ?? data.length;
    const versionMadeBy = entry.versionMadeBy ?? 0x0014;
    const externalAttributes = entry.externalAttributes ?? 0;

    const localHeader = [
      ...u32(0x04034b50), ...u16(20), ...u16(flags), ...u16(method),
      ...u16(0), ...u16(0), ...u32(0),
      ...u32(compressed), ...u32(uncompressed),
      ...u16(name.length), ...u16(0),
      ...name,
    ];
    central.push([
      ...u32(0x02014b50), ...u16(versionMadeBy), ...u16(20),
      ...u16(flags), ...u16(method), ...u16(0), ...u16(0), ...u32(0),
      ...u32(compressed), ...u32(uncompressed),
      ...u16(name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(externalAttributes),
      ...u32(offset),
      ...name,
    ]);
    local.push(...localHeader, ...data);
    offset += localHeader.length + data.length;
  }

  // `extraTail` sits between the central directory and the EOCD, which is
  // exactly where a ZIP64 locator lives.
  const directory = central.flat();
  const count = entryCountOverride ?? entries.length;
  return Uint8Array.from([
    ...local,
    ...directory,
    ...extraTail,
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(count), ...u16(count),
    ...u32(directory.length), ...u32(offset),
    ...u16(0),
  ]);
};

const refuses = (bytes, code, limits = ACCOUNT) =>
  assert.throws(
    () => planChatArchive(bytes, limits),
    (error) => {
      assert.ok(error instanceof ChatArchivePlanError, String(error));
      assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
      return true;
    }
  );

const textEntry = (name, body = "hello\n") => ({ name, data: [...strToU8(body)] });

// -- The ordinary case -------------------------------------------------------

test("a plain source archive selects its readable files in a stable order", () => {
  const zip = zipSync({
    "src/z_last.py": strToU8("print(1)\n"),
    "README.md": strToU8("# hi\n"),
    "src/a_first.ts": strToU8("export {}\n"),
    "docs/": new Uint8Array(0),
  });
  const plan = planChatArchive(zip, ACCOUNT);
  assert.deepEqual(
    plan.entries.map((entry) => entry.path),
    ["README.md", "src/a_first.ts", "src/z_last.py"]
  );
  assert.equal(plan.exclusions.directory, 1);
  assert.equal(plan.totalEntries, 4);
  // Sorted, so the same archive always produces the same document sequence.
  const again = planChatArchive(zip, ACCOUNT);
  assert.deepEqual(
    again.entries.map((entry) => entry.path),
    plan.entries.map((entry) => entry.path)
  );
});

test("Korean, spaced and Unicode entry names survive", () => {
  const zip = zipSync({
    "문서/분기 보고서.md": strToU8("# 안녕\n"),
    "notes/résumé final.txt": strToU8("ok\n"),
  });
  const plan = planChatArchive(zip, ACCOUNT);
  assert.deepEqual(
    plan.entries.map((entry) => entry.path).sort(),
    ["notes/résumé final.txt", "문서/분기 보고서.md"].sort()
  );
  // Both spellings a reader might produce are carried, so a name written
  // without the UTF-8 flag still matches on the second pass.
  const korean = plan.entries.find((entry) => entry.path.startsWith("문서/"));
  assert.ok(korean.matchNames.length >= 1);
  assert.ok(korean.matchNames.includes("문서/분기 보고서.md"));
});

test("unsupported entries are excluded, not fatal", () => {
  const zip = zipSync({
    "keep.md": strToU8("# hi\n"),
    "movie.mp4": strToU8("not really a movie"),
    "photo.heic": strToU8("nor an image"),
  });
  const plan = planChatArchive(zip, ACCOUNT);
  assert.deepEqual(plan.entries.map((entry) => entry.path), ["keep.md"]);
  assert.equal(plan.exclusions["unsupported-format"], 2);
  assert.equal(totalArchiveExclusions(plan.exclusions), 2);
});

test("a nested archive is skipped rather than opened, and does not fail the upload", () => {
  const zip = zipSync({
    "keep.txt": strToU8("hi\n"),
    "inner.zip": strToU8("PK-ish"),
    "old.tar": strToU8("tar-ish"),
  });
  const plan = planChatArchive(zip, ACCOUNT);
  assert.deepEqual(plan.entries.map((entry) => entry.path), ["keep.txt"]);
  assert.equal(plan.exclusions["nested-archive"], 2);
  assert.equal(ACCOUNT.maxNestedArchiveDepth, 0);
});

test("empty entries and directories are skipped without counting as exclusions", () => {
  const zip = zipSync({
    "keep.txt": strToU8("hi\n"),
    "empty.txt": new Uint8Array(0),
    "folder/": new Uint8Array(0),
  });
  const plan = planChatArchive(zip, ACCOUNT);
  assert.deepEqual(plan.entries.map((entry) => entry.path), ["keep.txt"]);
  assert.equal(plan.exclusions.empty, 1);
  assert.equal(plan.exclusions.directory, 1);
  // Neither is a file the person expected to be read, so the notice they see
  // does not count them.
  assert.equal(totalArchiveExclusions(plan.exclusions), 0);
});

test("an archive with nothing readable in it is refused", () => {
  refuses(
    zipSync({ "a.mp4": strToU8("x"), "b.heic": strToU8("y") }),
    CODES.noSupportedFiles
  );
  refuses(zipSync({ "only/": new Uint8Array(0) }), CODES.noSupportedFiles);
});

// -- Counts and sizes --------------------------------------------------------

test("the processed-file cap differs for guests and accounts", () => {
  const files = {};
  for (let index = 0; index < 30; index += 1) {
    files[`file-${String(index).padStart(2, "0")}.txt`] = strToU8("x\n");
  }
  const zip = zipSync(files);
  const account = planChatArchive(zip, ACCOUNT);
  assert.equal(account.entries.length, ACCOUNT.maxProcessedFiles);
  assert.equal(account.exclusions["beyond-file-limit"], 30 - ACCOUNT.maxProcessedFiles);
  // Deterministic: the first N by path, not the first N the directory listed.
  assert.equal(account.entries[0].path, "file-00.txt");

  const guest = planChatArchive(zip, GUEST);
  assert.equal(guest.entries.length, GUEST.maxProcessedFiles);
  assert.ok(GUEST.maxProcessedFiles < ACCOUNT.maxProcessedFiles);
});

test("too many entries refuses the archive outright", () => {
  const entries = [];
  for (let index = 0; index <= ACCOUNT.maxEntries; index += 1) {
    entries.push(textEntry(`f${index}.txt`, "x"));
  }
  refuses(buildRawZip(entries), CODES.tooManyEntries);
});

test("a single oversized entry is refused from its declared size", () => {
  refuses(
    buildRawZip([
      {
        name: "huge.txt",
        data: [...strToU8("x")],
        compressedSize: 1_000_000,
        uncompressedSize: ACCOUNT.maxEntryUncompressedBytes + 1,
      },
    ]),
    CODES.entryTooLarge
  );
});

test("the total uncompressed size is refused before anything is inflated", () => {
  const entries = [];
  for (let index = 0; index < 10; index += 1) {
    entries.push({
      name: `part-${index}.txt`,
      data: [...strToU8("x")],
      compressedSize: 1_000_000,
      uncompressedSize: 9_000_000,
    });
  }
  refuses(buildRawZip(entries), CODES.expansionTooLarge);
});

test("a decompression bomb is refused by its ratio", () => {
  refuses(
    buildRawZip([
      {
        name: "bomb.txt",
        data: [...strToU8("x")],
        compressedSize: 100,
        uncompressedSize: 1_000_000,
      },
    ]),
    CODES.compressionRatio
  );
  // Zero compressed bytes claiming real content is the same trick.
  refuses(
    buildRawZip([
      { name: "bomb2.txt", data: [], compressedSize: 0, uncompressedSize: 5_000 },
    ]),
    CODES.compressionRatio
  );
});

// -- Structure ---------------------------------------------------------------

test("an encrypted archive is refused by name", () => {
  refuses(buildRawZip([{ ...textEntry("secret.txt"), flags: 0x0001 }]), CODES.encrypted);
  refuses(buildRawZip([{ ...textEntry("secret.txt"), flags: 0x0040 }]), CODES.encrypted);
});

test("ZIP64 is refused by name rather than half-understood", () => {
  refuses(
    buildRawZip([
      {
        name: "big.txt",
        data: [...strToU8("x")],
        compressedSize: 0xffffffff,
        uncompressedSize: 1,
      },
    ]),
    CODES.zip64
  );
  // A ZIP64 locator immediately before the EOCD says the real counts live
  // somewhere this parser does not read.
  refuses(
    buildRawZip([textEntry("a.txt")], {
      // The locator is exactly 20 bytes: signature, disk, an 8-byte offset
      // and the total disk count.
      extraTail: [...u32(0x07064b50), ...u32(0), ...u32(0), ...u32(0), ...u32(1)],
    }),
    CODES.zip64
  );
});

test("a compression method other than store or deflate is refused", () => {
  for (const method of [12, 14, 93, 95, 98, 99]) {
    refuses(buildRawZip([{ ...textEntry("a.txt"), method }]), CODES.unsupportedCompression);
  }
});

test("a data descriptor is allowed, because the directory still has the sizes", () => {
  // Flag bit 3 zeroes the local header's sizes. Google Takeout sets it on
  // every entry; refusing it would refuse the archives that matter most.
  const plan = planChatArchive(
    buildRawZip([{ ...textEntry("notes.md", "# hi\n"), flags: 0x0008 }]),
    ACCOUNT
  );
  assert.deepEqual(plan.entries.map((entry) => entry.path), ["notes.md"]);
});

test("garbage and truncation are refused as corrupt", () => {
  refuses(Uint8Array.from(strToU8("this is not a zip at all, not even close")), CODES.corrupt);
  const zip = zipSync({ "a.txt": strToU8("hello") });
  refuses(zip.subarray(0, zip.length - 10), CODES.corrupt);
  refuses(new Uint8Array(4), CODES.corrupt);
});

test("an archive that declares no entries at all is refused", () => {
  refuses(buildRawZip([], { entryCountOverride: 0 }), CODES.noSupportedFiles);
});

// -- Paths -------------------------------------------------------------------

test("every shape of path escape is refused", () => {
  const unsafe = [
    "../escape.txt",
    "a/../../escape.txt",
    "/etc/passwd",
    "C:/Windows/system.ini",
    "C:notes.txt",
    "//server/share/notes.txt",
    "a\\..\\..\\escape.txt",
    "\\\\server\\share\\notes.txt",
  ];
  for (const name of unsafe) {
    refuses(buildRawZip([textEntry(name)]), CODES.unsafePath, ACCOUNT);
  }
});

test("a NUL in an entry name is refused", () => {
  refuses(
    buildRawZip([{ name: `notes${String.fromCharCode(0)}.txt`, data: [...strToU8("x")] }]),
    CODES.unsafePath
  );
});

test("an absurdly long path or segment is refused", () => {
  refuses(
    buildRawZip([textEntry(`${"a".repeat(ACCOUNT.maxEntryPathSegmentLength + 1)}.txt`)]),
    CODES.unsafePath
  );
  const deep = Array.from({ length: 300 }, () => "segment").join("/");
  refuses(buildRawZip([textEntry(`${deep}.txt`)]), CODES.unsafePath);
});

test("two entries that normalize to the same path are refused", () => {
  refuses(
    buildRawZip([textEntry("notes.txt"), textEntry("notes.txt")]),
    CODES.unsafePath
  );
  // Separator-folded: `a\b.txt` and `a/b.txt` are one file on the way out.
  refuses(
    buildRawZip([textEntry("a/b.txt"), textEntry("a\\b.txt")]),
    CODES.unsafePath
  );
  // Unicode-normalized: the two spellings of a precomposed character.
  refuses(
    buildRawZip([
      textEntry("résumé.txt".normalize("NFC")),
      textEntry("résumé.txt".normalize("NFD")),
    ]),
    CODES.unsafePath
  );
});

test("case-different names in a case-sensitive tree are still allowed", () => {
  // The duplicate check folds separators and Unicode, not case: refusing this
  // would refuse an ordinary source archive.
  const plan = planChatArchive(
    buildRawZip([textEntry("README.md"), textEntry("readme.md")]),
    ACCOUNT
  );
  assert.equal(plan.entries.length, 2);
});

test("a symlink entry is refused", () => {
  // Unix host, mode 0o120777: following it is the whole Zip Slip family in
  // one entry, and not following it stores bytes that lie about what they are.
  refuses(
    buildRawZip([
      {
        name: "link.txt",
        data: [...strToU8("/etc/passwd")],
        versionMadeBy: 0x0314,
        externalAttributes: 0xa1ff0000,
      },
    ]),
    CODES.unsafePath
  );
});

test("a directory entry that claims content is refused", () => {
  refuses(
    buildRawZip([
      { name: "folder/", data: [...strToU8("x")], uncompressedSize: 1 },
    ]),
    CODES.unsafePath
  );
});

// -- Dangerous contents ------------------------------------------------------

test("one program anywhere fails the whole archive", () => {
  for (const name of ["bin/tool.exe", "lib.dll", "setup.msi", "run.bat", "hook.cmd"]) {
    refuses(
      buildRawZip([textEntry("keep.txt"), textEntry(name)]),
      CODES.executableEntry
    );
  }
});

test("build output is skipped rather than fatal, because source trees ship it", () => {
  // A Gradle wrapper is a `.jar`, `node_modules` is full of `.node`, and a
  // Java tree has `.class` beside the `.java` files somebody wants read.
  // Failing the whole upload for them refuses the ordinary case.
  const plan = planChatArchive(
    buildRawZip([
      textEntry("src/Main.java", "class Main {}\n"),
      textEntry("gradle/wrapper/gradle-wrapper.jar"),
      textEntry("node_modules/sharp/build/sharp.node"),
      textEntry("build/Main.class"),
    ]),
    ACCOUNT
  );
  assert.deepEqual(plan.entries.map((entry) => entry.path), ["src/Main.java"]);
  assert.equal(plan.exclusions["unsupported-format"], 3);
  // Counted, so the person is told three files were left out rather than
  // discovering it from an answer.
  assert.equal(totalArchiveExclusions(plan.exclusions), 3);
});

test("one certificate or private key anywhere fails the whole archive", () => {
  for (const name of [
    "certs/server.pem",
    "keys/private.key",
    "id_rsa",
    "deploy/id_ed25519",
    "store.p12",
    ".netrc",
  ]) {
    refuses(
      buildRawZip([textEntry("keep.txt"), textEntry(name)]),
      CODES.credentialEntry,
      ACCOUNT
    );
  }
});

test("the archive container itself is bounded", () => {
  const oversized = new Uint8Array(GUEST.maxArchiveBytes + 1);
  oversized[0] = 0x50;
  oversized[1] = 0x4b;
  refuses(oversized, CODES.entryTooLarge, GUEST);
});
