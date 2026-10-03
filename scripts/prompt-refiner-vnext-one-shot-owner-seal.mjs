// Run only in mposition's restricted owner environment. The seal file contains
// the root and is never an app receipt, PR artifact, or dispatch permission.
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPromptRefinerVnextOneShotOwnerSeal,
  verifyPromptRefinerVnextOneShotOwnerSeal } from
  "../lib/promptRefinerVnextOneShotOwnerSeal.ts";
import { boundedRegularUtf8, checkManifestFiles, readBinding } from
  "./prompt-refiner-vnext-one-shot-check-manifest.mjs";

const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
const OWNER_KEY = /^(?:[0-9a-f]{2}){32,64}$/;
const CONFIRMATION = "I_AM_MPOSITION_AND_VERIFIED_EVERY_LABEL_AND_PRIVACY_EXCLUSION";

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
  let descriptor;
  try {
    // Exclusive creation prevents replacing any existing owner-held seal.
    // The owner must use a separately access-controlled directory; mode alone
    // is not an OS-independent custody boundary (notably on Windows).
    descriptor = openSync(outputPath, "wx", 0o600);
    writeSync(descriptor, attestationText + "\n");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  verifyPromptRefinerVnextOneShotOwnerSeal({
    manifestText,
    attestationText: readFileSync(outputPath, "utf8"),
    expectedRootDigest: binding.expectedRootDigest,
    expectedPreregistrationDigest: binding.expectedPreregistrationDigest,
    ownerHmacKey, now,
  });
  return Object.freeze({ sealed: true, caseCount: 80, dispatchAuthorized: false });
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
  } catch {
    process.stderr.write("owner_seal_unavailable\n");
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
