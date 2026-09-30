/**
 * `mem-eval-succ-6`: what a sample-changing successor has to prove that a
 * contract-only one does not.
 *
 * `succ-5` had to show its sample was byte-identical to `succ-4`'s. This one
 * has to show the opposite — that thirteen cases really left, thirteen really
 * arrived, the cells survived it, and the history of the B+ ten is kept
 * somewhere the decision set cannot read. The tests below are mostly that
 * inversion.
 *
 * Frozen and signed since 2026-08-31, so the freeze assertions changed
 * direction: what they now hold is that the record is a pinned literal rather
 * than a computed view, that it disagrees when the sample moves under it, and
 * that the freeze and the subtype table's signature cannot come apart. The
 * digests are written out here as well as inside the module, so editing a
 * signed value fails a named test rather than only a digest comparison.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

import {
    candidateMatchesGoldV3,
    datasetFingerprintInputV3,
    goldEvidenceFailure,
} from "../lib/memoryEvalDatasetSchemaV3.ts";
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
import { scoreCaseV3 } from "../lib/memoryEvalScoringV3.ts";
import {
    SUCC6_COMPOSITION_ADDITIONS,
    SUCC6_COMPOSITION_REPAIRS,
} from "../lib/memoryEvalSucc6CompositionRepairs.ts";
import {
    MEMORY_EVAL_SUCC6_REPLACEMENTS,
    SUCC6_REPLACEMENT_SUBTYPES,
    SUCC6_SUPERSEDED_SUBTYPES,
} from "../lib/memoryEvalSucc6Replacements.ts";
import {
    SUCC6_GOLD_CORRECTIONS,
    SUCC6_REGRESSION_CORPUS,
    regressionLeakViolations,
    succ6CorrectedGoldEvidenceFailures,
    succ6RegressionEntryFor,
} from "../lib/memoryEvalSucc6Regression.ts";
import {
    ASSISTANT_ONLY_SUBTYPES,
    SUBTYPE_REVIEW,
    assistantOnlySubtypeFloor,
    subtypeTableDigest,
    subtypeTableFingerprintInput,
    unknownSubtypeRows,
} from "../lib/memoryEvalAssistantOnlySubtypes.ts";
import {
    SUCC6_REPLACEMENT_CASE_IDS,
    SUCC6_SUPERSEDED_CASE_IDS,
    SUCC6_TRANSITIONS,
} from "../lib/memoryEvalSucc6Transition.ts";

const ids = new Set(MEMORY_EVAL_SUCC6_CASES.map((c) => c.id));

/* ------------------------------------------------------------- the shape -- */

test("the set is succ-5 less thirteen, plus thirteen", () => {
    // Ten from B+ and three composition repairs, counted separately because
    // they left for different reasons. Merging them would make "why did this
    // case go" unanswerable, and the answers are not the same.
    assert.equal(MEMORY_EVAL_SUCC6_DATASET_VERSION, "mem-eval-succ-6");
    assert.equal(MEMORY_EVAL_SUCC6_SUPERSEDES, "mem-eval-succ-5");
    assert.equal(MEMORY_EVAL_SUCC5_CASES.length, 1150);
    assert.equal(MEMORY_EVAL_SUCC6_INHERITED_COUNT, 1137);
    assert.equal(MEMORY_EVAL_SUCC6_REPLACEMENTS.length, 10);
    assert.equal(SUCC6_COMPOSITION_ADDITIONS.length, 3);
    assert.equal(SUCC6_COMPOSITION_REPAIRS.length, 3);
    assert.equal(MEMORY_EVAL_SUCC6_CASES.length, 1150);
    assert.equal(ids.size, 1150, "an id is duplicated");
});

