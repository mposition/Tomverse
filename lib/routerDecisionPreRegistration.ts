/**
 * Fixing `n` and what it is conditional on, before the decision set exists.
 *
 * ## Why this is its own file
 *
 * The pre-registration has to be written before the decision corpus is
 * collected, so it cannot live inside the corpus. It also has to outlive being
 * wrong: if the calibration comes back outside the acceptable range, or the
 * Router changes, this is voided and a new one is frozen — it is not edited.
 *
 * ## What "pre-registered" has to mean here
 *
 * `docs/ops/tomverse-chat-router-evaluation-set.md` §3 fixes `n` from a
 * measured pilot rather than from the answers. The failure that guards against
 * is not a mistake anyone makes on purpose: a run comes back at the edge of
 * the margin, and `n` is revised because "the pilot's discordance estimate was
 * noisy" — which is true, and is also how a sample size becomes an outcome
 * that was chosen. So `n` is refused to a run that does not name the same
 * number, and a change to `n` in this file without a new version is refused in
 * CI. Adjusting `n` after seeing a result is mposition's stated prohibition and
 * it is enforced in both places rather than remembered.
 *
 * ## Activation
 *
 * Pre-registering is not authorising. The registration is `pending` until the
 * judge calibration is accepted and the three frozen values are filled in, and
 * a decision run against a `pending` registration is refused. That is the whole
 * point of the condition: the numbers exist so nobody has to decide them under
 * the pressure of a result, and the run cannot start until the thing they are
 * conditional on has happened.
 */

export const DECISION_PRE_REGISTRATION_VERSION_PREFIX = "route01-decision-prereg-v";

export type PreRegistrationState = "pending" | "active" | "void";

export type RouterVersionsSnapshot = Readonly<Record<string, string>>;

export type DecisionPreRegistration = {
    preRegistrationVersion: string;
    preRegisteredAt: string;
    preRegisteredBy: string;
    /** The sample size the decision run must use. */
    n: number;
    perCell: number;
    cells: number;
    targetPrecisionPp: number;
    rationale: string;
    activation: {
        state: PreRegistrationState;
        /** What has to be true before this may be used. Prose, for a person. */
        condition: string;
        acceptedAt: string | null;
        acceptedBy: string | null;
        /** The calibration artefact that satisfied the condition. */
        calibrationArtefactDigest: string | null;
        /** Set when the state is `void`, so a dead registration says why. */
        voidedReason?: string | null;
    };
    /**
     * Filled in at activation, and unchangeable after it.
     *
     * A pre-registration is only binding on the configuration it was made
     * against: a Router that scores differently is a different experiment
     * wearing the same `n`.
     */
    frozen: {
        routerVersions: RouterVersionsSnapshot | null;
        /** Mirrors `routerVersions.selection`, named because it is the one that decides. */
        selectionPolicyVersion: string | null;
        /** The decision corpus's own frozen digest. */
        corpusDigest: string | null;
    };
    /** The version that replaced this one, when it was superseded rather than used. */
    supersededBy?: string | null;
};

const present = (value: unknown): value is string =>
    typeof value === "string" && value.trim() !== "";

/**
 * Everything wrong with the registration itself. Empty means it is well-formed.
 *
 * Well-formed is not the same as usable: `decisionRunProblems` is what decides
 * whether a run may cite it.
 */
