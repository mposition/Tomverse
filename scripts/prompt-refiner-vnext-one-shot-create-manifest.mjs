// Owner-only offline assembly. Real case text never belongs in this repository,
// a log, a PR, or an app receipt. This tool does not seal or authorize dispatch.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, realpathSync, unlinkSync,
  writeSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalBenchmarkJson, parseBenchmarkJson, strictBenchmarkObject } from
  "../lib/routerDevelopmentBenchmark.ts";
import { verifyPromptRefinerVnextOneShotManifestEnvelope } from
  "../lib/promptRefinerQualityEvaluationVnextOneShotManifestEnvelope.ts";
import { boundedRegularUtf8 } from "./prompt-refiner-vnext-one-shot-check-manifest.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CASES_MAX_BYTES = 16 * 1024 * 1024;
const RECEIPT_MAX_BYTES = 2 * 1024;
const HEX_64 = /^[0-9a-f]{64}$/;
const PREREGISTRATION_BINDING_VERSION =
  "prompt-refiner-vnext-one-shot-preregistration-audit-id-v1";
const DRAFT_KEYS = [
  "language", "ordinal", "baseCell", "eligibleChallengeTag",
  "expectedDirection", "allowedAbstentionReasons", "sourceText",
  "challengeWitness", "rubric",
];