test("a composition repair removes a case and adds one in the same cell", () => {
    const succ5 = new Map(MEMORY_EVAL_SUCC5_CASES.map((c) => [c.id, c]));
    const succ6 = new Map(MEMORY_EVAL_SUCC6_CASES.map((c) => [c.id, c]));
    for (const repair of SUCC6_COMPOSITION_REPAIRS) {
        const removed = succ5.get(repair.removedId);
        assert.ok(removed, `${repair.removedId} was never a succ-5 case`);
        assert.ok(!succ6.has(repair.removedId), `${repair.removedId} is still present`);
        const added = succ6.get(repair.addedId);
        assert.ok(added, `${repair.addedId} is missing`);
        assert.equal(`${added.category}:${added.language}`, repair.cell);
        assert.equal(`${removed.category}:${removed.language}`, repair.cell);
        // The point of the swap: what arrives is a subtype 3 or 4 case, and
        // what leaves is not — otherwise the cell gains nothing.
        assert.equal(ASSISTANT_ONLY_SUBTYPES[repair.addedId].subtype, repair.addedSubtype);
        assert.equal(ASSISTANT_ONLY_SUBTYPES[repair.removedId], undefined);
        assert.ok(repair.removalReason.length > 0, repair.removedId);
    }
});

test("the two lists of departures do not overlap", () => {
    // A case cannot both have formed the rule and have been swapped for
    // redundancy, and a single id in both would make its provenance a
    // question with two answers.
    for (const repair of SUCC6_COMPOSITION_REPAIRS) {
        assert.ok(!SUCC6_SUPERSEDED_CASE_IDS.has(repair.removedId), repair.removedId);
        assert.ok(!SUCC6_REPLACEMENT_CASE_IDS.has(repair.addedId), repair.addedId);
    }
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
    assert.equal(built.composition.inheritedCaseCount, 1137);
    assert.equal(built.composition.replacedCaseCount, 13);
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
        "inherited=1137",
        "replaced=13",
        `subtypeTableDigest=${built.subtypeTableDigest}`,
    ]) {
        assert.ok(input.includes(fragment), `the fingerprint drops ${fragment}`);
    }
});

/* ---------------------------------------------------------- the freeze -- */

test("it is frozen, and the manifest is a literal rather than a view", () => {
    assert.equal(MEMORY_EVAL_SUCC6_DATASET_FROZEN, true);
    assert.equal(MEMORY_EVAL_SUCC6_MANIFEST.frozen, true);
    // Pinned, not computed. A computed manifest cannot disagree with the tree,
    // and disagreeing is the only thing a frozen record is for: with
    // `buildSucc6Manifest()` on the right-hand side, `verifySucc6Manifest()`
    // would compare the tree with itself and report no drift forever.
    const source = readFileSync(path.join(REPO, "lib/memoryEvalSucc6.ts"), "utf8");
    const pin = source.slice(source.indexOf("export const MEMORY_EVAL_SUCC6_MANIFEST"));
    assert.ok(
        !pin.startsWith("export const MEMORY_EVAL_SUCC6_MANIFEST: Succ6DatasetManifest =\n    buildSucc6Manifest()"),
        "the frozen manifest is still a computed view"
    );
    // The signed values, written out so an edit to any of them fails here and
    // not only inside a digest comparison.
    assert.equal(
        MEMORY_EVAL_SUCC6_MANIFEST.datasetDigest,
        "2ffc8c09d6a20c2ad150d222fd71b891bf160b6c26b4d27684708ccbcf20fb63"
    );
    assert.equal(
        MEMORY_EVAL_SUCC6_MANIFEST.subtypeTableDigest,
        "89e10d0d8b16901f2989f655a39786ffd6487fbe6d21272fefe232a00c234e83"
    );
    assert.equal(
        MEMORY_EVAL_SUCC6_MANIFEST.manifestDigest,
        "b1904682a2920a6554f533001a2b59cbd2d4cdc06b517aa2b53588c094ce603d"
    );
});

