import { createHmac } from "node:crypto";
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  // The restricted Ubuntu CLI plan mounts a fixed /tmp checkout path. Do not
  // let a runner environment override relocate staged source outside it.
  const directory = await mkdtemp(join(process.platform === "linux" ? "/tmp" : tmpdir(),
    "amux-v19-checkout-"));
  const excluded: Array<{ path: string; reason: keyof AmuxPreparedTrackedCheckout["excludedReasons"] }> =
    [...manifest.excluded];
  const files: string[] = [];
  const contentOutcomes = new Map<string,
    { kind: "excluded"; reason: "secret_content" | "unscannable_content" } |
    { kind: "written"; destination: string }>();
  try {
    for (const file of manifest.files) {
      if (input.signal?.aborted) throw new AmuxTrackedCheckoutManifestError();
      const destination = resolve(directory, file.path);
      const within = relative(directory, destination);
      if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
        throw new AmuxTrackedCheckoutManifestError();
      }
      const prior = contentOutcomes.get(file.objectId);
      if (prior?.kind === "excluded") {
        excluded.push({ path: file.path, reason: prior.reason });
        continue;
      }
      if (prior?.kind === "written") {
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await link(prior.destination, destination);
        files.push(file.path);
        continue;
      }
      const bytes = await readAmuxPinnedTrackedBlob(
        input.repositoryPath, file.objectId, input.signal);
      try {
        let secret: boolean;
        try { secret = containsSecret(bytes); }
        catch {
          contentOutcomes.set(file.objectId,
            { kind: "excluded", reason: "unscannable_content" });
          excluded.push({ path: file.path, reason: "unscannable_content" });
          continue;
        }
        if (secret) {
          contentOutcomes.set(file.objectId,
            { kind: "excluded", reason: "secret_content" });
          excluded.push({ path: file.path, reason: "secret_content" });
          continue;
        }
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, bytes, { flag: "wx", mode: 0o400 });
        contentOutcomes.set(file.objectId, { kind: "written", destination });
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

/** Keep the staged source lifetime inside one analysis attempt. The CLI path
 * receives only the checkout directory; the callback must settle on stop so
 * success and failure both remove the checkout before returning. */
export async function withAmuxTrackedCheckout<T>(
  input: Parameters<typeof materializeAmuxTrackedCheckout>[0],
  run: (checkout: AmuxPreparedTrackedCheckout) => Promise<T>,
): Promise<T> {
  const checkout = await materializeAmuxTrackedCheckout(input);
  try {
    return await run(checkout);
  } finally {
    await rm(checkout.directory, { recursive: true, force: true });
  }
}

export type AmuxPreparedTrackedCheckouts = {
  directory: string;
  files: string[];
  references: Array<{ referenceOrdinal: number; commitSha: string;
    excludedCount: number; excludedPathDigest: string;
    excludedReasons: AmuxPreparedTrackedCheckout["excludedReasons"] }>;
};

/** Stage each immutable reference under its own directory in one scanned,
 * read-only CLI mount. No partial set is exposed to the model. */
export async function withAmuxTrackedCheckouts<T>(input: {
  references: Array<{ referenceOrdinal: number; repositoryPath: string;
    commitSha: string }>;
  digestSecret: string;
  signal?: AbortSignal;
}, run: (checkout: AmuxPreparedTrackedCheckouts) => Promise<T>): Promise<T> {
  if (!Array.isArray(input?.references) || input.references.length === 0 ||
      input.references.some((reference, index) =>
        reference?.referenceOrdinal !== index ||
        !Number.isSafeInteger(reference.referenceOrdinal) ||
        reference.referenceOrdinal > 2_147_483_647)) {
    throw new AmuxTrackedCheckoutManifestError();
  }
  const directory = await mkdtemp(join(process.platform === "linux" ? "/tmp" : tmpdir(),
    "amux-v19-checkout-"));
  const files: string[] = [];
  const references: AmuxPreparedTrackedCheckouts["references"] = [];
  try {
    for (const reference of input.references) {
      if (input.signal?.aborted) throw new AmuxTrackedCheckoutManifestError();
      const staged = await materializeAmuxTrackedCheckout({
        repositoryPath: reference.repositoryPath,
        commitSha: reference.commitSha,
        digestSecret: input.digestSecret, signal: input.signal,
      });
      try {
        const prefix = `reference-${reference.referenceOrdinal}`;
        const targetRoot = join(directory, prefix);
        await mkdir(targetRoot, { mode: 0o700 });
        for (const path of staged.files) {
          if (input.signal?.aborted) throw new AmuxTrackedCheckoutManifestError();
          const destination = join(targetRoot, path);
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          await link(join(staged.directory, path), destination);
          files.push(`${prefix}/${path}`);
        }
        references.push({ referenceOrdinal: reference.referenceOrdinal,
          commitSha: reference.commitSha,
          excludedCount: staged.excludedCount,
          excludedPathDigest: staged.excludedPathDigest,
          excludedReasons: staged.excludedReasons });
      } finally {
        await rm(staged.directory, { recursive: true, force: true });
      }
    }
    if (input.signal?.aborted) throw new AmuxTrackedCheckoutManifestError();
    const checkout: AmuxPreparedTrackedCheckouts = {
      directory, files, references,
    };
    return await run(checkout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
