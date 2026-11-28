import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { z } from "zod";
import { cliProvider, type CliProvider } from "../code-execution";
import { fileStamp, isLocalPath, localReadFlags } from "./provider-cli-path";

// A file that does not match a pinned release can still be used when the person says they trust that exact file. The
// record holds the file's real path, size and SHA-256. Any change to the file ends the trust, and the person is asked again.

export const cliTrustRecord = z.object({
  path: z.string().min(1).max(4096),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type CliTrustRecord = z.infer<typeof cliTrustRecord>;

/** Stored once for each account: the trusted files and whether the first-run offer was answered. */
export const cliTrustFile = z.object({
  offered: z.boolean().optional(),
  trusted: z.partialRecord(cliProvider, cliTrustRecord).optional(),
}).strict();
export type CliTrustFile = z.infer<typeof cliTrustFile>;

type Hashed = { target: string; size: number; sha256: string; stamp: string };

/** Reads the whole file once through one handle and checks that nothing replaced or changed it meanwhile. */
export async function hashCliFile(selected: string, signal?: AbortSignal): Promise<Hashed | null> {
  if (!isLocalPath(selected)) return null;
  const target = await realpath(selected);
  if (!isLocalPath(target)) return null;
  const before = await lstat(target);
  if (!before.isFile()) return null;
  const file = await open(target, localReadFlags);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return null;
    const hash = createHash("sha256");
    if (opened.size > 0) {
      for await (const chunk of file.createReadStream({ start: 0, end: opened.size - 1, autoClose: false })) {
        signal?.throwIfAborted();
        hash.update(chunk);
      }
    }
    const stamp = fileStamp(opened);
    if (fileStamp(await lstat(target)) !== stamp || await realpath(selected) !== target) return null;
    return { target, size: opened.size, sha256: hash.digest("hex"), stamp };
  } finally {
    await file.close();
  }
}

/** The record to store for the file at this path, or null when the file could not be read consistently. */
export async function trustRecordFor(selected: string, signal?: AbortSignal): Promise<{ record: CliTrustRecord; fileStamp: string } | null> {
  try {
    const hashed = await hashCliFile(selected, signal);
    return hashed ? { record: { path: hashed.target, size: hashed.size, sha256: hashed.sha256 }, fileStamp: hashed.stamp } : null;
  } catch {
    return null;
  }
}

/** The trusted file when the file at this path is still exactly the one that was trusted, otherwise null. */
export async function trustedCliFile(selected: string, record: CliTrustRecord | undefined, signal?: AbortSignal): Promise<{ file: string; fileStamp: string } | null> {
  if (!record) return null;
  try {
    const current = await realpath(selected);
    if (current !== record.path) return null;
    // The size is cheap to compare, so only a file of the trusted size is read.
    if ((await lstat(current)).size !== record.size) return null;
    const hashed = await hashCliFile(selected, signal);
    return hashed && hashed.target === record.path && hashed.size === record.size && hashed.sha256 === record.sha256
      ? { file: hashed.target, fileStamp: hashed.stamp } : null;
  } catch {
    return null;
  }
}

export function withTrust(file: CliTrustFile, provider: CliProvider, record: CliTrustRecord): CliTrustFile {
  return { ...file, trusted: { ...file.trusted, [provider]: record } };
}

export function withoutTrust(file: CliTrustFile, provider: CliProvider): CliTrustFile {
  const trusted = { ...file.trusted };
  delete trusted[provider];
  return { ...file, trusted };
}
