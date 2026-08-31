/**
 * `mem-eval-succ-6`: what a sample-changing successor has to prove that a
 * contract-only one does not.
 *
 * `succ-5` had to show its sample was byte-identical to `succ-4`'s. This one
 * has to show the opposite — that ten cases really left, ten really arrived,
 * the cells survived it, and the history of the ten is kept somewhere the
 * decision set cannot read. The tests below are mostly that inversion.
 *
 * The freeze state is asserted as `false` on purpose. It is not an oversight
 * waiting to be tidied: nobody has reviewed the ten replacements yet, and a
 * test that let it flip to `true` without one would make the adoption a thing
 * the code could grant itself.
 */

import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { datasetFingerprintInputV3 } from "../lib/memoryEvalDatasetSchemaV3.ts";
import {
    MEMORY_EVAL_SUCC5_CASES,
    MEMORY_EVAL_SUCC5_MANIFEST,
} from "../lib/memoryEvalSucc5.ts";
import {
    MEMORY_EVAL_SUCC6_CASES,
    MEMORY_EVAL_SUCC6_DATASET_FROZEN,
    MEMORY_EVAL_SUCC6_DATASET_VERSION,
    MEMORY_EVAL_SUCC6_INHERITED_COUNT,
    MEMORY_EVAL_SUCC6_MANIFEST,
    MEMORY_EVAL_SUCC6_SUPERSEDES,
    buildSucc6Manifest,
    succ6ManifestFingerprintInput,
    verifySucc6Manifest,
} from "../lib/memoryEvalSucc6.ts";
import {
    MEMORY_EVAL_SUCC6_REPLACEMENTS,
    SUCC6_REPLACEMENT_SUBTYPES,
    SUCC6_SUPERSEDED_SUBTYPES,
} from "../lib/memoryEvalSucc6Replacements.ts";
import {
    SUCC6_GOLD_CORRECTIONS,
    SUCC6_REGRESSION_CORPUS,
    succ6RegressionEntryFor,
} from "../lib/memoryEvalSucc6Regression.ts";
import {
    SUCC6_REPLACEMENT_CASE_IDS,
    SUCC6_SUPERSEDED_CASE_IDS,
    SUCC6_TRANSITIONS,
} from "../lib/memoryEvalSucc6Transition.ts";

const ids = new Set(MEMORY_EVAL_SUCC6_CASES.map((c) => c.id));

/* ------------------------------------------------------------- the shape -- */

test("the set is succ-5 less ten, plus ten", () => {
    assert.equal(MEMORY_EVAL_SUCC6_DATASET_VERSION, "mem-eval-succ-6");
    assert.equal(MEMORY_EVAL_SUCC6_SUPERSEDES, "mem-eval-succ-5");
    assert.equal(MEMORY_EVAL_SUCC5_CASES.length, 1150);
    assert.equal(MEMORY_EVAL_SUCC6_INHERITED_COUNT, 1140);
    assert.equal(MEMORY_EVAL_SUCC6_REPLACEMENTS.length, 10);
    assert.equal(MEMORY_EVAL_SUCC6_CASES.length, 1150);
    assert.equal(ids.size, 1150, "an id is duplicated");
});

test("the cells the transitions touch keep their floor", () => {
    // Ten cases left one category, so this is the arithmetic that would break
    // first if a replacement went missing: 125 → 119 and 121, against a floor
    // of 125.
    const cells = {};
    for (const c of MEMORY_EVAL_SUCC6_CASES) {
        const cell = `${c.category}:${c.language}`;
        cells[cell] = (cells[cell] ?? 0) + 1;
    }
    assert.equal(cells["assistant_only:ko"], 125);
    assert.equal(cells["assistant_only:en"], 125);
    assert.deepEqual(cells, MEMORY_EVAL_SUCC5_MANIFEST.cellCounts);
});

test("no superseded original survives, and every replacement arrived", () => {
    for (const originalId of SUCC6_SUPERSEDED_CASE_IDS) {
        assert.ok(!ids.has(originalId), `${originalId} is still in succ-6`);
    }
    for (const replacementId of SUCC6_REPLACEMENT_CASE_IDS) {
        assert.ok(ids.has(replacementId), `${replacementId} is missing`);
    }
});

test("the mapping is one to one, and every authored case is claimed", () => {
    assert.equal(SUCC6_TRANSITIONS.length, 10);
    assert.equal(SUCC6_SUPERSEDED_CASE_IDS.size, 10);
    assert.equal(SUCC6_REPLACEMENT_CASE_IDS.size, 10);
    assert.deepEqual(
        MEMORY_EVAL_SUCC6_REPLACEMENTS.map((c) => c.id).sort(),
        [...SUCC6_REPLACEMENT_CASE_IDS].sort()
    );
});