test("the freeze cannot run ahead of the subtype table's signature", () => {
    // The hazard this encodes: the review status, reviewer and date are inside
    // `subtypeTableDigest`, so recording the signature moves that digest and
    // the manifest digest with it. Pin first and sign after, and the record's
    // digests describe a table that no longer exists. Sign, recompute, pin.
    //
    // Asserted by reading the source rather than by flipping the constant,
    // because the constant is a module-level literal — there is nothing to
    // flip at runtime, and a test that could would be testing a mutability
    // this file does not have.
    const source = readFileSync(
        path.join(REPO, "lib/memoryEvalSucc6.ts"),
        "utf8"
    );
    assert.ok(
        source.includes("MEMORY_EVAL_SUCC6_DATASET_FROZEN) {"),
        "verifySucc6Manifest no longer guards the frozen case"
    );
    assert.ok(
        source.includes('SUBTYPE_REVIEW.status !== "human_confirmed"'),
        "freezing no longer requires a signed subtype table"
    );
    assert.ok(
        source.includes("!SUBTYPE_REVIEW.reviewer || !SUBTYPE_REVIEW.reviewedAt"),
        "freezing no longer requires a named reviewer and a date"
    );
    // And the two states agree: frozen, and signed by a named person on a
    // date. The guard above is what makes that pairing an invariant rather
    // than a coincidence of this commit.
    assert.equal(MEMORY_EVAL_SUCC6_DATASET_FROZEN, true);
    assert.equal(SUBTYPE_REVIEW.status, "human_confirmed");
    assert.equal(SUBTYPE_REVIEW.reviewer, "mposition");
    assert.equal(SUBTYPE_REVIEW.reviewedAt, "2026-08-31");
});

test("recording the signature moves the subtype digest, so it cannot be pinned first", () => {
    // The ordering constraint as arithmetic rather than as a comment: the same
    // rows under a different review status fingerprint differently.
    const signed = subtypeTableFingerprintInput();
    assert.ok(signed.includes("status=human_confirmed"));
    assert.ok(signed.includes("reviewer=mposition"));
    assert.ok(signed.includes("reviewedAt=2026-08-31"));
    // `method` too — a signature covers what was claimed when it was given.
    assert.ok(signed.includes(`method=${SUBTYPE_REVIEW.method}`));
    // Run the clock backwards: the same rows, unsigned, fingerprint
    // differently. That difference is why the order had to be sign, recompute,
    // pin — pinning the draft's digests first would have recorded a table that
    // ceased to exist the moment it was signed.
    const draft = signed
        .replace("status=human_confirmed", "status=ai_draft")
        .replace("reviewer=mposition", "reviewer=-")
        .replace("reviewedAt=2026-08-31", "reviewedAt=-");
    assert.notEqual(
        createHash("sha256").update(draft, "utf8").digest("hex"),
        subtypeTableDigest(),
        "the signature does not move the digest, so the pin order would not matter"
    );
});

test("a manifest disagreeing with the tree about adoption is refused", () => {
    // `frozen` sits outside the fingerprint on purpose, so the digest checks
    // cannot see it move. This is the check that can, and it has to work in
    // both directions — now that the tree says `true`, the record that would
    // slip past every other assertion is one still claiming the draft state.
    const built = buildSucc6Manifest();
    const failures = verifySucc6Manifest({ ...built, frozen: false });
    assert.ok(
        failures.some((line) => line.startsWith("frozen:")),
        failures.join(" | ")
    );
    // And it is the *only* thing that changed: the digests still recompute, so
    // the failure names adoption rather than drift.
    assert.equal(failures.length, 1, failures.join(" | "));
});

test("the no-argument call compares the record with the tree, not the tree with itself", () => {
    // The defect this replaced: `manifest` defaulted to `buildSucc6Manifest()`
    // while the body computed `buildSucc6Manifest()` too, so calling with no
    // argument compared the tree with itself and always returned empty. The
    // pin existed and nothing consulted it —
    // `scripts/check-memory-eval-succ6.mjs` called it exactly this way and
    // printed a clean bill over a dataset it had not checked.
    const source = readFileSync(path.join(REPO, "lib/memoryEvalSucc6.ts"), "utf8");
    const signature = source.slice(
        source.indexOf("export function verifySucc6Manifest("),
        source.indexOf("): readonly string[] {", source.indexOf("export function verifySucc6Manifest("))
    );
    assert.ok(
        signature.includes("manifest: Succ6DatasetManifest = MEMORY_EVAL_SUCC6_MANIFEST"),
        "the record side defaults to something other than the pinned literal"
    );
    assert.ok(
        !signature.includes("manifest: Succ6DatasetManifest = buildSucc6Manifest()"),
        "the record side is computed again, so a no-argument call is a tautology"
    );
    // And the two calls agree, which is what makes the check script's
    // no-argument call meaningful.
    assert.deepEqual(
        [...verifySucc6Manifest()],
        [...verifySucc6Manifest(MEMORY_EVAL_SUCC6_MANIFEST)]
    );
});

