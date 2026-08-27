/**
 * One answer bundle, shared by the sampling and the sheet tests.
 *
 * Shared rather than copied because both suites assert against the same cell
 * structure and the same 14-adopted-items-per-cell shape the set was frozen
 * with. Two drifting copies would let one suite pass against a population the
 * other no longer describes.
 */

import { ANSWER_BUNDLE_VERSION, sha256 } from "../lib/routerAnswerBundle.ts";

export const CELLS = [
    ["general_question_answering", "ko"], ["general_question_answering", "en"],
    ["writing_and_rewriting", "ko"], ["writing_and_rewriting", "en"],
    ["coding", "ko"], ["coding", "en"],
    ["analysis_and_reasoning", "ko"], ["analysis_and_reasoning", "en"],
    ["translation_cross_language", "ko-en"],
    ["current_information", "ko"], ["current_information", "en"],
    ["document_and_attachment", "ko"], ["document_and_attachment", "en"],
    ["long_context_conversation", "ko"], ["long_context_conversation", "en"],
];

export const ROUTABLE_MODEL_IDS = ["deepseek-v4-flash", "gpt-5-6-luna", "claude-opus-4-8"];

export const side = (arm, text) => ({
    arm,
    modelId: arm === "auto" ? "deepseek-v4-flash" : "gpt-5-6-luna",
    provider: arm === "auto" ? "deepseek" : "openai",
    apiModel: arm === "auto" ? "deepseek-v4-flash" : "gpt-5.6-luna",
    text,
    digest: sha256(text),
});

// The frozen set holds 14 adopted items per cell, which is what makes an equal
// draw of four represent the whole development set without weighting.
export const bundle = (perCell = 14) => ({
    header: {
        kind: "header",
        bundleVersion: ANSWER_BUNDLE_VERSION,
        mode: "pilot",
        evaluationSetVersion: "router-eval-development-v0",
        evaluationSetPurpose: "development",
        plannedItems: 210,
        commitSha: "0".repeat(40),
        seed: 20260826,
        judgeTemplateVersion: "judge-rubric-v1",
        createdAt: "2026-08-27T02:41:16.553Z",
    },
    entries: CELLS.flatMap(([stratum, cell]) =>
        Array.from({ length: perCell }, (unused, index) => ({
            kind: "pair",
            pairId: `${stratum}-${cell}-${index + 1}`,
            stratum,
            cell,
            prompt: `question ${stratum} ${cell} ${index + 1}`,
            first: side("auto", `first answer for ${stratum} ${cell} ${index + 1}`),
            second: side("baseline", `second answer for ${stratum} ${cell} ${index + 1}`),
        }))
    ),
});
