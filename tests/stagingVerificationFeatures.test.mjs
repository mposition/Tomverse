import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
    STAGING_VERIFICATION_FEATURES,
    stagingVerificationFeature,
} from "../scripts/staging-verification-features.mjs";

/**
 * The registry is only useful if an entry cannot name files that are not there.
 *
 * A feature listed here with a missing checklist would make
 * `check:staging-verification-records` throw on `readFileSync` -- a stack trace
 * rather than the sentence that says which document is wrong. Worse, a feature
 * *omitted* from here silently keeps no guarantee at all: its checklist can
 * grow a ticked box and a signature, which is the exact failure the split was
 * built to prevent, and nothing would say so.
 */

test("every registered feature has both of its documents", () => {
    for (const feature of STAGING_VERIFICATION_FEATURES) {
        assert.ok(
            existsSync(feature.checklist),
            `${feature.key}: ${feature.checklist} does not exist`
        );
        const template = join(feature.records, "_record-template.md");
        assert.ok(
            existsSync(template),
            `${feature.key}: ${template} does not exist`
        );
        assert.ok(
            existsSync(join(feature.records, "README.md")),
            `${feature.key}: ${feature.records}/README.md does not exist`
        );
    }
});

test("a record template points back at its own checklist", () => {
    // The pair that goes wrong quietly. A template copied from another feature
    // keeps that feature's `checklist:` line, so a finished record cites items
    // it never ran -- and it reads as a completed verification of the wrong
    // thing, which is worse than an obviously blank one.
    for (const feature of STAGING_VERIFICATION_FEATURES) {
        const template = readFileSync(
            join(feature.records, "_record-template.md"),
            "utf8"
        );
        assert.match(
            template,
            new RegExp(`^checklist:\\s*${feature.checklist}$`, "m"),
            `${feature.key}: its record template cites a different checklist`
        );
    }
});

test("keys are unique and paths are not shared", () => {
    const keys = STAGING_VERIFICATION_FEATURES.map((entry) => entry.key);
    assert.equal(new Set(keys).size, keys.length, "duplicate feature key");

    // Two features writing records into one directory would interleave runs of
    // different checklists under the same naming scheme, and the date+SHA name
    // cannot tell them apart.
    const records = STAGING_VERIFICATION_FEATURES.map((entry) => entry.records);
    assert.equal(new Set(records).size, records.length, "shared records directory");

    const checklists = STAGING_VERIFICATION_FEATURES.map((entry) => entry.checklist);
    assert.equal(new Set(checklists).size, checklists.length, "shared checklist");
});

test("an unknown key is refused by name, with the known ones listed", () => {
    // The generator turns this into its own failure message. A thrown
    // `undefined.checklist` further down would say nothing an operator could act
    // on, and the operator here is someone starting a paid verification run.
    assert.throws(
        () => stagingVerificationFeature("image-gen"),
        /Unknown staging verification feature: image-gen.*image-generation/s
    );
    assert.equal(
        stagingVerificationFeature("image-generation").records,
        "docs/ops/image-generation-staging-verification-records"
    );
});

test("image generation is registered, because its checklist gates a paid flag", () => {
    // Named rather than inferred from the array's length. Policy section 15
    // makes this checklist the precondition for turning
    // `feature.imageGenerationEnabled` on in production, so its dropping out of
    // the registry -- and out of the check -- should fail here rather than be
    // noticed when a signature turns up on a stale document.
    const keys = STAGING_VERIFICATION_FEATURES.map((entry) => entry.key);
    assert.ok(keys.includes("image-generation"));
    assert.ok(keys.includes("external-import"));
});
