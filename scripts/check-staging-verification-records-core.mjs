// The parts of the staging verification record check that are pure text.
//
// Split out so they can be tested without importing the checker, which runs its
// whole audit at import time. The line-ending handling below is the reason this
// file exists: it was wrong for as long as the check had existed and nobody
// could see it, because CI and every agent container check out LF.

import { createHash } from "node:crypto";

/**
 * The same document however git checked it out.
 *
 * Every read below was line-ending sensitive, and the failure was total rather
 * than partial: on a `core.autocrlf` checkout the front-matter regex matched
 * nothing at all -- `.` does not match `\r` and `$` does not sit before one --
 * so a fully filled record reported "no executor", "no result" and
 * "templateRevision (none)". The check ran correctly only on LF checkouts, and
 * said the records were blank on the platform most likely to be writing them.
 *
 * The digest matters more. It covers the body, so without this the same
 * committed bytes hash differently depending on the checkout, and a record
 * frozen on one machine reads as edited on another -- tamper evidence that
 * fires on `git clone`. Normalising to LF leaves every existing digest
 * unchanged, because they were computed where the checkout was already LF.
 */
export const normalizeLineEndings = (text) => text.replace(/\r\n?/g, "\n");

/** Everything after the front matter, which is what a digest covers. */
export const bodyOf = (raw) => {
  const text = normalizeLineEndings(raw);
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("---", 3);
  return end === -1 ? text : text.slice(end + 4);
};


export const frontMatter = (raw) => {
  const text = normalizeLineEndings(raw);
  const fields = new Map();
  if (!text.startsWith("---")) return fields;
  const end = text.indexOf("---", 3);
  if (end === -1) return fields;
  for (const line of text.slice(4, end).split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (match) fields.set(match[1], match[2].trim().replace(/^"|"$/g, ""));
  }
  return fields;
};

export const recordDigest = (text) =>
  createHash("sha256").update(bodyOf(text), "utf8").digest("hex").slice(0, 32);
