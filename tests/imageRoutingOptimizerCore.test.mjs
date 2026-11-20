import assert from "node:assert/strict";
import test from "node:test";
import {
    IMAGE_INTENT_MIN_EVAL_CASES,
    admitImageCriteria,
    admitImageCriteriaReport,
    admitImageIntentCases,
    imageCriteriaGeneratorMessage,
    imageCycleGate,
    imageCyclePromotable,
    modelChoiceAgreement,
    scoreImageIntent,
    splitImageIntentCases,
} from "../lib/imageRoutingOptimizerCore.ts";
import { CHAT_IMAGE_ROUTING_CRITERIA, buildChatImageIntentSystem } from "../lib/chatImageIntentCore.ts";
import { AUTO_LLM_ROUTER_GUIDANCE_KINDS } from "../lib/autoLlmRouterCore.ts";
import { scheduledOptimizerTarget } from "../lib/autoRewriteOptimizerCore.ts";
import { summarizeImageRouting } from "../lib/imageRoutingReportCore.ts";
import { IMAGE_GENERATION_SIGNAL_KINDS, IMAGE_ROUTING_DECISION_OUTCOMES, IMAGE_ROUTING_DECISION_SOURCES } from "../lib/imageRoutingCore.ts";

/**
 * The image routing improvement agent (owner decision 2026-11-20): the
 * criteria Chat's image routing follows become an optimizer target, measured
 * on labelled messages and, with its own switch, on real images.
 */

test("image is a fourth guidance kind, and the live criteria are injectable", () => {
    assert.deepEqual([...AUTO_LLM_ROUTER_GUIDANCE_KINDS], ["routing", "rewrite", "coding", "image"]);
    assert.ok(buildChatImageIntentSystem().includes(CHAT_IMAGE_ROUTING_CRITERIA), "the default criteria");
    const custom = "image=true for pictures.\nimage=false otherwise.";
    const system = buildChatImageIntentSystem({ criteria: custom });
    assert.ok(system.includes(custom));
    assert.ok(!system.includes(CHAT_IMAGE_ROUTING_CRITERIA), "a promoted criteria replaces the default");
    assert.deepEqual([...IMAGE_ROUTING_DECISION_SOURCES], ["auto_chat", "composer"]);
    assert.deepEqual([...IMAGE_ROUTING_DECISION_OUTCOMES], ["image", "chat", "error"]);
    assert.ok(IMAGE_GENERATION_SIGNAL_KINDS.includes("wanted_text"));
});

test("the daily run takes image in turn with the other targets", () => {
    const pick = (last, image = true) =>
        scheduledOptimizerTarget({ routingDaily: false, rewriteDaily: false, codingDaily: true, imageDaily: image, lastSystemTarget: last });
    assert.equal(pick(null), "coding");
    assert.equal(pick("coding"), "image");
    assert.equal(pick("image"), "coding");
    assert.equal(pick("coding", false), "coding");
});

test("labelled messages are admitted only when well formed", () => {
    const admitted = admitImageIntentCases(
        {
            cases: [
                { text: "고양이 수채화 그려줘", expectImage: true, kind: "clear" },
                { text: "고양이 수채화 그려줘", expectImage: true, kind: "clear" },
                { text: "이 SVG 코드 고쳐줘", expectImage: false, kind: "near_miss" },
                { text: "", expectImage: false, kind: "clear" },
                { text: "x".repeat(600), expectImage: false, kind: "clear" },
                { text: "draw a logo", expectImage: "yes", kind: "clear" },
                { text: "maybe a picture", expectImage: false, kind: "other" },
            ],
        },
        10
    );
    assert.deepEqual(admitted.map((item) => item.text), ["고양이 수채화 그려줘", "이 SVG 코드 고쳐줘"]);
    assert.deepEqual(admitImageIntentCases(null, 5), []);
    const { train, evaluate } = splitImageIntentCases([1, 2, 3, 4, 5]);
    assert.deepEqual(train, [1, 3, 5]);
    assert.deepEqual(evaluate, [2, 4]);
});

