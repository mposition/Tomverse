/**
 * `n` is fixed before the decision run and conditional on the judge
 * calibration being accepted. mposition's prohibition is specific: adjusting
 * `n` after seeing a result is not allowed, and "the pilot's discordance
 * estimate was noisy" is exactly the true-sounding reason that would be given.
 *
 * So these pin both halves of the enforcement -- a run whose `n` is not the
 * registered one is refused, and a change to `n` under an unchanged version is
 * refused -- along with the activation gate that stops a decision run
 * happening before the thing it is conditional on has.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
    DECISION_PRE_REGISTRATION_VERSION_PREFIX,
    decisionRunProblems,
    preRegistrationEditProblems,
    preRegistrationProblems,
} from "../lib/routerDecisionPreRegistration.ts";

const COMMITTED = "docs/ops/router-decision-preregistration/v1.json";

const ROUTER = {
    decision: "router-decision-v3",
    taskProfile: "task-profile-v2",
    candidates: "router-candidates-v2",
    selection: "router-selection-v4",
    scorePolicy: "router-score-policy-v1",
};

const registration = (overrides = {}) => ({
    preRegistrationVersion: "route01-decision-prereg-v1",
    preRegisteredAt: "2026-08-27",
    preRegisteredBy: "mposition",
    n: 3345,
    perCell: 223,
    cells: 15,
    targetPrecisionPp: 3,
    rationale: "+/-3pp, balanced across the 15 cells.",
    activation: {
        state: "pending",
        condition: "the judge calibration is accepted",
        acceptedAt: null,
        acceptedBy: null,
        calibrationArtefactDigest: null,
        voidedReason: null,
    },
    frozen: { routerVersions: null, selectionPolicyVersion: null, corpusDigest: null },
    supersededBy: null,
    ...overrides,
});

const activated = (overrides = {}) =>
    registration({
        activation: {
            state: "active",
            condition: "the judge calibration is accepted",
            acceptedAt: "2026-09-01T00:00:00Z",
            acceptedBy: "mposition",
            calibrationArtefactDigest: "sha256:cal",
            voidedReason: null,
        },
        frozen: {
            routerVersions: ROUTER,
            selectionPolicyVersion: ROUTER.selection,
            corpusDigest: "sha256:corpus",
        },
        ...overrides,
    });

const run = (overrides = {}) => ({
    preRegisteredN: 3345,
    routerVersions: ROUTER,
    corpusDigest: "sha256:corpus",
    ...overrides,
});

test("the committed registration is well-formed and reads as mposition decided", () => {
    const committed = JSON.parse(readFileSync(COMMITTED, "utf8"));
    assert.deepEqual(preRegistrationProblems(committed), []);
    assert.equal(committed.n, 3345);
    assert.equal(committed.perCell * committed.cells, 3345);
    assert.equal(committed.targetPrecisionPp, 3);
    assert.ok(committed.preRegistrationVersion.startsWith(DECISION_PRE_REGISTRATION_VERSION_PREFIX));
});

test("a pending registration authorises nothing, however well-formed", () => {
    const committed = JSON.parse(readFileSync(COMMITTED, "utf8"));
    assert.equal(committed.activation.state, "pending");
    const problems = decisionRunProblems(committed, run());
    assert.equal(problems.length, 1);
    assert.match(problems[0], /still pending/);
});

test("an activated registration authorises exactly its own n, Router and corpus", () => {
    assert.deepEqual(decisionRunProblems(activated(), run()), []);

    assert.match(
        decisionRunProblems(activated(), run({ preRegisteredN: 3334 })).join(" "),
        /--preregistered-n=3334 is not the registered 3345/
    );
    assert.match(
        decisionRunProblems(activated(), run({ corpusDigest: "sha256:other" })).join(" "),
        /is not the sha256:corpus this registration was frozen against/
    );
    assert.match(
        decisionRunProblems(
            activated(),
            run({ routerVersions: { ...ROUTER, selection: "router-selection-v5" } })
        ).join(" "),
        /Router selection is router-selection-v5 and was frozen at router-selection-v4/
    );
});

test("a Router version the registration never froze is caught, not ignored", () => {
    const problems = decisionRunProblems(
        activated(),
        run({ routerVersions: { ...ROUTER, newStage: "v1" } })
    );
    assert.match(problems.join(" "), /Router newStage is v1 and was frozen at undefined/);
});

test("n cannot change under a version that has already been published", () => {
    const before = registration();
    assert.match(
        preRegistrationEditProblems(before, registration({ n: 1875, perCell: 125 })).join(" "),
        /n changed from 3345 to 1875 under the same version/
    );
    // A new version may say anything: that is what superseding is for.
    assert.deepEqual(
        preRegistrationEditProblems(
            before,
            registration({ preRegistrationVersion: "route01-decision-prereg-v2", n: 1875, perCell: 125 })
        ),
        []
    );
});

test("what an active registration was frozen against cannot be rewritten", () => {
    const before = activated();
    const problems = preRegistrationEditProblems(
        before,
        activated({ frozen: { routerVersions: ROUTER, selectionPolicyVersion: ROUTER.selection, corpusDigest: "sha256:other" } })
    );
    assert.match(problems.join(" "), /corpusDigest changed after activation/);

    // Before activation it is still being written, so filling it in is not an
    // edit to something binding.
    assert.deepEqual(
        preRegistrationEditProblems(
            registration(),
            registration({ frozen: { routerVersions: ROUTER, selectionPolicyVersion: ROUTER.selection, corpusDigest: "sha256:corpus" } })
        ),
        []
    );
});

test("the three sample-size numbers have to agree with each other", () => {
    assert.match(
        preRegistrationProblems(registration({ n: 3334 })).join(" "),
        /n is 3334, but 223 per cell across 15 cells is 3345/
    );
});

test("an active registration with nothing frozen is refused", () => {
    const problems = preRegistrationProblems(
        registration({
            activation: {
                state: "active",
                condition: "c",
                acceptedAt: null,
                acceptedBy: null,
                calibrationArtefactDigest: null,
                voidedReason: null,
            },
        })
    );
    for (const marker of [/no acceptedAt/, /no acceptedBy/, /no calibrationArtefactDigest/, /freezes no Router versions/, /freezes no corpusDigest/]) {
        assert.match(problems.join(" "), marker);
    }
});

test("the named selection policy cannot drift from the Router snapshot", () => {
    assert.match(
        preRegistrationProblems(
            activated({
                frozen: { routerVersions: ROUTER, selectionPolicyVersion: "router-selection-v9", corpusDigest: "sha256:corpus" },
            })
        ).join(" "),
        /selectionPolicyVersion "router-selection-v9" is not routerVersions.selection "router-selection-v4"/
    );
});

test("a void registration says why, and authorises nothing", () => {
    const dead = registration({
        activation: {
            state: "void",
            condition: "c",
            acceptedAt: null,
            acceptedBy: null,
            calibrationArtefactDigest: null,
            voidedReason: null,
        },
    });
    assert.match(preRegistrationProblems(dead).join(" "), /is void and does not say why/);

    const explained = registration({
        activation: { ...dead.activation, voidedReason: "the calibration shift fell outside the accepted range" },
    });
    assert.deepEqual(preRegistrationProblems(explained), []);
    assert.match(decisionRunProblems(explained, run()).join(" "), /is void \(the calibration shift/);
});
