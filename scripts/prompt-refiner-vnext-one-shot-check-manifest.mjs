// Owner-environment structural check only. Never prints the manifest, root,
// binding, case identifiers, or a parser exception. No seal or dispatch path.
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBenchmarkJson, strictBenchmarkObject } from
  "../lib/routerDevelopmentBenchmark.ts";
import { verifyPromptRefinerVnextOneShotManifestEnvelope } from
  "../lib/promptRefinerQualityEvaluationVnextOneShotManifestEnvelope.ts";

const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
const BINDING_MAX_BYTES = 1024;
const HEX = /^[0-9a-f]{64}$/;

function boundedRegularUtf8(path, maximum) {
  if (typeof path !== "string" || !path || lstatSync(path).isSymbolicLink()) {
    throw new Error("input_unavailable");
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > maximum) {
      throw new Error("input_unavailable");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("input_unavailable");
      offset += count;
    }
    const after = fstatSync(descriptor);
    const namedAfter = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs || !namedAfter.isFile() ||
        namedAfter.dev !== after.dev || namedAfter.ino !== after.ino ||
        namedAfter.size !== after.size || namedAfter.mtimeMs !== after.mtimeMs ||
        namedAfter.ctimeMs !== after.ctimeMs) {
      throw new Error("input_unavailable");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    closeSync(descriptor);
  }
}

function readBinding(path) {
  const parsed = parseBenchmarkJson(boundedRegularUtf8(path, BINDING_MAX_BYTES),
    BINDING_MAX_BYTES);
  const binding = strictBenchmarkObject(parsed,
    ["version", "expectedRootDigest", "expectedPreregistrationDigest"],
    "vnext_one_shot_binding");
  if (binding.version !== "prompt-refiner-vnext-one-shot-binding-v1" ||
      typeof binding.expectedRootDigest !== "string" ||
      !HEX.test(binding.expectedRootDigest) ||
      typeof binding.expectedPreregistrationDigest !== "string" ||
      !HEX.test(binding.expectedPreregistrationDigest)) {
    throw new Error("binding_invalid");
  }
  return binding;
}

export function checkManifestFiles(manifestPath, bindingPath,
  verify = verifyPromptRefinerVnextOneShotManifestEnvelope) {
  const binding = readBinding(bindingPath);
  const manifest = boundedRegularUtf8(manifestPath, MANIFEST_MAX_BYTES);
  verify(manifest, binding.expectedRootDigest, binding.expectedPreregistrationDigest);
  return Object.freeze({
    structuralValidation: "pass",
    caseCount: 80,
    semanticTruthVerified: false,
    independentAuthorshipVerified: false,
    privacyExclusionVerified: false,
    fullManifestValidated: false,
    dispatchAuthorized: false,
  });
}

function main(args) {
  if (args.length !== 4 || args[0] !== "--manifest" || args[2] !== "--binding" ||
      !args[1] || !args[3] || resolve(args[1]) === resolve(args[3])) {
    process.stderr.write("usage_invalid\n");
    return 2;
  }
  try {
    const result = checkManifestFiles(args[1], args[3]);
    process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  } catch {
    process.stderr.write("manifest_structure_invalid\n");
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