test("scoring counts a text request sent to an image apart from a missed image", () => {
    const cases = [
        { text: "a", expectImage: true, kind: "clear" },
        { text: "b", expectImage: false, kind: "near_miss" },
        { text: "c", expectImage: false, kind: "near_miss" },
        { text: "d", expectImage: true, kind: "clear" },
    ];
    assert.deepEqual(scoreImageIntent(cases, [{ image: true }, { image: true }, { image: false }, null]), {
        cases: 4,
        correct: 2,
        falseImage: 1,
        missedImage: 1,
        failed: 1,
    });
});

test("a proposal must be a complete criteria and different from the current one", () => {
    const valid = `${CHAT_IMAGE_ROUTING_CRITERIA}\n- prefer a model whose note fits text-heavy posters.`;
    assert.equal(admitImageCriteria(valid, CHAT_IMAGE_ROUTING_CRITERIA), valid);
    assert.equal(admitImageCriteria(CHAT_IMAGE_ROUTING_CRITERIA, CHAT_IMAGE_ROUTING_CRITERIA), null, "unchanged");
    assert.equal(admitImageCriteria("image=true always.", CHAT_IMAGE_ROUTING_CRITERIA), null, "incomplete");
    assert.equal(admitImageCriteria(valid.replace("When unsure, answer image=false", "When unsure, draw"), CHAT_IMAGE_ROUTING_CRITERIA), null, "the safe default stays");
    assert.equal(admitImageCriteria(`${valid}\n${"x".repeat(7_000)}`, CHAT_IMAGE_ROUTING_CRITERIA), null, "too long");
    assert.equal(admitImageCriteria(42, CHAT_IMAGE_ROUTING_CRITERIA), null);
    const report = admitImageCriteriaReport({ findings: ["a", "", 3], recommendations: [{ kind: "code", text: "b" }, { kind: "other", text: "c" }] });
    assert.deepEqual(report, { findings: ["a"], recommendations: [{ kind: "code", text: "b" }] });
});

test("the generator reads errors and evidence, bounded, never the evaluation half", () => {
    const message = JSON.parse(
        imageCriteriaGeneratorMessage({
            criteria: "c",
            errors: [{ text: "x".repeat(1_000), expectImage: false, answeredImage: true, kind: "near_miss" }],
            modelEvaluation: { models: [] },
            liveReport: null,
        })
    );
    assert.match(message.evidenceScope, /withheld/);
    assert.equal(message.errors[0].message.length, 300);
    assert.equal(message.errors[0].correct, "text");
    assert.equal(message.errors[0].answered, "image");
});

const score = (correct, falseImage, cases = IMAGE_INTENT_MIN_EVAL_CASES) => ({ cases, correct, falseImage, missedImage: 0, failed: 0 });
const none = { judged: 0, agreed: 0 };

