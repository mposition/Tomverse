import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { AVAILABLE_MODELS } from "../lib/models.ts";
import {
    NEUTRAL_QUALITY_BAND,
    ROUTER_QUALITY_BANDS,
    ROUTER_SCORE_POLICY_VERSION,
    ROUTER_SCORE_SNAPSHOT,
    ROUTER_STICKY_HYSTERESIS_TURNS,
    ROUTER_STICKY_SWITCH_MARGIN_BANDS,
    ROUTER_TIE_BREAK_ORDER,
    ROUTER_WEAK_CONFIDENCE_EXTRA_TURNS,
    compareRouterScoreCells,
    getRouterScoreCell,
    isRouterScoreSnapshotModel,
    rankingKindFor,
    stickyHysteresisTurnsFor,
} from "../lib/routerScorePolicy.ts";
import { TASK_KINDS, buildTaskProfile } from "../lib/taskProfileCore.ts";

const enabledModels = AVAILABLE_MODELS.filter((model) => model.enabled);
const profile = (overrides) => ({
    ...buildTaskProfile({ text: "안녕" }),
    ...overrides,
});

// The failure this file exists for: the Router ranked from a six-model product
// table, so twenty-four of the thirty enabled models could only ever be chosen
// when everything ahead of them failed a hard filter. Enrolment is what fixes
// that, and it only stays fixed if adding a model to the catalogue fails here.
test("every enabled catalogue model is enrolled in the snapshot", () => {
    const missing = enabledModels
        .map((model) => model.id)
        .filter((modelId) => !isRouterScoreSnapshotModel(modelId));
    assert.deepEqual(
        missing,
        [],
        `enabled but unenrolled: ${missing.join(", ")}. Add an entry to ` +
            "ROUTER_SCORE_SNAPSHOT -- an enabled model absent from it routes at " +
            "the neutral band, which is a decision nobody made."
    );
});

test("the snapshot names no model the catalogue does not have", () => {
    const catalogueIds = new Set(AVAILABLE_MODELS.map((model) => model.id));
    for (const entry of ROUTER_SCORE_SNAPSHOT) {
        assert.ok(
            catalogueIds.has(entry.modelId),
            `${entry.modelId} is scored but is not in the catalogue`
        );
    }
});

test("no model is enrolled twice", () => {
    const ids = ROUTER_SCORE_SNAPSHOT.map((entry) => entry.modelId);
    assert.equal(new Set(ids).size, ids.length);
});

// providerId is carried so provider-variant routing can be added without
// rebuilding the snapshot. A value that disagrees with the catalogue would be
// worse than no value at all: it would be read as a routing fact.
test("each entry's provider matches the catalogue", () => {
    const providerById = new Map(
        AVAILABLE_MODELS.map((model) => [model.id, model.provider])
    );
    for (const entry of ROUTER_SCORE_SNAPSHOT) {
        assert.equal(
            entry.providerId,
            providerById.get(entry.modelId),
            `${entry.modelId} is scored under the wrong provider`
        );
    }
});

// Nothing has been measured, so nothing is ranked. A snapshot that arrived
// with opinions already in it would be the curated table again under a new
// name -- with the same problem, that nobody could say what the opinions were
// based on.
test("every cell starts neutral, with no confidence interval", () => {
    for (const entry of ROUTER_SCORE_SNAPSHOT) {
        for (const kind of TASK_KINDS) {
            const cell = getRouterScoreCell(entry.modelId, kind);
            assert.equal(
                cell.qualityBand,
                NEUTRAL_QUALITY_BAND,
                `${entry.modelId}/${kind} is not neutral`
            );
            assert.equal(cell.qualityCi95Lower, null);
            assert.equal(cell.evidenceRef, null);
        }
    }
});

// The rule that keeps it that way. A band may move, but only with a record
// naming what moved it.
test("a band off neutral must name its evidence", () => {
    for (const entry of ROUTER_SCORE_SNAPSHOT) {
        for (const [kind, evidence] of Object.entries(entry.quality ?? {})) {
            assert.ok(
                ROUTER_QUALITY_BANDS.includes(evidence.qualityBand),
                `${entry.modelId}/${kind} has a band outside 1..3`
            );
            assert.ok(
                typeof evidence.evidenceRef === "string" &&
                    evidence.evidenceRef.length > 0,
                `${entry.modelId}/${kind} moved off neutral with no evidenceRef`
            );
        }
    }
});

test("an unenrolled model is neutral rather than refused", () => {
    // A catalogue addition must not silently drop out of Auto. The test above
    // is what makes the omission visible; the runtime stays forgiving.
    const cell = getRouterScoreCell("model-nobody-has-scored-yet", "coding");
    assert.equal(cell.qualityBand, NEUTRAL_QUALITY_BAND);
    assert.equal(cell.qualityCi95Lower, null);
});

test("the tie-break order is the one the policy documents", () => {
    assert.deepEqual(ROUTER_TIE_BREAK_ORDER, [
        "quality_band",
        "expected_total_cost",
        "recent_success_rate",
        "ttft_p95",
        "model_id",
    ]);
});

