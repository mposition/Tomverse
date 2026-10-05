// Restricted owner operation. Result, manifest and audit files never leave this process.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { verifyPromptRefinerVnextOneShotOwnerSeal } from
  "../lib/promptRefinerVnextOneShotOwnerSeal.ts";
import { scorePromptRefinerVnextOneShotOwnerGate } from
  "../lib/promptRefinerVnextOneShotOwnerGate.ts";
import { signPromptRefinerVnextOneShotGateAttestation } from
  "../lib/promptRefinerVnextOneShotGateAttestation.ts";
import { PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_SOURCE_DIGEST,
  verifyPromptRefinerVnextOneShotGateSource } from
  "../lib/promptRefinerVnextOneShotGateSource.ts";
import { parseBenchmarkJson } from "../lib/routerDevelopmentBenchmark.ts";
import { boundedRegularUtf8, readBinding } from
  "./prompt-refiner-vnext-one-shot-check-manifest.mjs";

const refuse = () => { throw new Error("owner_gate_unavailable"); };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

export function createPromptRefinerVnextOneShotOwnerGateAttestation(input) {
  const { manifestPath, bindingPath, sealPath, resultsPath, auditsPath,
    targetPath, ownerKeyHex, signingPrivateKeyB64, now = new Date() } = input ?? {};
  const paths = [manifestPath, bindingPath, sealPath, resultsPath, auditsPath,
    targetPath];
  if (!paths.every((path) => typeof path === "string" && path.length > 0) ||
      new Set(paths.map((path) => resolve(path))).size !== paths.length ||
      !/^(?:[0-9a-f]{2}){32,64}$/.test(ownerKeyHex ?? "") ||
      typeof signingPrivateKeyB64 !== "string" ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) return refuse();
  try {
    verifyPromptRefinerVnextOneShotGateSource(resolve(import.meta.dirname, ".."));
    const binding = readBinding(bindingPath);
    const files = [binding,
      boundedRegularUtf8(manifestPath, 16 * 1024 * 1024),
      boundedRegularUtf8(sealPath, 2048),
      boundedRegularUtf8(resultsPath, 2 * 1024 * 1024),
      boundedRegularUtf8(auditsPath, 64 * 1024),
      boundedRegularUtf8(targetPath, 2048)];
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        if (sameFile(files[i], files[j])) return refuse();
      }
    }
    verifyPromptRefinerVnextOneShotOwnerSeal({
      manifestText: files[1].text, attestationText: files[2].text,
      expectedRootDigest: binding.binding.expectedRootDigest,
      expectedPreregistrationDigest: binding.binding.expectedPreregistrationDigest,
      ownerHmacKey: Buffer.from(ownerKeyHex, "hex"), now,
    });
    const evaluated = scorePromptRefinerVnextOneShotOwnerGate({
      manifestText: files[1].text,
      expectedRootDigest: binding.binding.expectedRootDigest,
      expectedPreregistrationDigest: binding.binding.expectedPreregistrationDigest,
      results: parseBenchmarkJson(files[3].text, 2 * 1024 * 1024),
      audits: parseBenchmarkJson(files[4].text, 64 * 1024),
    });
    const target = parseBenchmarkJson(files[5].text, 2048);
    if (!target || typeof target !== "object" || Array.isArray(target) ||
        Object.keys(target).sort().join(",") !== [
          "runApprovalAuditLogId", "runtimeDeploymentId",
          "shadowAuditLogId", "stageApprovalAuditLogId",
        ].sort().join(",")) return refuse();
    return signPromptRefinerVnextOneShotGateAttestation({
      version: "prompt-refiner-vnext-one-shot-gate-attestation-v1",
      ...target, gateSourceDigest: PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_SOURCE_DIGEST,
      slotBindingDigest: evaluated.slotBindingDigest,
      signedAt: now.toISOString(), summary: evaluated.summary,
    }, signingPrivateKeyB64);
  } catch {
    // Do not echo paths, restricted content, roots, outputs, or parser errors.
    return refuse();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 8) refuse();
    const result = createPromptRefinerVnextOneShotOwnerGateAttestation({
      manifestPath: process.argv[2], bindingPath: process.argv[3],
      sealPath: process.argv[4], resultsPath: process.argv[5],
      auditsPath: process.argv[6], targetPath: process.argv[7],
      ownerKeyHex: process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_OWNER_SEAL_KEY_HEX,
      signingPrivateKeyB64:
        process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_PRIVATE_KEY_B64,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("owner_gate_unavailable\n");
    process.exitCode = 1;
  }
}
