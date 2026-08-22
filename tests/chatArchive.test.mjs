import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync, strToU8, zipSync } from "fflate";

import { ChatArchiveError, expandChatArchive } from "../lib/chatArchive.ts";
import { CHAT_ARCHIVE_ERROR_CODES as CODES } from "../lib/chatArchiveLimits.ts";

/**
 * The half of archive handling that actually costs CPU: inflating the entries
 * the plan chose, in a worker, and holding the stream to what the central
 * directory promised.
 *
 * The refusal matrix lives in `chatArchivePlan.test.mjs` -- everything here
 * needs a real inflate to be worth asserting.
 */

const u16 = (value) => [value & 0xff, (value >> 8) & 0xff];
const u32 = (value) => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 24) & 0xff,
];

/** One deflated entry whose directory sizes can disagree with its stream. */
const buildOneEntryZip = ({ name, body, declaredUncompressed }) => {
  const raw = strToU8(body);
  const deflated = deflateSync(raw);
  const nameBytes = [...Buffer.from(name, "utf8")];
  const uncompressed = declaredUncompressed ?? raw.length;

  const local = [
    ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(8),
    ...u16(0), ...u16(0), ...u32(0),
    ...u32(deflated.length), ...u32(uncompressed),
    ...u16(nameBytes.length), ...u16(0),
    ...nameBytes,
    ...deflated,
  ];
  const central = [
    ...u32(0x02014b50), ...u16(0x0014), ...u16(20),
    ...u16(0), ...u16(8), ...u16(0), ...u16(0), ...u32(0),
    ...u32(deflated.length), ...u32(uncompressed),
    ...u16(nameBytes.length), ...u16(0), ...u16(0),
    ...u16(0), ...u16(0), ...u32(0), ...u32(0),
    ...nameBytes,
  ];
  return Buffer.from([
    ...local,
    ...central,
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(1), ...u16(1),
    ...u32(central.length), ...u32(local.length),
    ...u16(0),
  ]);
};

const refuses = async (buffer, code, scope = "account") => {
  await assert.rejects(
    () => expandChatArchive(buffer, scope),
    (error) => {
      assert.ok(error instanceof ChatArchiveError, String(error));
      assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
      return true;
    }
  );
};

test("the chosen entries come back inflated, in plan order", async () => {
  const zip = Buffer.from(
    zipSync({
      "src/second.py": strToU8("print(2)\n"),
      "README.md": strToU8("# hello\n"),
      "src/first.css": strToU8("body { color: red }\n"),
      "skip/": new Uint8Array(0),
      "movie.mp4": strToU8("unsupported"),
    })
  );
  const expanded = await expandChatArchive(zip, "account");

  assert.deepEqual(
    expanded.files.map((file) => file.entry.path),
    ["README.md", "src/first.css", "src/second.py"]
  );
  assert.equal(expanded.files[0].bytes.toString("utf8"), "# hello\n");
  assert.equal(expanded.files[2].bytes.toString("utf8"), "print(2)\n");
  assert.equal(expanded.plan.exclusions["unsupported-format"], 1);
});

test("a Korean entry name round-trips through the second pass", async () => {
  // The plan decodes the directory as UTF-8; the streaming reader honours the
  // archive's own flag. Both spellings are matched, so the entry cannot go
  // missing between them.
  const zip = Buffer.from(
    zipSync({ "문서/분기 보고서.md": strToU8("# 안녕하세요\n") })
  );
  const expanded = await expandChatArchive(zip, "account");
  assert.equal(expanded.files.length, 1);
  assert.equal(expanded.files[0].entry.path, "문서/분기 보고서.md");
  assert.equal(expanded.files[0].bytes.toString("utf8"), "# 안녕하세요\n");
});

test("stored and deflated entries both inflate", async () => {
  // Varied enough that deflating it stays well inside the ratio guard: a
  // 4KB run of one character is itself a (very small) bomb.
  const body = Array.from({ length: 1_024 }, (_, index) =>
    String.fromCharCode(33 + ((index * 7) % 90))
  ).join("");
  const stored = Buffer.from(zipSync({ "a.txt": strToU8(body) }, { level: 0 }));
  const deflated = Buffer.from(zipSync({ "a.txt": strToU8(body) }, { level: 6 }));
  for (const zip of [stored, deflated]) {
    const expanded = await expandChatArchive(zip, "account");
    assert.equal(expanded.files[0].bytes.toString("utf8"), body);
  }
});

test("a stream that does not match the directory's size is refused", async () => {
  // The trick the directory-first design exists to catch: budgets were agreed
  // against the directory, so the stream is held to it.
  await refuses(
    buildOneEntryZip({
      name: "notes.txt",
      body: "the real contents are much longer than declared",
      declaredUncompressed: 4,
    }),
    CODES.sizeMismatch
  );
  await refuses(
    buildOneEntryZip({
      name: "notes.txt",
      body: "short",
      // Larger than the stream, but not so much larger that the ratio guard
      // refuses it first -- the point is the stream/directory disagreement.
      declaredUncompressed: 400,
    }),
    CODES.sizeMismatch
  );
});

test("a guest gets fewer files out of the same archive than an account does", async () => {
  const files = {};
  for (let index = 0; index < 12; index += 1) {
    files[`f${String(index).padStart(2, "0")}.txt`] = strToU8(`line ${index}\n`);
  }
  const zip = Buffer.from(zipSync(files));
  const account = await expandChatArchive(zip, "account");
  const guest = await expandChatArchive(zip, "guest");
  assert.equal(account.files.length, 12);
  assert.equal(guest.files.length, 5);
  // The guest's five are the first five by path, not an arbitrary five.
  assert.deepEqual(
    guest.files.map((file) => file.entry.path),
    ["f00.txt", "f01.txt", "f02.txt", "f03.txt", "f04.txt"]
  );
});

test("a refusal carries a code and never an entry path", async () => {
  const zip = Buffer.from(
    zipSync({ "keep.txt": strToU8("hi\n"), "secrets/id_rsa": strToU8("key\n") })
  );
  await assert.rejects(
    () => expandChatArchive(zip, "account"),
    (error) => {
      assert.equal(error.code, CODES.credentialEntry);
      assert.equal(error.message.includes("id_rsa"), false);
      assert.equal(error.message.includes("secrets"), false);
      return true;
    }
  );
});

test("nothing is written to disk", async () => {
  // The archive is expanded in worker memory, so there is no temporary
  // directory to clean up and Zip Slip has nowhere to land even before the
  // path checks run.
  const before = process.cwd();
  const zip = Buffer.from(zipSync({ "a/b/c.txt": strToU8("hi\n") }));
  const expanded = await expandChatArchive(zip, "account");
  assert.equal(expanded.files[0].bytes.toString("utf8"), "hi\n");
  assert.equal(process.cwd(), before);
});
