/**
 * The answer bundle: what two judges have to see the same of.
 *
 * ## Why this exists
 *
 * The pilot's journal recorded a verdict per pair and nothing else, so the
 * only way to ask a second judge about the same answers was to generate them
 * again. Regenerated answers are different answers, and a difference between
 * two judges measured over two different sets of answers is not a difference
 * between the judges.
 *
 * A bundle is written once by the run that pays for the answers. Every later
 * judging pass reads it and calls only the judge. That is what makes the
 * comparison paired: same prompt, same two answers, same display order, same
 * rubric — so the only thing that varies between passes is who graded.
 *
 * ## Canonical identity, not the internal id
 *
 * Each side records `provider` and `apiModel` beside the Tomverse `modelId`,
 * because the two can disagree. `claude-opus-4-8` in this catalogue calls
 * Anthropic's `claude-opus-5`; a check that compared internal ids would call
 * that model independent of a run whose answers it wrote. `canonicalIdentity`
 * is what a judge is compared against.
 *
 * ## What is in the file
 *
 * The fixtures this harness runs are the repository's own synthetic prompts
 * (docs/ops/tomverse-chat-router-evaluation-set.md §8), so a bundle holds no
 * user content. A bundle built from anything else would, and would need
 * handling this module does not provide.
 */

import { createHash } from "node:crypto";

export const ANSWER_BUNDLE_VERSION = "router-answer-bundle-v1";

/** What a request actually reached, as opposed to what this repository calls it. */
export type ModelIdentity = {
    /** The Tomverse catalogue id. Stable across API-model upgrades. */
    modelId: string;
    provider: string;
    /** The identifier sent to the provider. */
    apiModel: string;
};

/**
 * Provider and API model, joined. Two entries are the same model when this
 * matches, whatever the catalogue calls them.
 */
export const canonicalIdentity = (identity: ModelIdentity): string =>
    `${identity.provider}/${identity.apiModel}`;

