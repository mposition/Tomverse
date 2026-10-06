/** Reviewed gate-source closure, separate from the pinned B01 runner bytes. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import source from "../docs/ops/prompt-refiner-quality-evaluation-vnext-one-shot-gate-source.json";
import { canonicalBenchmarkJson } from "./routerDevelopmentBenchmark";

export const PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_SOURCE_DIGEST =
  createHash("sha256").update(canonicalBenchmarkJson(source), "utf8").digest("hex");

/** Run in the owner checkout before scoring. No restricted input enters this check. */
export function verifyPromptRefinerVnextOneShotGateSource(projectRoot: string): void {
  if (source.version !== "prompt-refiner-vnext-one-shot-gate-source-v1" ||
      Object.keys(source.files).length < 10) {
    throw new Error("vnext_one_shot_gate_source_invalid");
  }
  for (const [relative, expected] of Object.entries(source.files)) {
    if (!/^(?:lib|scripts|docs\/ops)\/[a-zA-Z0-9/.-]+$/.test(relative) ||
        relative.split("/").some((part) => part === "." || part === ".." || !part) ||
        !/^[0-9a-f]{64}$/.test(expected)) {
      throw new Error("vnext_one_shot_gate_source_invalid");
    }
    const actual = createHash("sha256")
      .update(readFileSync(resolve(projectRoot, relative))).digest("hex");
    if (actual !== expected) {
      throw new Error("vnext_one_shot_gate_source_invalid");
    }
  }
}