export const preRegistrationProblems = (
    registration: DecisionPreRegistration | null | undefined
): readonly string[] => {
    if (!registration || typeof registration !== "object") {
        return ["the pre-registration is not an object"];
    }
    const problems: string[] = [];
    if (!registration.preRegistrationVersion?.startsWith?.(DECISION_PRE_REGISTRATION_VERSION_PREFIX)) {
        problems.push(
            `version "${String(registration.preRegistrationVersion)}" does not start with ` +
                `${DECISION_PRE_REGISTRATION_VERSION_PREFIX}`
        );
    }
    for (const field of ["preRegisteredAt", "preRegisteredBy", "rationale"] as const) {
        if (!present(registration[field])) problems.push(`the pre-registration has no ${field}`);
    }

    const { n, perCell, cells, targetPrecisionPp } = registration;
    for (const [label, value] of [["n", n], ["perCell", perCell], ["cells", cells]] as const) {
        if (!(typeof value === "number" && Number.isInteger(value) && value > 0)) {
            problems.push(`${label} is ${String(value)}, which is not a positive whole number`);
        }
    }
    // A balanced draw is the point of stating perCell and cells at all: if the
    // three numbers do not agree, one of them is a rounding of the others and
    // nobody can tell which.
    if (
        typeof n === "number" && typeof perCell === "number" && typeof cells === "number" &&
        n !== perCell * cells
    ) {
        problems.push(`n is ${n}, but ${perCell} per cell across ${cells} cells is ${perCell * cells}`);
    }
    if (!(typeof targetPrecisionPp === "number" && targetPrecisionPp > 0)) {
        problems.push(`targetPrecisionPp is ${String(targetPrecisionPp)}, which is not a positive number`);
    }

    const activation = registration.activation;
    if (!activation || typeof activation !== "object") {
        problems.push("the pre-registration has no activation block");
        return problems;
    }
    if (!["pending", "active", "void"].includes(activation.state)) {
        problems.push(`activation state "${String(activation.state)}" is not pending, active or void`);
    }
    if (!present(activation.condition)) {
        problems.push("the activation block does not say what it is conditional on");
    }

    const frozen = registration.frozen ?? { routerVersions: null, selectionPolicyVersion: null, corpusDigest: null };
    if (activation.state === "active") {
        for (const field of ["acceptedAt", "acceptedBy", "calibrationArtefactDigest"] as const) {
            if (!present(activation[field])) {
                problems.push(`the registration is active and has no ${field}`);
            }
        }
        if (!frozen.routerVersions || Object.keys(frozen.routerVersions).length === 0) {
            problems.push("the registration is active and freezes no Router versions");
        }
        for (const field of ["selectionPolicyVersion", "corpusDigest"] as const) {
            if (!present(frozen[field])) problems.push(`the registration is active and freezes no ${field}`);
        }
    }
    // Stated separately rather than derived, because it is the version that
    // decides which model answers; kept from drifting by checking it here.
    if (
        frozen.routerVersions &&
        present(frozen.selectionPolicyVersion) &&
        frozen.routerVersions.selection !== frozen.selectionPolicyVersion
    ) {
        problems.push(
            `selectionPolicyVersion "${frozen.selectionPolicyVersion}" is not routerVersions.selection ` +
                `"${String(frozen.routerVersions.selection)}"`
        );
    }
    if (activation.state === "void" && !present(activation.voidedReason)) {
        problems.push("the registration is void and does not say why");
    }
    return problems;
};

/**
 * Why a decision run may not proceed against this registration. Empty means it may.
 *
 * Checked before the run spends anything: a decision run that discovers its
 * `n` was never activated has paid for a report nobody can cite.
 */
export const decisionRunProblems = (
    registration: DecisionPreRegistration,
    run: {
        preRegisteredN: number;
        routerVersions: RouterVersionsSnapshot;
        corpusDigest: string;
    }
): readonly string[] => {
    const problems = [...preRegistrationProblems(registration)];
    if (problems.length > 0) return problems;

    const { activation, frozen } = registration;
    if (activation.state !== "active") {
        problems.push(
            activation.state === "void"
                ? `this pre-registration is void (${String(activation.voidedReason)}); freeze a new one before collecting`
                : `this pre-registration is still pending on "${activation.condition}", so no decision run may use it`
        );
        return problems;
    }

    if (run.preRegisteredN !== registration.n) {
        problems.push(
            `--preregistered-n=${run.preRegisteredN} is not the registered ${registration.n}. ` +
                "Adjusting n is a new pre-registration, frozen before collecting, never an edit to this one."
        );
    }
    if (frozen.corpusDigest !== run.corpusDigest) {
        problems.push(
            `the decision set's digest ${run.corpusDigest} is not the ${String(frozen.corpusDigest)} this ` +
                "registration was frozen against"
        );
    }
    const registered = frozen.routerVersions ?? {};
    for (const key of new Set([...Object.keys(registered), ...Object.keys(run.routerVersions)])) {
        if (registered[key] !== run.routerVersions[key]) {
            problems.push(
                `Router ${key} is ${String(run.routerVersions[key])} and was frozen at ` +
                    `${String(registered[key])}; a Router that decides differently is a different experiment`
            );
        }
    }
    return problems;
};

/**
 * Why an edit to a committed pre-registration is not allowed.
 *
 * `n` and the frozen configuration are the whole content of a pre-registration.
 * Changing either in place turns "fixed before the run" into "fixed until it
 * was inconvenient", and the file would still read as a pre-registration
 * afterwards. A change to them needs a new version, and the old one has to say
 * it was superseded.
 */
export const preRegistrationEditProblems = (
    before: DecisionPreRegistration,
    after: DecisionPreRegistration
): readonly string[] => {
    if (before.preRegistrationVersion !== after.preRegistrationVersion) return [];
    const problems: string[] = [];
    if (before.n !== after.n) {
        problems.push(
            `n changed from ${before.n} to ${after.n} under the same version ` +
                `"${before.preRegistrationVersion}". A different n is a new pre-registration, ` +
                "frozen before collecting; this one is superseded, not edited."
        );
    }
    if (before.activation.state === "active") {
        for (const field of ["routerVersions", "selectionPolicyVersion", "corpusDigest"] as const) {
            if (JSON.stringify(before.frozen[field]) !== JSON.stringify(after.frozen[field])) {
                problems.push(
                    `${field} changed after activation, under the same version. What a registration was ` +
                        "frozen against cannot be rewritten once it is binding."
                );
            }
        }
    }
    return problems;
};