export const sha256 = (value: string): string =>
    `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

/** One of the two answers a judge is shown, in the position it is shown in. */
export type BundledAnswer = ModelIdentity & {
    /** Which arm produced it. A judge never sees this. */
    arm: "auto" | "baseline";
    text: string;
    /** Of `text`, so a later pass can prove it graded the same words. */
    digest: string;
};

export type AnswerBundleHeader = {
    kind: "header";
    bundleVersion: typeof ANSWER_BUNDLE_VERSION;
    /** The run that generated the answers. */
    mode: string;
    evaluationSetVersion: string;
    /**
     * Which set the answers came from.
     *
     * Carried here so a later pass can tell a development bundle from a
     * decision one without holding the set: calibrating a judge on the
     * decision set would spend one of its uses
     * (docs/ops/tomverse-chat-router-evaluation-set.md §7).
     */
    evaluationSetPurpose: string;
    /**
     * How many items the run set out to cover.
     *
     * Written with the header, before anything ran, so a bundle that stopped
     * early is one whose entry count falls short of it. Nothing can be added
     * to a header after the fact, and a run that dies at its cost ceiling is
     * exactly the run that would not get the chance.
     */
    plannedItems: number;
    commitSha: string | null;
    /** The seed that fixed the display order, so a rejudge cannot reorder. */
    seed: number;
    judgeTemplateVersion: string;
    createdAt: string;
};

export type AnswerBundleEntry = {
    kind: "pair";
    pairId: string;
    stratum: string;
    cell: string;
    prompt: string;
    /** Fixed here, not at judging time: order effects must not vary by pass. */
    first: BundledAnswer;
    second: BundledAnswer;
};

export type AnswerBundle = {
    header: AnswerBundleHeader;
    entries: readonly AnswerBundleEntry[];
};

const isNonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.trim() !== "";

const answerProblems = (side: unknown, where: string): string[] => {
    const problems: string[] = [];
    const answer = side as Partial<BundledAnswer> | null;
    if (!answer || typeof answer !== "object") return [`${where} is missing`];
    for (const field of ["modelId", "provider", "apiModel", "text", "digest"] as const) {
        if (!isNonEmptyString(answer[field])) problems.push(`${where} has no ${field}`);
    }
    if (answer.arm !== "auto" && answer.arm !== "baseline") {
        problems.push(`${where} has no arm`);
    }
    // The digest is the whole point of recording one: a bundle whose text and
    // digest disagree cannot prove a later pass graded the same words.
    if (isNonEmptyString(answer.text) && isNonEmptyString(answer.digest)) {
        const actual = sha256(answer.text);
        if (actual !== answer.digest) {
            problems.push(`${where} digest does not match its text`);
        }
    }
    return problems;
};

/** Everything wrong with a bundle, as sentences. Empty means it can be judged. */
export const answerBundleProblems = (bundle: AnswerBundle): readonly string[] => {
    const problems: string[] = [];
    const header = bundle.header;
    if (!header || header.kind !== "header") return ["the file has no header line"];
    if (header.bundleVersion !== ANSWER_BUNDLE_VERSION) {
        problems.push(
            `bundle version ${String(header.bundleVersion)} is not ${ANSWER_BUNDLE_VERSION}`
        );
    }
    for (const field of [
        "mode",
        "evaluationSetVersion",
        "evaluationSetPurpose",
        "judgeTemplateVersion",
        "createdAt",
    ] as const) {
        if (!isNonEmptyString(header[field])) problems.push(`the header has no ${field}`);
    }
    if (!(typeof header.plannedItems === "number" && Number.isInteger(header.plannedItems) && header.plannedItems > 0)) {
        problems.push("the header has no plannedItems, so a bundle that stopped early cannot be told from a complete one");
    } else if (bundle.entries.length > header.plannedItems) {
        problems.push(
            `the bundle holds ${bundle.entries.length} pairs against ${header.plannedItems} planned`
        );
    }
    if (!(typeof header.seed === "number" && Number.isInteger(header.seed) && header.seed > 0)) {
        problems.push("the header has no seed, so the display order was not fixed");
    }
    if (bundle.entries.length === 0) problems.push("the bundle holds no pairs");

    const seen = new Set<string>();
    for (const entry of bundle.entries) {
        const where = entry.pairId ? `pair ${entry.pairId}` : "a pair with no id";
        if (!isNonEmptyString(entry.pairId)) {
            problems.push("a pair has no id");
        } else if (seen.has(entry.pairId)) {
            problems.push(`${where} appears more than once`);
        } else {
            seen.add(entry.pairId);
        }
        if (!isNonEmptyString(entry.prompt)) problems.push(`${where} has no prompt`);
        problems.push(...answerProblems(entry.first, `${where} first answer`));
        problems.push(...answerProblems(entry.second, `${where} second answer`));
        if (entry.first?.arm && entry.second?.arm && entry.first.arm === entry.second.arm) {
            problems.push(`${where} has two ${entry.first.arm} answers and no comparison`);
        }
    }
    return problems;
};

/**
 * Every model that produced an answer in this bundle, canonically.
 *
 * A judge that appears here graded its own output, which is the confound
 * `docs/ops/tomverse-chat-router-evaluation-set.md` §5 is about and the reason
 * an independent judge is asked for at all.
 */
export const bundleAnswerIdentities = (bundle: AnswerBundle): readonly string[] => {
    const identities = new Set<string>();
    for (const entry of bundle.entries) {
        for (const side of [entry.first, entry.second]) {
            if (side?.provider && side?.apiModel) identities.add(canonicalIdentity(side));
        }
    }
    return [...identities].sort();
};

/** A digest of the bundle's content, so a verdict file can name what it graded. */
export const bundleDigest = (bundle: AnswerBundle): string =>
    sha256(
        JSON.stringify(
            bundle.entries
                .map((entry) => [entry.pairId, entry.first?.digest, entry.second?.digest])
                .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
        )
    );

export const parseAnswerBundle = (text: string): AnswerBundle => {
    const lines = text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as AnswerBundleHeader | AnswerBundleEntry);
    const header = lines.find((line) => line.kind === "header") as AnswerBundleHeader | undefined;
    const entries = lines.filter((line): line is AnswerBundleEntry => line.kind === "pair");
    return { header: header as AnswerBundleHeader, entries };
};
