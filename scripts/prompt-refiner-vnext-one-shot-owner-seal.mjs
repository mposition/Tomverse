// Run only in mposition's restricted owner environment. The seal file contains
// the root and is never an app receipt, PR artifact, or dispatch permission.
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync,
  writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPromptRefinerVnextOneShotOwnerSeal,
  verifyPromptRefinerVnextOneShotOwnerSeal } from
  "../lib/promptRefinerVnextOneShotOwnerSeal.ts";
import { boundedRegularUtf8, checkManifestFiles, readBinding } from
  "./prompt-refiner-vnext-one-shot-check-manifest.mjs";

const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
const OWNER_KEY = /^(?:[0-9a-f]{2}){32,64}$/;
const CONFIRMATION = "I_AM_MPOSITION_AND_VERIFIED_EVERY_LABEL_AND_PRIVACY_EXCLUSION";
export const OWNER_SEAL_CLEANUP_UNKNOWN = "owner_seal_cleanup_unknown";

export function sealOwnerManifestFiles(input) {
  const { manifestPath, bindingPath, outputPath, ownerKeyHex, confirmation,
    now = new Date() } = input ?? {};
  if (typeof manifestPath !== "string" || typeof bindingPath !== "string" ||
      typeof outputPath !== "string" || !manifestPath || !bindingPath ||
      !outputPath || new Set([manifestPath, bindingPath, outputPath]
        .map((path) => resolve(path))).size !== 3 ||
      !OWNER_KEY.test(ownerKeyHex ?? "") || confirmation !== CONFIRMATION) {
    throw new Error("owner_seal_unavailable");
  }
  // Read-only structural validation is repeated after the owner's explicit
  // confirmation, then the signed attestation binds the exact re-read bytes.
  checkManifestFiles(manifestPath, bindingPath);
  const manifestText = boundedRegularUtf8(manifestPath, MANIFEST_MAX_BYTES).text;
  const binding = readBinding(bindingPath).binding;
  const ownerHmacKey = Buffer.from(ownerKeyHex, "hex");
  const attestationText = createPromptRefinerVnextOneShotOwnerSeal({
    manifestText,
    expectedRootDigest: binding.expectedRootDigest,
    expectedPreregistrationDigest: binding.expectedPreregistrationDigest,
    ownerHmacKey, now, confirmation,
  });
  const tempPath = join(dirname(outputPath), `.${basename(outputPath)}.${randomUUID()}.tmp`);
  let descriptor;
  let tempCreated = false;
  let operationError;
  try {
    // Write and verify a fresh sibling before an atomic no-overwrite hardlink.
    // The owner must use a separately access-controlled directory; mode alone
    // is not an OS-independent custody boundary (notably on Windows).
    descriptor = openSync(tempPath, "wx", 0o600);
    tempCreated = true;
    const bytes = Buffer.from(attestationText + "\n", "utf8");
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(descriptor, bytes, written, bytes.length - written);
      if (count <= 0) throw new Error("owner_seal_write_incomplete");
      written += count;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    verifyPromptRefinerVnextOneShotOwnerSeal({
      manifestText,
      attestationText: readFileSync(tempPath, "utf8"),
      expectedRootDigest: binding.expectedRootDigest,
      expectedPreregistrationDigest: binding.expectedPreregistrationDigest,
      ownerHmacKey, now,
    });
    linkSync(tempPath, outputPath);
  } catch (error) {
    operationError = error;
  } finally {
    const cleanupErrors = [];
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch (error) { cleanupErrors.push(error); }
    }
    if (tempCreated) {
      try { unlinkSync(tempPath); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) {
      throw new AggregateError(
        operationError ? [operationError, ...cleanupErrors] : cleanupErrors,
        OWNER_SEAL_CLEANUP_UNKNOWN);
    }
  }
  if (operationError) throw operationError;
  return Object.freeze({ sealed: true, caseCount: 80, dispatchAuthorized: false });
}

export function ownerSealFailureCode(error) {
  return error instanceof AggregateError &&
    error.message === OWNER_SEAL_CLEANUP_UNKNOWN
    ? OWNER_SEAL_CLEANUP_UNKNOWN : "owner_seal_unavailable";
}

function main(args) {
  if (args.length !== 8 || args[0] !== "--manifest" ||
      args[2] !== "--binding" || args[4] !== "--seal-output" ||
      args[6] !== "--confirm") {
    process.stderr.write("usage_invalid\n");
    return 2;
  }
  try {
    const result = sealOwnerManifestFiles({
      manifestPath: args[1], bindingPath: args[3], outputPath: args[5],
      confirmation: args[7],
      ownerKeyHex: process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_OWNER_SEAL_KEY_HEX,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  } catch (error) {
    // The destination may already exist after a cleanup failure. Stop and have
    // the owner inspect the restricted directory; never retry the seal blindly.
    process.stderr.write(`${ownerSealFailureCode(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
