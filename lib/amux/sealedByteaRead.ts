import "server-only";

import type { PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * Reads one sealed v22 body in slices (docs/policy/amux-v22-result-transfer.md
 * 2.7, the 3-B step of the owner decision of 2026-11-18).
 *
 * Measured on 2026-11-18 against PostgreSQL 17 with node-pg 8 and Prisma 7.10
 * (adapter-pg), random bytes from 1 MiB to 600 MiB: a bytea comes back in
 * text form, `\x` and two hex characters a byte, and pg-protocol turns the
 * whole field into one JavaScript string before the type parser sees it. Up
 * to 255 MiB that works through node-pg and through Prisma alike. At 257 MiB
 * the string passes V8's limit (0x1fffffe8 characters) and pg-protocol throws
 * ERR_STRING_TOO_LONG inside the socket's data handler: not a rejected query
 * but an uncaught exception that ends the process. Past 512 MiB the server
 * cannot build the text at all. A slice of 64 MiB is a 128 MiB string, well
 * inside both, and `substring` on an uncompressed out-of-line value fetches
 * only the slice's TOAST chunks. A Prisma `create` returns the row it wrote,
 * so a large one names a `select` without its body. Writes have their own
 * external bound: node-pg sends a Buffer as a binary parameter (600 MiB
 * written), but Prisma hands a Bytes value to it as one base64 string, which
 * held 300 MiB and refused 420 MiB (AMUX_V22_PRISMA_BYTES_WRITE_MAX_BYTES).
 *
 * The rows read here are immutable but for the retention purge clearing the
 * body, so the slices are read outside any transaction: a slice that comes
 * back NULL means the body was purged while it was read.
 */
export const AMUX_SEALED_BYTEA_SLICE_BYTES = 64 * 1024 * 1024;

export type AmuxSealedByteaSource = "task_result" | "task_patch" | "task_changed_paths";

type Db = Pick<PrismaClient, "$queryRaw">;
type Sized = Array<{ bytes: number | null }>;
type Sliced = Array<{ slice: Uint8Array | null }>;

// One fixed statement per table: no identifier is ever composed.
const sizeOf = (db: Db, source: AmuxSealedByteaSource, attemptId: string) =>
  source === "task_result" ? db.$queryRaw<Sized>`
    SELECT octet_length("ciphertext") AS "bytes" FROM "AmuxV22TaskResult"
    WHERE "attemptId" = ${attemptId}` :
  source === "task_patch" ? db.$queryRaw<Sized>`
    SELECT octet_length("ciphertext") AS "bytes" FROM "AmuxV22TaskPatch"
    WHERE "attemptId" = ${attemptId}` :
  db.$queryRaw<Sized>`
    SELECT octet_length("ciphertext") AS "bytes" FROM "AmuxV22TaskChangedPaths"
    WHERE "attemptId" = ${attemptId}`;

const sliceOf = (db: Db, source: AmuxSealedByteaSource, attemptId: string,
  start: number, length: number) =>
  source === "task_result" ? db.$queryRaw<Sliced>`
    SELECT substring("ciphertext" FROM ${start}::int FOR ${length}::int) AS "slice"
    FROM "AmuxV22TaskResult" WHERE "attemptId" = ${attemptId}` :
  source === "task_patch" ? db.$queryRaw<Sliced>`
    SELECT substring("ciphertext" FROM ${start}::int FOR ${length}::int) AS "slice"
    FROM "AmuxV22TaskPatch" WHERE "attemptId" = ${attemptId}` :
  db.$queryRaw<Sliced>`
    SELECT substring("ciphertext" FROM ${start}::int FOR ${length}::int) AS "slice"
    FROM "AmuxV22TaskChangedPaths" WHERE "attemptId" = ${attemptId}`;

/** The ciphertext of one attempt's row, or null when there is none (no row,
 * or its body purged before or during the read). */
export async function readAmuxSealedBytea(source: AmuxSealedByteaSource,
  attemptId: string, db: Db = prisma,
  sliceBytes: number = AMUX_SEALED_BYTEA_SLICE_BYTES): Promise<Buffer | null> {
  if (!Number.isSafeInteger(sliceBytes) || sliceBytes < 1 ||
      sliceBytes > AMUX_SEALED_BYTEA_SLICE_BYTES) throw new RangeError("invalid slice size");
  const sized = await sizeOf(db, source, attemptId);
  const total = sized[0]?.bytes;
  if (total === null || total === undefined) return null;
  const out = Buffer.allocUnsafe(total);
  let complete = false;
  try {
    for (let offset = 0; offset < total; offset += sliceBytes) {
      const length = Math.min(sliceBytes, total - offset);
      const rows = await sliceOf(db, source, attemptId, offset + 1, length);
      const slice = rows[0]?.slice;
      if (!slice) return null;
      if (slice.length !== length) throw new Error("AMUX sealed body changed while read");
      out.set(slice, offset);
    }
    complete = true;
    return out;
  } finally { if (!complete) out.fill(0); }
}