// The margin moved from 2 points to 1 band with the scale it is measured on.
// Left at 2 it would have meant "only a 1-to-3 jump ever switches", which is a
// different policy wearing the old policy's number.
test("the switch margin is stated in the units of the current scale", () => {
    const bandSpread = Math.max(...ROUTER_QUALITY_BANDS) - Math.min(...ROUTER_QUALITY_BANDS);
    assert.ok(ROUTER_STICKY_SWITCH_MARGIN_BANDS >= 1);
    assert.ok(
        ROUTER_STICKY_SWITCH_MARGIN_BANDS < bandSpread,
        "a margin equal to the whole spread can only be cleared by the extreme case"
    );
});

test("a cell with no interval is compared on its band alone", () => {
    const band = (qualityBand, qualityCi95Lower = null) => ({
        qualityBand,
        qualityCi95Lower,
        evidenceRef: null,
    });

    assert.ok(compareRouterScoreCells(band(3), band(2)) < 0);
    assert.equal(compareRouterScoreCells(band(2), band(2)), 0);
    // One side measured is not enough: an interval is only ever compared with
    // another interval.
    assert.equal(compareRouterScoreCells(band(2, 0.9), band(2)), 0);
    assert.equal(compareRouterScoreCells(band(2), band(2, 0.9)), 0);
    // Both measured, same band: the interval refines the order.
    assert.ok(compareRouterScoreCells(band(2, 0.9), band(2, 0.4)) < 0);
});

// A comparator that let an interval outrank a band would not be a total order:
// A over B on an interval, B over C on a band and C over A on a band has no
// consistent answer, and the sort result would depend on input order.
test("the band is a strict primary key, so the order stays total", () => {
    const cells = [
        { qualityBand: 2, qualityCi95Lower: 0.99, evidenceRef: "e" },
        { qualityBand: 3, qualityCi95Lower: null, evidenceRef: "e" },
        { qualityBand: 1, qualityCi95Lower: 0.01, evidenceRef: "e" },
    ];
    for (const left of cells) {
        for (const right of cells) {
            for (const middle of cells) {
                if (
                    compareRouterScoreCells(left, middle) < 0 &&
                    compareRouterScoreCells(middle, right) < 0
                ) {
                    assert.ok(
                        compareRouterScoreCells(left, right) < 0,
                        "comparison is not transitive"
                    );
                }
            }
        }
    }
});

// A kind nothing supported is not a weak opinion about the kind; it is the
// absence of one, and it must not steer the ranking.
test("an unsupported kind ranks on the general column", () => {
    assert.equal(
        rankingKindFor(profile({ kind: "coding", kindConfidence: "none" })),
        "general"
    );
    assert.equal(
        rankingKindFor(profile({ kind: "coding", kindConfidence: "weak" })),
        "coding"
    );
    assert.equal(
        rankingKindFor(profile({ kind: "coding", kindConfidence: "strong" })),
        "coding"
    );
});

test("a turn resting on one signal moves the conversation more slowly", () => {
    assert.equal(
        stickyHysteresisTurnsFor(profile({ kindConfidence: "strong" })),
        ROUTER_STICKY_HYSTERESIS_TURNS
    );
    assert.equal(
        stickyHysteresisTurnsFor(profile({ kindConfidence: "weak" })),
        ROUTER_STICKY_HYSTERESIS_TURNS + ROUTER_WEAK_CONFIDENCE_EXTRA_TURNS
    );
});

test("the policy carries a version that can be recorded", () => {
    assert.match(ROUTER_SCORE_POLICY_VERSION, /-v\d+$/);
});

// `selectRouterModel` runs on the chat path and is described everywhere as
// pure. A comment cannot hold that; an import can break it silently, and the
// first symptom would be a database call inside a routing decision.
test("the selection path imports nothing that touches the outside world", () => {
    const libDirectory = path.join(process.cwd(), "lib");
    const forbidden = [
        "server-only",
        "next/server",
        "@/lib/prisma",
        "@prisma/client",
        "node:fs",
        "node:net",
        "node:child_process",
        "node:dns",
        "fs",
        "child_process",
    ];

    const seen = new Set();
    const visit = (moduleName) => {
        if (seen.has(moduleName)) return;
        seen.add(moduleName);
        const source = readFileSync(
            path.join(libDirectory, `${moduleName}.ts`),
            "utf8"
        );
        // Value imports only. `import type` is erased before anything runs, so
        // a type pulled from a server module is not a runtime dependency.
        const imports = [
            ...source.matchAll(/^import\s+(?!type\s)(?:.|\n)*?from\s+"([^"]+)";/gm),
        ].map((match) => match[1]);
        // A bare side-effect import is exactly how "server-only" is used.
        const sideEffects = [...source.matchAll(/^import\s+"([^"]+)";/gm)].map(
            (match) => match[1]
        );

        for (const specifier of [...imports, ...sideEffects]) {
            assert.ok(
                !forbidden.includes(specifier),
                `lib/${moduleName}.ts imports ${specifier}, which is not pure`
            );
            if (specifier.startsWith("@/lib/")) {
                visit(specifier.slice("@/lib/".length));
            }
        }
    };

    visit("routerSelection");
    // The walk has to have actually walked, or this test passes by reading
    // nothing at all.
    assert.ok(seen.has("routerScorePolicy"), "the import walk found nothing");
});