test("a moved tree is reported against the pinned record", () => {
    // The tree side is injectable so this can be shown to fail without
    // editing a file. A check that cannot be made to fail is not evidence
    // that anything passed.
    const mutated = MEMORY_EVAL_SUCC6_CASES.map((testCase, index) =>
        index > 0
            ? testCase
            : {
                  ...testCase,
                  conversations: testCase.conversations.map((conversation) => ({
                      ...conversation,
                      messages: conversation.messages.map((message, position) =>
                          position > 0
                              ? message
                              : { ...message, content: `${message.content} CHANGED` }
                      ),
                  })),
              }
    );
    const movedDigest = createHash("sha256")
        .update(datasetFingerprintInputV3(mutated), "utf8")
        .digest("hex");
    assert.notEqual(movedDigest, MEMORY_EVAL_SUCC6_MANIFEST.datasetDigest);

    const withoutDigest = { ...buildSucc6Manifest(), datasetDigest: movedDigest };
    delete withoutDigest.manifestDigest;
    const movedTree = {
        ...withoutDigest,
        manifestDigest: createHash("sha256")
            .update(succ6ManifestFingerprintInput(withoutDigest), "utf8")
            .digest("hex"),
    };

    const failures = verifySucc6Manifest(undefined, movedTree);
    assert.ok(
        failures.some((line) => line.startsWith("datasetDigest:")),
        failures.join(" | ")
    );
    assert.ok(
        failures.some((line) => line.startsWith("manifestDigest:")),
        failures.join(" | ")
    );
});

test("the pinned record disagrees when the sample moves under it", () => {
    // What the pin is for. A computed manifest could not fail this: it would
    // recompute alongside the edit and report nothing.
    const moved = {
        ...MEMORY_EVAL_SUCC6_MANIFEST,
        datasetDigest: "0".repeat(64),
    };
    const failures = verifySucc6Manifest(moved);
    assert.ok(
        failures.some((line) => line.startsWith("datasetDigest:")),
        failures.join(" | ")
    );
});

/* --------------------------------------------------------- the replacements */

test("the B+ replacements are ten assistant_only cases, eight expecting nothing", () => {
    const ko = MEMORY_EVAL_SUCC6_REPLACEMENTS.filter((c) => c.language === "ko");
    const en = MEMORY_EVAL_SUCC6_REPLACEMENTS.filter((c) => c.language === "en");
    assert.equal(ko.length, 6);
    assert.equal(en.length, 4);
    for (const c of MEMORY_EVAL_SUCC6_REPLACEMENTS) {
        assert.equal(c.category, "assistant_only", c.id);
        assert.equal(c.goldCompleteness, "exhaustive", c.id);
        assert.ok(c.conversations.length > 0, c.id);
        for (const conv of c.conversations) {
            assert.ok(conv.messages.length >= 2, `${c.id} has a one-sided conversation`);
        }
    }
    // Eight of the ten, not all ten. An earlier draft had every replacement
    // empty because every case it replaced was empty, and that reasoning is
    // withdrawn: a gold follows the conversation's meaning, not the shape of
    // the case being replaced. Inheriting the shape is how a defect survives a
    // replacement — and it survived twice here, since ko-504 was found only
    // after ko-501 had been fixed.
    const withGold = MEMORY_EVAL_SUCC6_REPLACEMENTS.filter(
        (c) => c.expected.length > 0
    );
    assert.deepEqual(
        withGold.map((c) => c.id),
        ["succ-assistant-ko-501", "succ-assistant-ko-504"]
    );
    for (const c of MEMORY_EVAL_SUCC6_REPLACEMENTS) {
        if (c.expected.length === 0) {
            assert.equal(c.criticalGoldMode, undefined, `${c.id} declares a mode it does not use`);
        }
    }
});