test("ko-23 is one case and one transition, whatever its candidates did", () => {
    // The unit trap. `ko-23` produced two candidates and the decision judged
    // them differently — one a violation, one a gold defect — and counting
    // those as two moves would ask for eleven replacements where ten are
    // needed. It is one row here, with both grounds on it.
    const rows = SUCC6_TRANSITIONS.filter(
        (t) => t.originalId === "succ-assistant-ko-23"
    );
    assert.equal(rows.length, 1);
    assert.deepEqual([...rows[0].grounds].sort(), [
        "gold-correction",
        "rule-formation",
    ]);
});

/* -------------------------------------------------------- the two halves -- */

test("five are preserved corrected and five unchanged", () => {
    assert.equal(SUCC6_REGRESSION_CORPUS.length, 10);
    const corrected = SUCC6_REGRESSION_CORPUS.filter(
        (e) => e.correctionRecord.length > 0
    ).map((e) => e.originalCase.id);
    const unchanged = SUCC6_REGRESSION_CORPUS.filter(
        (e) => e.correctionRecord.length === 0
    ).map((e) => e.originalCase.id);
    assert.deepEqual(corrected.sort(), [
        "succ-assistant-en-10",
        "succ-assistant-en-27",
        "succ-assistant-en-311",
        "succ-assistant-en-92",
        "succ-assistant-ko-23",
    ]);
    assert.deepEqual(unchanged.sort(), [
        "succ-assistant-ko-12",
        "succ-assistant-ko-15",
        "succ-assistant-ko-19",
        "succ-assistant-ko-3",
        "succ-assistant-ko-53",
    ]);
    assert.equal(SUCC6_GOLD_CORRECTIONS.length, 5);
});

test("the original is succ-5's own object, not a rewritten one", () => {
    // The correction is recorded beside the case and carried in a second,
    // runnable copy — never folded into the original. A history that rewrote
    // what it is a history of would answer nothing.
    const succ5 = new Map(MEMORY_EVAL_SUCC5_CASES.map((c) => [c.id, c]));
    for (const entry of SUCC6_REGRESSION_CORPUS) {
        assert.equal(
            entry.originalCase,
            succ5.get(entry.originalCase.id),
            `${entry.originalCase.id} is not the succ-5 object`
        );
        assert.deepEqual(
            [...entry.originalCase.expected],
            [...succ5.get(entry.originalCase.id).expected],
            `${entry.originalCase.id}'s expected was altered in place`
        );
    }
});

test("an uncorrected entry's regression case is the original, by identity", () => {
    // Identity rather than a flag: a spread copy would make the two halves
    // look different while being the same case, and then nothing in the file
    // would say which five were actually corrected.
    for (const entry of SUCC6_REGRESSION_CORPUS) {
        if (entry.correctionRecord.length === 0) {
            assert.equal(
                entry.regressionCase,
                entry.originalCase,
                `${entry.originalCase.id} was copied for no reason`
            );
        } else {
            assert.notEqual(entry.regressionCase, entry.originalCase);
            assert.equal(entry.regressionCase.id, entry.originalCase.id);
            assert.deepEqual(
                entry.regressionCase.conversations,
                entry.originalCase.conversations,
                `${entry.originalCase.id}'s conversation was edited`
            );
        }
    }
});

test("the corrected regression cases are runnable, and score their own gold", () => {
    // `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12.2 asks for
    // the corrected gold "in corrected form", and a `kind` and a `polarity` in
    // a metadata row are not that: nothing can score them.
    // This is the assertion that the corrected half is a case and not a note.
    for (const entry of SUCC6_REGRESSION_CORPUS) {
        if (entry.correctionRecord.length === 0) continue;
        const gold = entry.regressionCase.expected;
        assert.equal(
            gold.length,
            entry.correctionRecord.length,
            `${entry.originalCase.id} carries a different number of golds`
        );
        for (const [index, correction] of entry.correctionRecord.entries()) {
            const expected = gold[index];
            assert.equal(expected.kind, correction.kind);
            assert.equal(expected.polarity, correction.polarity);
            // Anchored to a message that exists in this very case, or the
            // evidence binding resolves against nothing.
            const messageIds = new Set(
                entry.regressionCase.conversations.flatMap((conv) =>
                    conv.messages.map((m) => m.externalMessageId)
                )
            );
            assert.ok(
                messageIds.has(expected.evidence.evidenceMessageId),
                `${entry.originalCase.id} cites ${expected.evidence.evidenceMessageId}, which is not in it`
            );
            const quoted = entry.regressionCase.conversations
                .flatMap((conv) => conv.messages)
                .find(
                    (m) =>
                        m.externalMessageId === expected.evidence.evidenceMessageId
                );
            assert.ok(
                quoted.content.includes(expected.evidence.evidenceQuote),
                `${entry.originalCase.id}'s evidence quote is not in the message it cites`
            );
        }
    }
});