test("the gate: no worse on accuracy, no more false images, and something better", () => {
    const base = {
        costComplete: true,
        budgetExhausted: false,
        candidate: "c",
        incumbentScore: score(7, 1),
        candidateScore: score(8, 1),
        incumbentAgreement: none,
        candidateAgreement: none,
    };
    assert.equal(imageCycleGate(base), null, "more correct");
    assert.equal(imageCycleGate({ ...base, costComplete: false }), "cost_unknown");
    assert.equal(imageCycleGate({ ...base, budgetExhausted: true }), "budget_exhausted");
    assert.equal(imageCycleGate({ ...base, candidate: null }), "candidate_invalid");
    assert.equal(imageCycleGate({ ...base, incumbentScore: score(7, 1, 4) }), "too_few_cases");
    assert.equal(imageCycleGate({ ...base, candidateScore: score(6, 0) }), "accuracy_below");
    assert.equal(imageCycleGate({ ...base, candidateScore: score(8, 2) }), "false_images_above");
    assert.equal(imageCycleGate({ ...base, candidateScore: score(7, 1) }), "no_improvement");
    assert.equal(
        imageCycleGate({ ...base, candidateScore: score(7, 1), incumbentAgreement: { judged: 6, agreed: 2 }, candidateAgreement: { judged: 6, agreed: 4 } }),
        null,
        "better model choice at equal accuracy"
    );
    assert.deepEqual(modelChoiceAgreement(["a", null, "b", "c"], ["a", "x", "x", "c"]), { judged: 3, agreed: 2 });
    assert.equal(imageCyclePromotable({ status: "passed", candidateGuidance: "c", summary: { costComplete: true } }), true);
    assert.equal(imageCyclePromotable({ status: "passed", candidateGuidance: "c", summary: { costComplete: false } }), false);
    assert.equal(imageCyclePromotable({ status: "failed", candidateGuidance: "c", summary: { costComplete: true } }), false);
});

test("the image routing report counts decisions, outcomes per model and what people did", () => {
    const at = (seconds) => new Date(Date.UTC(2026, 10, 20, 0, 0, seconds));
    const report = summarizeImageRouting(
        [
            { source: "auto_chat", outcome: "image", imageModelId: "gpt-image-2", preset: "standard", edit: false, followUp: false, modelFallback: false, linked: true },
            { source: "auto_chat", outcome: "image", imageModelId: null, preset: null, edit: false, followUp: true, modelFallback: true, linked: false },
            { source: "composer", outcome: "chat", imageModelId: null, preset: null, edit: false, followUp: false, modelFallback: false, linked: false },
            { source: "auto_chat", outcome: "error", imageModelId: null, preset: null, edit: false, followUp: false, modelFallback: false, linked: false },
        ],
        [
            { modelId: "gpt-image-2", preset: "standard", status: "succeeded", failurePhase: null, attemptNumber: 1, startedAt: at(0), completedAt: at(10), costMicroUsd: 53_000, signals: ["download", "helpful"] },
            { modelId: "gpt-image-2", preset: "standard", status: "succeeded", failurePhase: null, attemptNumber: 2, startedAt: at(0), completedAt: at(20), costMicroUsd: 53_000, signals: ["not_helpful", "wanted_text"] },
            { modelId: "gpt-image-2", preset: "standard", status: "failed", failurePhase: "provider_failed", attemptNumber: 1, startedAt: at(0), completedAt: null, costMicroUsd: null, signals: [] },
            { modelId: "flux-3-image", preset: "standard", status: "succeeded", failurePhase: null, attemptNumber: 1, startedAt: at(0), completedAt: at(5), costMicroUsd: 48_000, signals: [] },
        ],
        { since: at(0), until: at(60) }
    );
    assert.equal(report.decisions.total, 4);
    assert.deepEqual(report.decisions.byOutcome, { image: 2, chat: 1, error: 1 });
    assert.deepEqual(report.decisions.bySource, { auto_chat: 3, composer: 1 });
    assert.equal(report.decisions.fallbackShare, 0.5);
    assert.equal(report.decisions.linkedShare, 0.5);
    const gpt = report.models.find((row) => row.modelId === "gpt-image-2");
    assert.equal(gpt.generations, 3);
    assert.equal(gpt.failureShare, 0.333);
    assert.deepEqual(gpt.failurePhases, { provider_failed: 1 });
    assert.equal(gpt.retries, 1);
    assert.deepEqual(gpt.latencySeconds, { p50: 10, p90: 20 });
    assert.equal(gpt.costPerSuccessMicroUsd, 53_000);
    assert.equal(gpt.helpfulShare, 0.5);
    assert.equal(report.wantedText, 1);
    assert.equal(report.models[0].modelId, "gpt-image-2", "most generations first");
});