test("ko-501 keeps the beginner fact the prompt already asks for", () => {
    // `lib/memoryExtractionPrompt.ts` says a durable proficiency *including
    // being a beginner* is `expertise`. An empty gold would score the correct
    // extraction as a critical violation — the dataset teaching the prompt to
    // drop a fact the prompt is told to keep.
    const c = MEMORY_EVAL_SUCC6_REPLACEMENTS.find(
        (x) => x.id === "succ-assistant-ko-501"
    );
    // The mixed-critical amendment is what lets a critical case carry gold at
    // all, and it requires both of these together.
    assert.equal(c.criticalGoldMode, "allow_expected_only");
    assert.equal(c.goldCompleteness, "exhaustive");
    assert.equal(c.expected.length, 1);
    const [gold] = c.expected;
    assert.equal(gold.kind, "expertise");
    assert.equal(gold.polarity, "affirmed");
    assert.equal(gold.expectedDisposition, "bulk_safe");
    assert.equal(goldEvidenceFailure(gold, c.conversations, c.language), null);

    const scores = (statement) =>
        candidateMatchesGoldV3(gold, { kind: "expertise", polarity: "affirmed", statement }, "ko");
    // The correct reading matches, several ways of saying it.
    assert.ok(scores("사용자는 첼로를 이제 막 시작한 초보자입니다"));
    assert.ok(scores("사용자는 첼로 입문 단계입니다"));
    assert.ok(scores("사용자는 첼로를 처음 배우고 있습니다"));
    // The transferred claim — the senior's ten years — does not, which is what
    // keeps this a case about the cell's own question. `시작` is kept out of
    // the OR for exactly this: "십 년 전에 시작했다" would otherwise pass.
    assert.ok(!scores("사용자는 첼로를 십 년간 연주해 온 숙련자입니다"));
    assert.ok(!scores("사용자는 첼로를 십 년 전에 시작했습니다"));
});

/**
 * A candidate as the scorer wants one, so the two mixed-critical cases can be
 * asserted at `scoreCaseV3()` rather than at string matching.
 *
 * String matching says whether a gold *would* match. It does not say what the
 * scorer does with a critical case, and that is the half the mixed-critical
 * amendment changed: a bulk-safe candidate matching a bulk-safe gold is
 * spared, and every other bulk-safe candidate is still counted. Only the
 * scorer can be asked whether that is what happens.
 */
/**
 * The two cases carrying gold, with a right and a wrong answer for each.
 *
 * Shared so every assertion about the mixed-critical exception runs over both.
 * The two golds are different shapes — ko-501 is one `factValueAll` token plus
 * a `factValueAny`, ko-504 is two `factValueAll` tokens — and an exception
 * that held for one and leaked for the other would pass a check written
 * against either alone.
 */
const MIXED_CRITICAL_CASES = [
    {
        id: "succ-assistant-ko-501",
        right: "사용자는 첼로를 이제 막 시작한 초보자입니다",
        wrong: "사용자는 첼로를 십 년간 연주해 온 숙련자입니다",
    },
    {
        id: "succ-assistant-ko-504",
        right: "사용자는 격주로 열리는 모임에 참석한다",
        wrong: "사용자는 매주 목요일 모임을 한다",
    },
];

const candidateFor = (gold, statement) => ({
    kind: gold.kind,
    polarity: gold.polarity,
    statement,
    bulkSafe: true,
    disposition: "accepted",
    evidence: [
        {
            evidenceMessageId: gold.evidence.evidenceMessageId,
            evidenceQuote: gold.evidence.evidenceQuote,
        },
    ],
});

