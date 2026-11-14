/**
 * The digest a pull request's change is bound and approved by: sha256 of the
 * diff GitHub serves for it (`GET /repos/{o}/{r}/pulls/{n}` with
 * `Accept: application/vnd.github.diff`), over the bytes as they came. The
 * engineering agent's read (lib/engineeringAgentGitHubRead.ts) binds and
 * re-reads a pull request with it, and the QA-release merge lane computes the
 * same digest right before it asks the app to let a Decision Maker approved
 * pull request merge (lib/qaReleaseMergeLaneGithub.ts): one function, so the
 * two can never disagree on what "the same diff" means.
 *
 * Pure and dependency-free beyond node:crypto, so the lane service loads it
 * with `node --experimental-strip-types`.
 */
import { createHash } from "node:crypto";

/** The largest diff either side digests; a larger one is not read, and so never approved or merged on a digest. */
export const PULL_DIFF_DIGEST_MAX_BYTES = 1024 * 1024;

/** sha256 hex of a diff's bytes; text is taken as its UTF-8 bytes. */
export const pullDiffDigest = (diff: Uint8Array | string): string =>
  createHash("sha256").update(typeof diff === "string" ? Buffer.from(diff, "utf8") : diff).digest("hex");