test("a withheld value never appears in the gold that replaced it", () => {
    // The retraction clause, as a machine check rather than a comment. The
    // two privacy corrections keep the preference and must not name the
    // district or the city the user withdrew.
    const WITHHELD = {
        "succ-assistant-ko-23": ["강서구"],
        "succ-assistant-en-311": ["lisbon"],
    };
    let checked = 0;
    for (const entry of SUCC6_REGRESSION_CORPUS) {
        for (const correction of entry.correctionRecord) {
            if (!correction.withheldValueMustNotAppear) continue;
            const values = WITHHELD[correction.caseId];
            assert.ok(values, `${correction.caseId} claims a withheld value and names none`);
            const tokens = [
                ...(correction.expected.factValueAll ?? []),
                ...(correction.expected.factValueAny ?? []),
            ]
                .join(" ")
                .toLowerCase();
            for (const value of values) {
                assert.ok(
                    !tokens.includes(value.toLowerCase()),
                    `${correction.caseId}'s gold requires the withheld ${value}`
                );
            }
            checked += 1;
        }
    }
    assert.equal(checked, 2, "the two privacy corrections are the ones this covers");
});

test("ko-23's correction adds the preference and leaves the location alone", () => {
    // The retraction clause in one assertion: the withdrawn location keeps no
    // gold, and the preference that survives may not name it.
    const entry = succ6RegressionEntryFor("succ-assistant-ko-23");
    assert.equal(entry.correctionRecord.length, 1);
    assert.equal(entry.correctionRecord[0].kind, "preference");
    assert.equal(entry.correctionRecord[0].polarity, "affirmed");
    assert.equal(entry.correctionRecord[0].withheldValueMustNotAppear, true);
    // The original still expects nothing — that is what succ-5 held — and the
    // corrected form beside it carries the preference the decision allowed.
    assert.deepEqual([...entry.originalCase.expected], []);
    assert.equal(entry.regressionCase.expected.length, 1);
    assert.deepEqual([...entry.regressionCase.expected[0].factValueAll], ["주소"]);
});

test("every correction names a case that actually moved", () => {
    const moved = new Set(
        SUCC6_REGRESSION_CORPUS.map((e) => e.originalCase.id)
    );
    for (const correction of SUCC6_GOLD_CORRECTIONS) {
        assert.ok(moved.has(correction.caseId), correction.caseId);
    }
});

/* --------------------------------------------------------- the manifest -- */

test("the manifest recomputes, and says the sample moved", () => {
    assert.deepEqual([...verifySucc6Manifest()], []);
    const built = buildSucc6Manifest();
    assert.equal(built.manifestDigest, MEMORY_EVAL_SUCC6_MANIFEST.manifestDigest);
    assert.equal(built.caseCount, 1150);
    assert.equal(built.composition.kind, "case-replacement");
    assert.equal(built.composition.inheritedCaseCount, 1140);
    assert.equal(built.composition.replacedCaseCount, 10);
});

test("the dataset digest is new and succ-5's is untouched", () => {
    // The inversion of succ-5's own check. There the digests had to match;
    // here they must not, because ten cases changed.
    const succ5Digest = MEMORY_EVAL_SUCC5_MANIFEST.datasetDigest;
    assert.equal(
        succ5Digest,
        "0a516821da60669da6763528a414d0433e11e38db8eca56c690667cc7b2a18f0"
    );
    assert.notEqual(MEMORY_EVAL_SUCC6_MANIFEST.datasetDigest, succ5Digest);
    assert.equal(MEMORY_EVAL_SUCC6_MANIFEST.composition.sourceDatasetDigest, succ5Digest);
    assert.notEqual(
        datasetFingerprintInputV3(MEMORY_EVAL_SUCC6_CASES),
        datasetFingerprintInputV3(MEMORY_EVAL_SUCC5_CASES)
    );
});

test("a successor whose sample did not move is refused", () => {
    const built = buildSucc6Manifest();
    const failures = verifySucc6Manifest({
        ...built,
        composition: {
            ...built.composition,
            sourceDatasetDigest: built.datasetDigest,
        },
    });
    assert.ok(
        failures.some((line) => line.includes("equals succ-5's")),
        failures.join(" | ")
    );
});