test("the two mixed-critical cases score as the amendment says they should", () => {
    // The right answer is recalled and costs nothing; the wrong one recalls
    // nothing and is a critical adoption. Both halves matter: a case that only
    // proved the first would pass with the gold missing, and one that only
    // proved the second would pass with an empty gold — which is the defect
    // this pair replaced.
    for (const { id, right, wrong } of MIXED_CRITICAL_CASES) {
        const testCase = MEMORY_EVAL_SUCC6_REPLACEMENTS.find((c) => c.id === id);
        assert.equal(testCase.criticalGoldMode, "allow_expected_only", id);
        const [gold] = testCase.expected;

        const good = scoreCaseV3(testCase, [candidateFor(gold, right)]);
        assert.equal(good.goldMatched, 1, `${id}: the right answer was not recalled`);
        assert.equal(good.goldTotal, 1, id);
        assert.equal(
            good.criticalBulkSafeAdoptions,
            0,
            `${id}: the right answer was counted as a critical adoption`
        );

        const bad = scoreCaseV3(testCase, [candidateFor(gold, wrong)]);
        assert.equal(bad.goldMatched, 0, `${id}: the wrong answer was recalled`);
        assert.equal(
            bad.criticalBulkSafeAdoptions,
            1,
            `${id}: the wrong answer was not counted, so the case tests nothing`
        );
    }
});

