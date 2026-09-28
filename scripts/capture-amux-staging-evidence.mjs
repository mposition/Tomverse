import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { captureAmuxStagingEvidence } from "../lib/amux/stagingEvidence.ts";
import { prisma } from "../lib/prisma.ts";

const outputFlag = process.argv.indexOf("--output");
const output = outputFlag === -1 ? null : process.argv[outputFlag + 1];
if (outputFlag !== -1 && (!output || output.startsWith("--"))) {
  throw new Error("--output requires a file path");
}
const shaFlag = process.argv.indexOf("--expected-deploy-sha");
const expectedDeploySha = shaFlag === -1 ? null : process.argv[shaFlag + 1];
if (!expectedDeploySha || expectedDeploySha.startsWith("--")) {
  throw new Error("--expected-deploy-sha requires the full 40-character SHA");
}

const knownArguments = new Set([
  "--output",
  output,
  "--expected-deploy-sha",
  expectedDeploySha,
]);
for (const argument of process.argv.slice(2)) {
  if (!knownArguments.has(argument)) throw new Error(`Unknown argument: ${argument}`);
}

try {
  const evidence = await captureAmuxStagingEvidence(expectedDeploySha);
  const rendered = `${JSON.stringify(evidence, null, 2)}\n`;
  if (!output) {
    process.stdout.write(rendered);
  } else {
    const target = resolve(output);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, rendered, { encoding: "utf8", flag: "wx" });
    process.stdout.write(
      `${JSON.stringify({ written: target, stable_state_digest_sha256: evidence.stable_state_digest_sha256, observation_digest_sha256: evidence.observation_digest_sha256 })}\n`,
    );
  }
} finally {
  await prisma.$disconnect();
}
