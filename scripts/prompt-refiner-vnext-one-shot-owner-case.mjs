// Restricted owner-runner input boundary. Never import this into an app route:
// the returned source text must remain in mposition's owner environment.
import { resolve } from "node:path";

import { verifyPromptRefinerVnextOneShotOwnerSeal } from
  "../lib/promptRefinerVnextOneShotOwnerSeal.ts";
import { parseBenchmarkJson } from "../lib/routerDevelopmentBenchmark.ts";
import { boundedRegularUtf8, readBinding } from
  "./prompt-refiner-vnext-one-shot-check-manifest.mjs";

const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
const SEAL_MAX_BYTES = 2048;
const OWNER_KEY = /^(?:[0-9a-f]{2}){32,64}$/;

const refuse = () => { throw new Error("owner_case_unavailable"); };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

/**
 * Re-read and rehash all 80 cases, the owner seal and the preregistration
 * binding for each intended slot. This only selects local input; stage/run
 * approval, server reservation and provider dispatch are separate gates.
 */
export function readVerifiedPromptRefinerVnextOneShotOwnerCase(input) {
  const { manifestPath, bindingPath, sealPath, ownerKeyHex, slotIndex,
    now = new Date() } = input ?? {};
  if (![manifestPath, bindingPath, sealPath].every((path) =>
    typeof path === "string" && path.length > 0) ||
    new Set([manifestPath, bindingPath, sealPath]
      .map((path) => resolve(path))).size !== 3 ||
    !OWNER_KEY.test(ownerKeyHex ?? "") ||
    !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= 80 ||
    !(now instanceof Date) || !Number.isFinite(now.getTime())) return refuse();

  try {
    const binding = readBinding(bindingPath);
    const manifest = boundedRegularUtf8(manifestPath, MANIFEST_MAX_BYTES);
    const seal = boundedRegularUtf8(sealPath, SEAL_MAX_BYTES);
    if (sameFile(binding, manifest) || sameFile(binding, seal) ||
        sameFile(manifest, seal)) return refuse();
    verifyPromptRefinerVnextOneShotOwnerSeal({
      manifestText: manifest.text,
      attestationText: seal.text,
      expectedRootDigest: binding.binding.expectedRootDigest,
      expectedPreregistrationDigest: binding.binding.expectedPreregistrationDigest,
      ownerHmacKey: Buffer.from(ownerKeyHex, "hex"), now,
    });
    const parsed = parseBenchmarkJson(manifest.text, MANIFEST_MAX_BYTES);
    const language = slotIndex < 40 ? "ko" : "en";
    const ordinal = slotIndex % 40 + 1;
    const caseId = `prsvnext-${language}-${String(ordinal).padStart(3, "0")}`;
    const matches = parsed.cases.filter((item) => item.caseId === caseId);
    if (matches.length !== 1 || matches[0].language !== language ||
        typeof matches[0].sourceText !== "string") return refuse();
    return Object.freeze({
      caseId, language, sourceText: matches[0].sourceText,
      manifestRoot: binding.binding.expectedRootDigest,
      dispatchAuthorized: false,
    });
  } catch {
    // Never include a parser error, path, root, case data, or digest in output.
    return refuse();
  }
}
