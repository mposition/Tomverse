// Restricted owner operation. The proof file contains the root and must stay
// in owner custody until it is submitted to the owner-only app route.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync,
  writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyPromptRefinerVnextOneShotOwnerSeal } from
  "../lib/promptRefinerVnextOneShotOwnerSeal.ts";
import {
  PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT,
  PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT_DIGEST,
  promptRefinerVnextOneShotShadowTargetSchema,
  signPromptRefinerVnextOneShotShadowProof,
} from "../lib/promptRefinerVnextOneShotShadowProof.ts";
import { canonicalBenchmarkJson, parseBenchmarkJson } from
  "../lib/routerDevelopmentBenchmark.ts";
import { boundedRegularUtf8, readBinding } from
  "./prompt-refiner-vnext-one-shot-check-manifest.mjs";

const CODE_ROOT = resolve(import.meta.dirname, "..");
const OWNER_KEY = /^(?:[0-9a-f]{2}){32,64}$/;
const FORBIDDEN_ENV = /(?:^|_)DATABASE_(?:[A-Z0-9]+_)*URL$|(?:^|_)DIRECT_URL(?:_|$)|^POSTGRES(?:_|$)|^PG(?:HOST|USER|PASSWORD|DATABASE|PORT|PASSFILE|SERVICEFILE)$|^DB_(?:HOST|USER|PASSWORD|DATABASE|PORT)$|(?:^|_)API_KEY$/i;
const refuse = () => { throw new Error("owner_shadow_proof_unavailable"); };

const fingerprint = (path) => {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0n ||
      stat.size > 32n * 1024n * 1024n) return refuse();
  // Windows file IDs can exceed Number.MAX_SAFE_INTEGER. Decimal strings keep
  // the before/after identity comparison exact in the canonical JSON check.
  return Object.freeze({ dev: stat.dev.toString(), ino: stat.ino.toString(),
    size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString() });
};

/** No app call, provider call, or slot consumption occurs in this function. */
export function createPromptRefinerVnextOneShotOwnerShadowProof(input) {
  const { manifestPath, bindingPath, sealPath, targetPath, runnerPath,
    ownerKeyHex, signingPrivateKeyB64, now = new Date(),
    env = process.env, spawn = spawnSync } = input ?? {};
  const paths = [manifestPath, bindingPath, sealPath, targetPath, runnerPath];
  if (!paths.every((path) => typeof path === "string" && path.length > 0) ||
      new Set(paths.map((path) => resolve(path))).size !== paths.length ||
      !OWNER_KEY.test(ownerKeyHex ?? "") ||
      typeof signingPrivateKeyB64 !== "string" ||
      !(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !env || typeof env !== "object" ||
      Object.entries(env).some(([key, value]) =>
        FORBIDDEN_ENV.test(key) && typeof value === "string" && value.length > 0)) {
    return refuse();
  }
  try {
    const target = promptRefinerVnextOneShotShadowTargetSchema.parse(
      parseBenchmarkJson(boundedRegularUtf8(targetPath, 2048).text, 2048));
    const runnerBefore = fingerprint(runnerPath);
    if (createHash("sha256").update(readFileSync(runnerPath)).digest("hex") !==
        target.runnerDigest) return refuse();

    const bindingBefore = readBinding(bindingPath);
    const manifestBefore = boundedRegularUtf8(manifestPath, 16 * 1024 * 1024);
    const sealBefore = boundedRegularUtf8(sealPath, 2048);
    verifyPromptRefinerVnextOneShotOwnerSeal({
      manifestText: manifestBefore.text, attestationText: sealBefore.text,
      expectedRootDigest: bindingBefore.binding.expectedRootDigest,
      expectedPreregistrationDigest:
        bindingBefore.binding.expectedPreregistrationDigest,
      ownerHmacKey: Buffer.from(ownerKeyHex, "hex"), now,
    });

    // The exact A17 executable does the 80 per-case sealed-root rehashes and
    // rejects any missing/non-integer/nonzero cache-write observation.
    const result = spawn(process.execPath,
      ["--conditions=react-server", resolve(runnerPath),
        "--manifest", resolve(manifestPath), "--binding", resolve(bindingPath),
        "--seal", resolve(sealPath)], {
        cwd: dirname(resolve(runnerPath)), encoding: "utf8", timeout: 300_000,
        maxBuffer: 2048,
        env: { PATH: env.PATH, SystemRoot: env.SystemRoot,
          PROMPT_REFINER_VNEXT_ONE_SHOT_OWNER_SEAL_KEY_HEX: ownerKeyHex },
      });
    if (result.error || result.status !== 0 || result.signal || result.stderr !== "" ||
        typeof result.stdout !== "string" ||
        Buffer.byteLength(result.stdout, "utf8") > 1024 ||
        canonicalBenchmarkJson(parseBenchmarkJson(result.stdout, 1024)) !==
          canonicalBenchmarkJson(PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT)) {
      return refuse();
    }
    if (canonicalBenchmarkJson(fingerprint(runnerPath)) !==
        canonicalBenchmarkJson(runnerBefore) ||
        createHash("sha256").update(readFileSync(runnerPath)).digest("hex") !==
          target.runnerDigest) return refuse();
    const bindingAfter = readBinding(bindingPath);
    const manifestAfter = boundedRegularUtf8(manifestPath, 16 * 1024 * 1024);
    const sealAfter = boundedRegularUtf8(sealPath, 2048);
    if (canonicalBenchmarkJson(bindingBefore.binding) !==
          canonicalBenchmarkJson(bindingAfter.binding) ||
        manifestBefore.text !== manifestAfter.text ||
        sealBefore.text !== sealAfter.text) return refuse();

    return signPromptRefinerVnextOneShotShadowProof({
      version: "prompt-refiner-vnext-one-shot-shadow-proof-v1",
      ...target, manifestRoot: bindingAfter.binding.expectedRootDigest,
      runnerPreflightDigest:
        PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT_DIGEST,
      cacheWriteInputTokens: 0, providerCalls: 0, slotConsumeCalls: 0,
      // The seal is checked at entry; the signed observation is made only
      // after the exact A17 runner has finished its 80 explicit zero checks.
      signedAt: new Date().toISOString(),
    }, signingPrivateKeyB64);
  } catch {
    // Never echo paths, root, manifest, case IDs, model-shaped output or keys.
    return refuse();
  }
}

function main(args) {
  if (args.length !== 12 || args[0] !== "--manifest" ||
      args[2] !== "--binding" || args[4] !== "--seal" ||
      args[6] !== "--target" || args[8] !== "--runner" ||
      args[10] !== "--proof-output") return refuse();
  const output = resolve(args[11]);
  if (output === CODE_ROOT || output.startsWith(`${CODE_ROOT}${sep}`) ||
      [args[1], args[3], args[5], args[7], args[9]]
        .some((path) => resolve(path) === output)) return refuse();
  const proof = createPromptRefinerVnextOneShotOwnerShadowProof({
    manifestPath: args[1], bindingPath: args[3], sealPath: args[5],
    targetPath: args[7], runnerPath: args[9],
    ownerKeyHex: process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_OWNER_SEAL_KEY_HEX,
    signingPrivateKeyB64:
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_PRIVATE_KEY_B64,
  });
  const descriptor = openSync(output,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify(proof) + "\n", { encoding: "utf8" });
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  process.stdout.write('{"status":"shadow_proof_written","dispatchAuthorized":false}\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch {
    process.stderr.write("owner_shadow_proof_unavailable\n");
    process.exitCode = 1;
  }
}
