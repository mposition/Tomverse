import assert from "node:assert/strict";
import test from "node:test";

import { filenameFromContentDisposition } from "../lib/browserDownload.ts";

/**
 * The name a saved export lands on disk with.
 *
 * This mattered the moment the exports stopped navigating to their route. A
 * navigation let the browser read `Content-Disposition` itself; fetching the
 * response and clicking an `<a download>` means the page has to read it, and
 * whatever it gets wrong is what the visitor finds in their downloads folder.
 *
 * The header the conversation route sends carries the name twice -- an ASCII
 * `filename` any client understands, and RFC 5987's `filename*` for the real
 * one -- because a Korean title cannot survive the first field. Which of the
 * two wins, and what happens to a header that has neither, is what these fix.
 */

test("prefers the RFC 5987 field, which is the one that can carry the real name", () => {
  const header =
    "attachment; filename=\"conversation.txt\"; filename*=UTF-8''%ED%95%9C%EA%B8%80%20%EB%8C%80%ED%99%94.txt";
  assert.equal(filenameFromContentDisposition(header, "fallback.txt"), "한글 대화.txt");
});

test("falls back to the quoted name when there is no filename*", () => {
  assert.equal(
    filenameFromContentDisposition('attachment; filename="qa-conversation.txt"', "fallback.txt"),
    "qa-conversation.txt"
  );
});

test("a quoted name is taken literally, never percent-decoded", () => {
  // Guessing here would corrupt every name that legitimately contains a `%`,
  // and a quoted value is defined to be literal. The server says what it means
  // through `filename*`.
  assert.equal(
    filenameFromContentDisposition('attachment; filename="100%25 done.txt"', "fallback.txt"),
    "100%25 done.txt"
  );
});

test("an unquoted name is accepted, since the header does not require quotes", () => {
  assert.equal(
    filenameFromContentDisposition("attachment; filename=export.json", "fallback.json"),
    "export.json"
  );
});

test("a malformed filename* degrades to the other field rather than failing", () => {
  // `decodeURIComponent` throws on a lone `%`. A download is not worth losing
  // over a header this page did not write.
  assert.equal(
    filenameFromContentDisposition(
      "attachment; filename=\"safe.txt\"; filename*=UTF-8''%E0%A4%A",
      "fallback.txt"
    ),
    "safe.txt"
  );
});

test("no header, and no filename in it, both fall back to the caller's name", () => {
  assert.equal(filenameFromContentDisposition(null, "fallback.txt"), "fallback.txt");
  assert.equal(filenameFromContentDisposition("attachment", "fallback.txt"), "fallback.txt");
});