const withinRepository = (path) => {
  const relativePath = relative(realpathSync(REPOSITORY_ROOT), path);
  return !isAbsolute(relativePath) && (relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`)));
};

function caseIds(seedHex, language) {
  const seed = Buffer.from(seedHex, "hex");
  const ranked = Array.from({ length: 40 }, (_, index) => {
    const ordinal = index + 1;
    return { ordinal, digest: createHmac("sha256", seed)
      .update(`case-id-v1:${language}:${String(ordinal).padStart(3, "0")}`)
      .digest() };
  }).sort((a, b) => Buffer.compare(a.digest, b.digest));
  if (ranked.some((item, index) => index > 0 &&
      item.digest.equals(ranked[index - 1].digest))) {
    throw new Error("owner_case_id_collision");
  }
  return new Map(ranked.map((item, index) => [item.ordinal,
    `prsvnext-${language}-${String(index + 1).padStart(3, "0")}`]));
}

/** Pure assembly for synthetic tests; production CLI supplies a fresh seed.
 * The saved readback is not authenticated offline. Later server admission must
 * compare this digest against its own signed preregistration record.
 */
export function assembleOwnerManifest(casesText, receiptText, seedHex) {
  if (typeof seedHex !== "string" || !HEX_64.test(seedHex)) {
    throw new Error("owner_seed_invalid");
  }
  const receipt = strictBenchmarkObject(
    parseBenchmarkJson(receiptText, RECEIPT_MAX_BYTES), ["readback"],
    "owner_preregistration_receipt");
  const readback = strictBenchmarkObject(receipt.readback, [
    "preregistrationRecorded", "preregistrationAuditLogId",
    "currentPinsMatch", "dispatchAuthorized",
  ], "owner_preregistration_readback");
  if (readback.preregistrationRecorded !== true ||
      readback.currentPinsMatch !== true || readback.dispatchAuthorized !== false ||
      typeof readback.preregistrationAuditLogId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(readback.preregistrationAuditLogId)) {
    throw new Error("owner_preregistration_unavailable");
  }
  // This is a content-free identity commitment, not offline authentication.
  // An eventual server-owned admission must recompute it from the signed B01
  // audit record; this CLI cannot promote a saved readback to authority.
  const preregistrationDigest = createHash("sha256")
    .update(canonicalBenchmarkJson({
      version: PREREGISTRATION_BINDING_VERSION,
      auditLogId: readback.preregistrationAuditLogId,
    }), "utf8").digest("hex");
  const draft = strictBenchmarkObject(
    parseBenchmarkJson(casesText, CASES_MAX_BYTES), ["version", "cases"],
    "owner_cases");
  if (draft.version !== "prompt-refiner-vnext-one-shot-owner-cases-v1" ||
      !Array.isArray(draft.cases) || draft.cases.length !== 80) {
    throw new Error("owner_cases_invalid");
  }
  const ids = { ko: caseIds(seedHex, "ko"), en: caseIds(seedHex, "en") };
  const cases = draft.cases.map((value) => {
    const item = strictBenchmarkObject(value, DRAFT_KEYS, "owner_case");
    if ((item.language !== "ko" && item.language !== "en") ||
        !Number.isSafeInteger(item.ordinal) || item.ordinal < 1 || item.ordinal > 40) {
      throw new Error("owner_case_ordinal_invalid");
    }
    return { ...item, caseId: ids[item.language].get(item.ordinal) };
  }).sort((a, b) => (a.language === b.language ? a.ordinal - b.ordinal :
    a.language === "ko" ? -1 : 1));
  const unsigned = {
    version: "prompt-refiner-vnext-one-shot-manifest-v1",
    preregistrationDigest,
    seedHex, cases,
  };
  const rootDigest = createHash("sha256")
    .update(canonicalBenchmarkJson(unsigned), "utf8").digest("hex");
  const manifestText = JSON.stringify({ ...unsigned, rootDigest }) + "\n";
  const bindingText = JSON.stringify({
    version: "prompt-refiner-vnext-one-shot-binding-v1",
    expectedRootDigest: rootDigest,
    expectedPreregistrationDigest: preregistrationDigest,
  }) + "\n";
  // All 80 case structures, quotas, witnesses, rubrics, duplicates and root
  // must pass before any private file is created. The CLI cannot prove the
  // readback's provenance, semantic truth, authorship or privacy exclusion.
  verifyPromptRefinerVnextOneShotManifestEnvelope(manifestText, rootDigest,
    preregistrationDigest);
  return { manifestText, bindingText };
}

function ownerFilePath(path) {
  if (typeof path !== "string" || !path) throw new Error("owner_path_invalid");
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory() ||
      withinRepository(realpathSync(parent))) {
    throw new Error("owner_path_invalid");
  }
  return absolute;
}

function writeNewPrivateFile(path, text) {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    const bytes = Buffer.from(text, "utf8");
    let written = 0;
    while (written < bytes.length) written += writeSync(descriptor, bytes,
      written, bytes.length - written, written);
  } catch {
    closeSync(descriptor);
    unlinkSync(path);
    throw new Error("owner_output_unavailable");
  }
  try {
    closeSync(descriptor);
  } catch {
    unlinkSync(path);
    throw new Error("owner_output_unavailable");
  }
}

function main(args) {
  if (args.length !== 8 || args[0] !== "--cases" ||
      args[2] !== "--preregistration-readback" ||
      args[4] !== "--manifest-output" || args[6] !== "--binding-output") {
    throw new Error("owner_usage_invalid");
  }
  const [casesPath, receiptPath, manifestPath, bindingPath] =
    [args[1], args[3], args[5], args[7]].map(ownerFilePath);
  if (new Set([casesPath, receiptPath, manifestPath, bindingPath]).size !== 4 ||
      existsSync(manifestPath) || existsSync(bindingPath)) {
    throw new Error("owner_path_invalid");
  }
  const cases = boundedRegularUtf8(casesPath, CASES_MAX_BYTES);
  const receipt = boundedRegularUtf8(receiptPath, RECEIPT_MAX_BYTES);
  if (cases.dev === receipt.dev && cases.ino === receipt.ino) {
    throw new Error("owner_input_alias");
  }
  const { manifestText, bindingText } = assembleOwnerManifest(
    cases.text, receipt.text, randomBytes(32).toString("hex"));
  let manifestCreated = false;
  try {
    writeNewPrivateFile(manifestPath, manifestText);
    manifestCreated = true;
    writeNewPrivateFile(bindingPath, bindingText);
  } catch {
    if (manifestCreated) unlinkSync(manifestPath);
    throw new Error("owner_output_unavailable");
  }
  process.stdout.write(JSON.stringify({ created: true, caseCount: 80,
    preregistrationAuthenticityVerified: false,
    semanticTruthVerified: false, privacyExclusionVerified: false,
    fullManifestValidated: false,
    dispatchAuthorized: false }) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch { process.stderr.write("owner_manifest_generation_failed\n"); process.exitCode = 1; }
}
