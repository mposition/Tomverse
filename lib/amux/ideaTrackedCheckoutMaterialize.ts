import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ASSISTANT_PACKAGE_SECRET_RULES } from "../assistantPackageSecretScan.ts";
import { amuxV4RepositoryContainsSecret } from "./localIntakeCore.ts";
import { readAmuxPinnedTrackedBlob, readAmuxPinnedTrackedTree } from "./ideaTrackedCheckoutGit.ts";
import { AmuxTrackedCheckoutManifestError } from "./ideaTrackedCheckoutManifestCore.ts";

export type AmuxPreparedTrackedCheckout = {
  directory: string;
  files: string[];
  excludedCount: number;
  excludedPathDigest: string;
  excludedReasons: Record<"secret_path" | "secret_content" | "non_regular" | "unscannable_content", number>;
};

const DIGEST_DOMAIN = "amux-v19-checkout-excluded-paths-v1\n";

function containsSecret(bytes: Buffer): boolean {
  // The existing secret rules are ASCII shaped. Decode once, without a size
  // ceiling, and reject undecodable bytes before a model could interpret them otherwise.
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\0")) throw new TypeError("unscannable_content");
  return amuxV4RepositoryContainsSecret(text) ||
    ASSISTANT_PACKAGE_SECRET_RULES.some((rule) =>
      new RegExp(rule.pattern.source, rule.pattern.flags).test(text));
}

/** Stages only scanned bytes from immutable local Git objects. The returned
 * directory must be mounted read-only for CLI file tools and removed by the
 * caller after completion, stop or cancellation. No Git credential is copied. */
export async function materializeAmuxTrackedCheckout(input: {
  repositoryPath: string;
  commitSha: string;
  digestSecret: string;
  signal?: AbortSignal;
}): Promise<AmuxPreparedTrackedCheckout> {
  if (typeof input.digestSecret !== "string" ||
      Buffer.byteLength(input.digestSecret, "utf8") < 32) {
    throw new AmuxTrackedCheckoutManifestError();
  }
  const manifest = await readAmuxPinnedTrackedTree(input.repositoryPath, input.commitSha, input.signal);
  const directory = await mkdtemp(join(tmpdir(), "amux-v19-checkout-"));
  const excluded: Array<{ path: string; reason: keyof AmuxPreparedTrackedCheckout["excludedReasons"] }> =
    [...manifest.excluded];
  const files: string[] = [];
  try {
    for (const file of manifest.files) {
      if (input.signal?.aborted) throw new AmuxTrackedCheckoutManifestError();
      const bytes = await readAmuxPinnedTrackedBlob(
        input.repositoryPath, file.objectId, input.signal);
      try {
        let secret: boolean;
        try { secret = containsSecret(bytes); }
        catch { excluded.push({ path: file.path, reason: "unscannable_content" }); continue; }
        if (secret) {
          excluded.push({ path: file.path, reason: "secret_content" });
          continue;
        }
        const destination = resolve(directory, file.path);
        const within = relative(directory, destination);
        if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
          throw new AmuxTrackedCheckoutManifestError();
        }
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, bytes, { flag: "wx", mode: 0o400 });
        files.push(file.path);
      } finally { bytes.fill(0); }
    }
    const excludedReasons = {
      secret_path: 0, secret_content: 0, non_regular: 0, unscannable_content: 0,
    };
    const hmac = createHmac("sha256", input.digestSecret).update(DIGEST_DOMAIN);
    for (const entry of excluded.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
      excludedReasons[entry.reason] += 1;
      hmac.update(`${entry.reason}\0${entry.path}\n`, "utf8");
    }
    return {
      directory, files,
      excludedCount: excluded.length,
      excludedPathDigest: hmac.digest("hex"), excludedReasons,
    };
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new AmuxTrackedCheckoutManifestError();
  }
}