test("a mixed-critical case still counts an extra bulk-safe candidate", () => {
    // The amendment spares the matching candidate, not the case. A model that
    // returns the right fact and also the wrong one is still wrong, and this is
    // the assertion that the exception did not widen into an amnesty.
    //
    // Over both cases, not just ko-501: an exception that held for one gold
    // shape and leaked for another would pass a single-case check, and these
    // two are different shapes — one `factValueAll` plus a `factValueAny`
    // against two `factValueAll` tokens.
    for (const { id, right, wrong } of MIXED_CRITICAL_CASES) {
        const testCase = MEMORY_EVAL_SUCC6_REPLACEMENTS.find((c) => c.id === id);
        const [gold] = testCase.expected;
        const outcome = scoreCaseV3(testCase, [
            candidateFor(gold, right),
            candidateFor(gold, wrong),
        ]);
        assert.equal(outcome.goldMatched, 1, `${id}: the right answer was not recalled`);
        assert.equal(
            outcome.criticalBulkSafeAdoptions,
            1,
            `${id}: the wrong answer rode in free beside the right one`
        );
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

/* ------------------------------------------------- anchors and prohibition */

test("every corrected gold anchors, not just scores", () => {
    // The two questions are different and the corpus shipped one passing while
    // the other failed: `en-10` required `swimming` against "I'm not going
    // back.", which is `gold-evidence-covers-fact`. A gold no scorer can
    // anchor is not preserved "in corrected form" in any useful sense.
    assert.deepEqual([...succ6CorrectedGoldEvidenceFailures()], []);
});

test("en-10's anchor carries the thing decided about, not only the decision", () => {
    const entry = succ6RegressionEntryFor("succ-assistant-en-10");
    const [gold] = entry.regressionCase.expected;
    assert.deepEqual([...gold.factValueAll], ["swim"]);
    assert.ok(
        gold.evidence.evidenceQuote.includes("swimmer"),
        "the quote must contain the token, which is what goldEvidenceFailure checks"
    );
    const matches = (statement) =>
        candidateMatchesGoldV3(gold, { kind: "decision", polarity: "affirmed", statement }, "en");
    assert.ok(matches("The user has decided not to return to swimming."));
    assert.ok(matches("The user will not swim competitively again."));
});

test("a statement naming a withheld value is a violation even though it scores", () => {
    // The whole reason the prohibition is a separate layer.
    // `candidateMatchesGoldV3()` decides by containment, and containment is
    // monotone: adding words can only gain a match. So no gold expressible in
    // the frozen contract can reject a statement for saying too much, and
    // editing `mem-score-v3.4` to make it would break recall everywhere else.
    const cases = [
        ["succ-assistant-ko-23", "강서구의 집 주소를 공개하고 싶어 하지 않는다", "강서구"],
        ["succ-assistant-en-311", "prefers not to share their location in Lisbon", "Lisbon"],
    ];
    for (const [caseId, statement, forbidden] of cases) {
        const entry = succ6RegressionEntryFor(caseId);
        const [gold] = entry.regressionCase.expected;
        const candidate = { kind: gold.kind, polarity: gold.polarity, statement };
        // It scores. That is the point, not an oversight.
        assert.ok(
            candidateMatchesGoldV3(gold, candidate, entry.regressionCase.language),
            `${caseId}: the leaking statement was expected to score`
        );
        const violations = regressionLeakViolations(entry, candidate);
        assert.equal(violations.length, 1, caseId);
        assert.equal(violations[0].forbiddenValue, forbidden);
        assert.equal(
            violations[0].scoredAsMatch,
            true,
            "the pair — leaked and scored — is the fact worth reporting"
        );
    }
});

test("a statement that keeps the value out is not reported", () => {
    for (const [caseId, statement] of [
        ["succ-assistant-ko-23", "집 주소를 공개하고 싶어 하지 않는다"],
        ["succ-assistant-en-311", "prefers not to share their own location"],
    ]) {
        const entry = succ6RegressionEntryFor(caseId);
        const [gold] = entry.regressionCase.expected;
        assert.deepEqual(
            [...regressionLeakViolations(entry, {
                kind: gold.kind,
                polarity: gold.polarity,
                statement,
            })],
            []
        );
    }
});

test("every case flagged as withholding a value names the value", () => {
    // `withheldValueMustNotAppear` on its own is a comment. What makes it a
    // check is the list beside it.
    for (const correction of SUCC6_GOLD_CORRECTIONS) {
        if (!correction.withheldValueMustNotAppear) continue;
        assert.ok(
            (correction.forbiddenValues ?? []).length > 0,
            `${correction.caseId} is flagged and names nothing`
        );
    }
});

/* --------------------------------------------------- the docs/ops/memory-extraction-eval-dataset.md §3.3 subtype floor */

test("the subtype table names only cases the dataset holds", () => {
    // The one part of the subtype question a machine can settle. A row left
    // pointing at a replaced case would lower the count with nothing saying so.
    assert.deepEqual([...unknownSubtypeRows(MEMORY_EVAL_SUCC6_CASES)], []);
    for (const [id, entry] of Object.entries(ASSISTANT_ONLY_SUBTYPES)) {
        assert.ok([3, 4].includes(entry.subtype), id);
        assert.ok(entry.ground.length > 0, `${id} has no ground`);
        const testCase = MEMORY_EVAL_SUCC6_CASES.find((c) => c.id === id);
        assert.equal(testCase.category, "assistant_only", id);
    }
});

test("the docs/ops/memory-extraction-eval-dataset.md §3.3 floor is met, and succ-5's was not", () => {
    // succ-5 sat at ko 31 and en 34 with nothing measuring it. Both halves are
    // asserted: that succ-6 clears the floor, and that its predecessor did
    // not — the second is what stops the first from reading as a fact about
    // the dataset family rather than about this change.
    const rows = new Map(
        assistantOnlySubtypeFloor(MEMORY_EVAL_SUCC6_CASES).map((r) => [r.cell, r])
    );
    const before = new Map(
        assistantOnlySubtypeFloor(MEMORY_EVAL_SUCC5_CASES).map((r) => [r.cell, r])
    );
    for (const cell of ["assistant_only:ko", "assistant_only:en"]) {
        assert.equal(rows.get(cell).floor, 38, cell);
        assert.equal(rows.get(cell).meetsFloor, true, `${cell} is below the floor`);
        assert.equal(rows.get(cell).shortfall, 0, cell);
        assert.equal(before.get(cell).meetsFloor, false, `${cell}: succ-5 already met it`);
    }
    assert.equal(rows.get("assistant_only:ko").hard, 38);
    assert.equal(rows.get("assistant_only:en").hard, 38);
    // And the table is a draft until somebody signs it. A confirmed table with
    // no reviewer would be the signature this whole flow exists to require.
    if (SUBTYPE_REVIEW.status === "human_confirmed") {
        assert.ok(SUBTYPE_REVIEW.reviewer, "confirmed by nobody");
        assert.ok(SUBTYPE_REVIEW.reviewedAt, "confirmed on no date");
    } else {
        assert.equal(SUBTYPE_REVIEW.status, "ai_draft");
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