test("the scoring contract is carried across, not moved", () => {
    assert.equal(
        MEMORY_EVAL_SUCC6_MANIFEST.scoringContractVersion,
        MEMORY_EVAL_SUCC5_MANIFEST.scoringContractVersion
    );
    assert.equal(
        MEMORY_EVAL_SUCC6_MANIFEST.scoringContractDigest,
        MEMORY_EVAL_SUCC5_MANIFEST.scoringContractDigest
    );
});

test("the manifest digest covers the manifest, and not itself or the freeze", () => {
    const built = buildSucc6Manifest();
    const { manifestDigest, ...withoutDigest } = built;
    const input = succ6ManifestFingerprintInput(withoutDigest);
    assert.ok(!input.includes(manifestDigest), "the digest covers itself");
    // `frozen` is excluded on purpose: adoption is a state the record passes
    // through, and folding it in would change the manifest's identity at the
    // moment somebody signs it.
    assert.ok(!input.includes("frozen"), "the freeze state is inside the digest");
    for (const fragment of [
        `datasetDigest=${built.datasetDigest}`,
        "inherited=1140",
        "replaced=10",
    ]) {
        assert.ok(input.includes(fragment), `the fingerprint drops ${fragment}`);
    }
});

/* ---------------------------------------------------------- the freeze -- */

test("it is not frozen, and the manifest says the same", () => {
    assert.equal(MEMORY_EVAL_SUCC6_DATASET_FROZEN, false);
    assert.equal(MEMORY_EVAL_SUCC6_MANIFEST.frozen, false);
});

test("a manifest claiming adoption the tree has not granted is refused", () => {
    // `frozen` sits outside the fingerprint on purpose, which means the digest
    // checks cannot see it move. This is the check that can: a record saying
    // the set is adopted while the tree still says it is not would otherwise
    // satisfy every other assertion in `verifySucc6Manifest()`.
    const built = buildSucc6Manifest();
    const failures = verifySucc6Manifest({ ...built, frozen: true });
    assert.ok(
        failures.some((line) => line.startsWith("frozen:")),
        failures.join(" | ")
    );
    // And it is the *only* thing that changed: the digests still recompute, so
    // the failure names adoption rather than drift.
    assert.equal(failures.length, 1, failures.join(" | "));
});

/* --------------------------------------------------------- the replacements */

test("the replacements are ten assistant_only cases expecting nothing", () => {
    const ko = MEMORY_EVAL_SUCC6_REPLACEMENTS.filter((c) => c.language === "ko");
    const en = MEMORY_EVAL_SUCC6_REPLACEMENTS.filter((c) => c.language === "en");
    assert.equal(ko.length, 6);
    assert.equal(en.length, 4);
    for (const c of MEMORY_EVAL_SUCC6_REPLACEMENTS) {
        assert.equal(c.category, "assistant_only", c.id);
        assert.equal(c.goldCompleteness, "exhaustive", c.id);
        // Each replaces a succ-5 case whose gold was empty. The five corrected
        // labels live in the regression corpus; the decision set never held
        // them.
        assert.deepEqual([...c.expected], [], `${c.id} expects something`);
        assert.ok(c.conversations.length > 0, c.id);
        for (const conv of c.conversations) {
            assert.ok(conv.messages.length >= 2, `${c.id} has a one-sided conversation`);
        }
    }
});

test("no replacement reuses an id, a conversation id or a message id", () => {
    // A duplicate message id inside a case would make evidence binding
    // ambiguous, and a duplicate across cases would let one case's quote
    // resolve against another's message.
    const seenConversations = new Set();
    const seenMessages = new Set();
    for (const c of MEMORY_EVAL_SUCC6_CASES) {
        for (const conv of c.conversations) {
            assert.ok(
                !seenConversations.has(conv.externalConversationId),
                `${conv.externalConversationId} is used twice`
            );
            seenConversations.add(conv.externalConversationId);
            for (const m of conv.messages) {
                assert.ok(
                    !seenMessages.has(m.externalMessageId),
                    `${m.externalMessageId} is used twice`
                );
                seenMessages.add(m.externalMessageId);
            }
        }
    }
});

/* ------------------------------------------------------- cell and subtype */

test("a replacement stays in the cell its original left", () => {
    // The cell floors are per category *and* language, so a replacement that
    // wandered would leave one cell short while the total still read 1,150 —
    // arithmetic that looks correct and is not.
    const succ5 = new Map(MEMORY_EVAL_SUCC5_CASES.map((c) => [c.id, c]));
    const succ6 = new Map(MEMORY_EVAL_SUCC6_CASES.map((c) => [c.id, c]));
    for (const transition of SUCC6_TRANSITIONS) {
        const original = succ5.get(transition.originalId);
        const replacement = succ6.get(transition.replacementId);
        assert.equal(
            replacement.category,
            original.category,
            `${transition.replacementId} left ${original.category}`
        );
        assert.equal(
            replacement.language,
            original.language,
            `${transition.replacementId} left ${original.language}`
        );
    }
});

test("every moved and every new case carries a declared subtype", () => {
    // Declared, not inferred. A keyword classifier over these conversations
    // left 66 of 125 existing cases unclassified and missed corrections as
    // plain as "3년 전에 접었고 지금은 전혀 다른 일 합니다", so a derived
    // subtype would be a guess wearing a number.
    for (const id of SUCC6_REPLACEMENT_CASE_IDS) {
        assert.ok(
            [1, 2, 3, 4].includes(SUCC6_REPLACEMENT_SUBTYPES[id]),
            `${id} has no declared subtype`
        );
    }
    for (const id of SUCC6_SUPERSEDED_CASE_IDS) {
        assert.ok(
            id in SUCC6_SUPERSEDED_SUBTYPES,
            `${id} left without its subtype being recorded`
        );
    }
});

test("the replacements carry at least as many subtype 3 and 4 cases as they replaced", () => {
    // docs/ops/memory-extraction-eval-dataset.md §3.3 asks each
    // `assistant_only` cell for at least 30% in subtypes 3 (the user corrected
    // themselves) and 4 (hypothetical). Whether the whole cell clears that
    // floor is a reader's question — the 250 inherited cases are unlabelled.
    // What is machine-checkable is that this transition did not lower it, and
    // ten replacements written entirely as subtypes 1 and 2 is exactly how it
    // would be lowered without anything noticing.
    const succ5 = new Map(MEMORY_EVAL_SUCC5_CASES.map((c) => [c.id, c]));
    const succ6 = new Map(MEMORY_EVAL_SUCC6_CASES.map((c) => [c.id, c]));
    const hard = (subtype) => subtype === 3 || subtype === 4;
    for (const language of ["ko", "en"]) {
        const out = [...SUCC6_SUPERSEDED_CASE_IDS].filter(
            (id) =>
                succ5.get(id).language === language &&
                hard(SUCC6_SUPERSEDED_SUBTYPES[id])
        ).length;
        const inbound = [...SUCC6_REPLACEMENT_CASE_IDS].filter(
            (id) =>
                succ6.get(id).language === language &&
                hard(SUCC6_REPLACEMENT_SUBTYPES[id])
        ).length;
        assert.ok(
            inbound >= out,
            `assistant_only:${language} lost subtype 3/4 weight: ${out} out, ${inbound} in`
        );
    }
});

/* -------------------------------------------------------------- isolation */

const REPO = path.resolve(import.meta.dirname, "..");

const importsOf = (file) => {
    const source = readFileSync(file, "utf8");
    const found = new Set();
    for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
        const specifier = match[1];
        let resolved = null;
        if (specifier.startsWith("@/")) resolved = path.join(REPO, specifier.slice(2));
        else if (specifier.startsWith(".")) resolved = path.resolve(path.dirname(file), specifier);
        if (!resolved) continue;
        for (const candidate of [
            resolved,
            `${resolved}.ts`,
            `${resolved}.tsx`,
            path.join(resolved, "index.ts"),
        ]) {
            if (existsSync(candidate) && candidate.endsWith(".ts")) {
                found.add(candidate);
                break;
            }
        }
    }
    return [...found];
};

const reachableFrom = (entry) => {
    const seen = new Set();
    const queue = [entry];
    while (queue.length > 0) {
        const file = queue.pop();
        if (seen.has(file)) continue;
        seen.add(file);
        for (const next of importsOf(file)) queue.push(next);
    }
    return seen;
};

test("the decision set cannot reach the regression corpus", () => {
    // A flag has to be honoured by every reader; an import boundary by none of
    // them. The two share only the transition record, which carries ids and
    // grounds and no case content.
    const DATASET = path.join(REPO, "lib/memoryEvalSucc6.ts");
    const REGRESSION = path.join(REPO, "lib/memoryEvalSucc6Regression.ts");
    const reachable = reachableFrom(DATASET);
    assert.ok(reachable.has(DATASET), "the import walk found nothing, so it proves nothing");
    assert.ok(
        !reachable.has(REGRESSION),
        "succ-6 can reach its own regression corpus"
    );
});
