/**
 * An inventory of what the repository actually holds against each release gate.
 *
 * `docs/release-gates/tomverse-chat-v1.yaml` is the approval system of record,
 * and every one of its forty gates reads `status: pending` with empty
 * `evidenceRefs`. That is the correct state, not a defect: the registry is
 * `metadata.status: draft` and `governance.implementationStatus: planned`, and
 * the validator only enforces approvals under `--release`, which CI does not
 * pass. Nothing here proposes changing any of it.
 *
 * What the register cannot answer while it sits in draft is the question anyone
 * picking up work actually asks: of the forty, which have nothing built yet,
 * which are built but unmeasured, and which already have the artefact the gate
 * names and are only waiting on a person? "Pending" is one word for all three.
 *
 * So this reads the gates and reports, per gate, which named evidence exists in
 * the tree. Three rules keep it honest:
 *
 *   1. **It never writes.** No status is flipped, no `evidenceRefs` filled, no
 *      approval implied. Approval is a human act performed in the registry, and
 *      a report that edited its own subject would destroy the audit trail the
 *      registry exists to be.
 *   2. **Existence is not satisfaction.** That `tests/refundSagaCore.test.mjs`
 *      exists says an artefact is there to run, not that
 *      `duplicate_goodwill_refunds` is zero. Every verdict below is about
 *      artefacts; none is about thresholds, and `evidence_present` is
 *      deliberately not called `passing`.
 *   3. **A gate nobody has mapped is reported as unmapped.** Guessing which
 *      files answer a gate from the wording of its `evidence` line would
 *      manufacture confidence about the gates nobody has looked at -- which is
 *      the failure this is meant to prevent, one level up.
 *
 * `appliesWhen` is a runtime condition, not a repository fact. The four memory
 * gates apply only when Release B is enabled, and that lives in `AppSetting`
 * rows (`feature.memoryExtractionEnabled`, `feature.memoryInjectionEnabled`) in
 * whichever database is being asked about. Unless a caller supplies the answer,
 * those gates are reported as `applicability_unknown` rather than assumed off:
 * assuming off would quietly excuse four blocking privacy and safety gates.
 */

/**
 * What each gate's evidence would be, in this repository, written by hand.
 *
 * `capability` is what would have to exist for the gate's subject to exist at
 * all. `measurement` is what produces the number the gate's criteria are stated
 * in. The split matters: a gate with capability and no measurement is built and
 * unproven, which is a different piece of work from one with neither.
 *
 * `note` carries what the paths cannot say -- most often that the measurement
 * needs production or load data this repository does not contain, so the
 * artefact being present is a smaller claim than the gate.
 */
export const GATE_EVIDENCE = {
    "ROUTE-01": {
        capability: ["lib/routerDecision.ts", "lib/routerCandidates.ts", "lib/routerSelection.ts"],
        measurement: [],
        note: "The decision path exists. The gate wants a versioned paired evaluation with a fixed-model baseline, seed and CI bounds; no harness in the tree produces one.",
    },
    "ROUTE-02": {
        capability: ["lib/routerDecision.ts"],
        measurement: [],
        note: "Needs a production-like load trace grouped by router version. Latency under load is not observable from this repository.",
    },
    "ROUTE-03": {
        capability: ["lib/routerDecision.ts"],
        measurement: [],
        note: "Same as ROUTE-02, for the assisted-routing cohort, and additionally a TTFT delta.",
    },
    "ROUTE-04": {
        capability: ["lib/routingShadowReport.ts", "scripts/report-routing-shadow.mjs"],
        measurement: ["tests/routingShadowReport.test.mjs"],
        note: "The reporting path exists and is tested. The gate's number is a production RoutingRun segmentation, which the report can compute only against real routing data.",
    },
    "ROUTE-05": {
        capability: ["lib/routerDecision.ts"],
        measurement: [],
        note: "Wants a RoutingRun invariant query plus adversarial context tests. Neither exists.",
    },
    "ROUTE-06": {
        capability: ["lib/routerDecision.ts"],
        measurement: [],
        note: "Wants a RoutingAttempt-to-ContextManifest integrity query. No manifest module is in the tree yet.",
    },
    "ROUTE-07": {
        capability: ["lib/routingShadowReport.ts", "scripts/report-routing-shadow.mjs"],
        measurement: ["tests/routingShadow.test.mjs", "tests/integration/routing-shadow.db.test.ts"],
        note: "Recording is exercised end to end against a database. The 99.9% figure is a sampled production reconciliation.",
    },

    "ESTIMATE-01": {
        capability: ["lib/chatTokenEstimate.ts"],
        measurement: [
            "scripts/report-token-estimate-accuracy.mjs",
            "tests/tokenEstimateCalibration.test.mjs",
        ],
        note: "Estimator, accuracy report and calibration tests are all present. The p50 figure comes from the report run against recorded production estimates.",
    },
    "ESTIMATE-02": {
        capability: ["lib/chatTokenEstimate.ts"],
        measurement: [
            "scripts/report-token-estimate-accuracy.mjs",
            "tests/tokenEstimateShadow.test.mjs",
        ],
        note: "Same artefacts as ESTIMATE-01; the gate differs only in reading the p95 of the same distribution.",
    },
    "ESTIMATE-03": {
        capability: ["lib/chatTokenEstimate.ts", "scripts/check-router-context-window.mjs"],
        measurement: [
            "scripts/check-context-window-register.mjs",
            "tests/chatTokenEstimate.test.mjs",
        ],
        note: "The guard is a fail-closed check rather than a measured rate, which is the stronger form for an `eq 0` criterion. The production RoutingAttempt audit half is still owed.",
    },

    "FALLBACK-01": {
        capability: ["lib/providerFallbackCandidates.ts"],
        measurement: ["tests/providerFallbackCandidates.test.mjs"],
        note: "Candidate selection is tested. The gate's 95% is an injected-failure evaluation with a denominator breakdown, which no harness produces.",
    },
    "FALLBACK-02": {
        capability: ["lib/providerFallbackCandidates.ts"],
        measurement: ["tests/automaticFallbackAbsence.test.mjs"],
        note: "The invariant is held in the stronger form: there is no automatic model substitution at all, so none can begin after a visible token. The scan pins one streamText call, one resolved model assigned once and not derived from the fallback table, and an allowlist of the surfaces that may name an alternative -- all of which only offer it. The production audit half is still owed, and would now be confirming a zero rather than discovering one.",
    },
    "FALLBACK-03": {
        capability: ["lib/providerFallbackCandidates.ts"],
        measurement: [],
        note: "Depends on the context manifest that ROUTE-06 also waits on.",
    },

    "PLANNER-01": {
        capability: [],
        measurement: [],
        note: "No Prompt Planner in the tree. Phase 5 work.",
    },
    "PLANNER-02": {
        capability: [],
        measurement: [],
        note: "Follows PLANNER-01: a cost-growth gate cannot be measured against a planner that does not exist, and its criterion is stated as cost increase without approved quality evidence, so it also waits on PLANNER-01's evaluation being approved.",
    },
    "PLANNER-03": {
        capability: ["lib/chatContextBundleCore.ts"],
        measurement: [],
        note: "Instruction precedence over untrusted content is a live concern before the planner exists -- memory, attachments and imports already reach the prompt -- and no prompt-injection test report covers it.",
    },

    "BILLING-01": {
        capability: ["lib/creditLedger.ts", "lib/chatCreditAllocation.ts"],
        measurement: [
            "tests/integration/credit-finance.db.test.ts",
            "tests/creditLockOrder.test.mjs",
        ],
        note: "Reservation and settlement idempotency is exercised against a real database, including the lock ordering that makes it hold under concurrency.",
    },
    "BILLING-02": {
        capability: ["lib/creditLedger.ts", "scripts/run-credit-reconciliation.mjs"],
        measurement: ["tests/integration/credit-finance.db.test.ts"],
        note: "The reconciliation job exists and is exercised. The gate asks for its report over a real reconciliation window.",
    },
    "BILLING-03": {
        capability: ["lib/creditLedger.ts"],
        measurement: [
            "scripts/report-credit-lot-invariants.mjs",
            "tests/creditLockOrder.test.mjs",
        ],
        note: "The invariant report exists. AGENTS.md records the remaining step: the CreditLot non-negative CHECK shipped NOT VALID and is validated in a separate migration once the report returns zero against production.",
    },
    "BILLING-04": {
        capability: [],
        measurement: ["tests/refundSagaCore.test.mjs", "tests/integration/refund-decision-route.db.test.ts"],
        note: "The refund saga covers Stripe money refunds, keyed per refund request. A goodwill refund is a discretionary credit grant, and no such path exists: `lib/creditLedger.ts` reserves, settles, expires and purchases, with no administrator grant. Its idempotency key, authority and ledger shape are undecided.",
    },

    "ABUSE-01": {
        capability: ["lib/chatSecurity.ts", "lib/chatRateLimitCore.ts"],
        measurement: [
            "tests/integration/chat-concurrency.db.test.ts",
            "tests/integration/chat-rate-limit.db.test.ts",
        ],
        note: "Concurrency and rate-limit enforcement are exercised against a database. The gate additionally names device and IP abuse tests in adversarial form.",
    },
    "MODERATION-01": {
        capability: [],
        measurement: [],
        note: "No moderation module in the tree, and the gate's coverage is defined over the dispatch paths -- Auto Router, pass-through and fallback -- that are themselves still being built.",
    },

    "MEMORY-01": {
        capability: ["lib/memoryRetrievalService.ts"],
        measurement: [],
        note: "Retrieval exists. A Korean-first recall set with NFC normalization and bigram ranking is not in the tree.",
    },
    "MEMORY-02": {
        capability: ["lib/memoryRetrievalService.ts"],
        measurement: [],
        note: "Wants an adjudicated injection evaluation.",
    },
    "MEMORY-03": {
        capability: ["lib/memoryRetrievalService.ts"],
        measurement: [],
        note: "Zero-tolerance, and no adversarial sensitive-memory evaluation exists.",
    },
    "MEMORY-04": {
        capability: ["lib/memorySourceDeletion.ts"],
        measurement: ["tests/integration/memory-source-deletion.db.test.ts"],
        note: "Deletion propagation is exercised against a database; supersession is the half the gate also names.",
    },

    "UI-01": {
        capability: ["components/chat/ComparisonReviewDialog.tsx"],
        measurement: ["tests/e2e/comparison-review.spec.ts"],
        note: "A Review regression suite exists. The gate additionally wants it frozen and an approved visual snapshot comparison for critical Review states.",
    },
    "UI-02": {
        capability: ["components/chat/MobileChatShell.tsx"],
        measurement: [
            "tests/e2e/mobile-composer-contract.spec.ts",
            "tests/e2e/mobile-short-viewport-drawer.spec.ts",
        ],
        note: "Mobile viewport coverage is substantial. The native-shell half of the report has nowhere to run until the shell exists.",
    },

    "PACKAGE-01": {
        capability: ["packages"],
        measurement: [
            "scripts/check-shared-packages.mjs",
            "tests/sharedPackages.test.mjs",
            "scripts/verify-package-build-matrix.mjs",
        ],
        note: "Both named artefacts exist: the ESLint no-restricted-imports report (check:shared-packages, which counts the metric through ESLint's own API) and the Next.js/Vite build matrix (next build plus verify:package-build-matrix, which bundles the packages with no Next.js present and runs the result). Approved 2026-08-12 against docs/release-gates/evidence/PACKAGE-01-2026-08-12.md, which pins the commit and the CI runs. The approval covers the two packages that existed at that commit; chat-ui and api-client are not in the tree, so the gate is worth re-reading rather than inheriting when they arrive.",
    },

    "AUTH-01": {
        capability: ["lib/auth.ts"],
        measurement: [],
        note: "Needs a physical-device E2E report; not producible in this repository.",
    },
    "AUTH-02": {
        capability: ["lib/auth.ts"],
        measurement: [],
        note: "The mobile token path the gate is stated over is Phase 2 work.",
    },
    "AUTH-03": {
        capability: [],
        measurement: [],
        note: "No mobile bearer-token lifecycle yet.",
    },
    "AUTH-04": {
        capability: [],
        measurement: [],
        note: "Deep links belong to the native shell.",
    },

    "PRIVACY-01": {
        capability: ["lib/accountDeletion.ts", "lib/accountDataAnonymisation.ts"],
        measurement: [
            "scripts/check-data-domain-registry.mjs",
            "tests/integration/account-anonymisation.db.test.ts",
            "tests/accountDataAnonymisation.test.mjs",
        ],
        note: "Every artefact the gate names by path exists, and the registry check reports 37 domains with no planned or unverified row. What is left is the in-app deletion E2E covering reauthentication and token revocation.",
    },
    "PRIVACY-02": {
        capability: ["lib/accountDataExport.ts", "lib/accountDataExportDomains.ts", "lib/accountDataExportTickets.ts"],
        measurement: [
            "tests/integration/account-data-export.db.test.ts",
            "tests/integration/account-data-export-ticket.db.test.ts",
            "tests/accountDataExportTicket.test.mjs",
            "tests/e2e/account-data-download.spec.ts",
        ],
        note: "Every artefact this gate names by path exists, including the download security E2E and the concurrent ticket-redemption coverage.",
    },

    "STORE-01": {
        capability: [],
        measurement: [],
        note: "A clean-device review-path E2E has nowhere to run before the store build exists.",
    },
    "STORE-02": {
        capability: [],
        measurement: [],
        note: "Daily synthetic-login history is an operational artefact produced during an active submission.",
    },

    "MANIFEST-01": {
        capability: [],
        measurement: [],
        note: "No context manifest module; ROUTE-06 and FALLBACK-03 wait on the same thing.",
    },
    "MANIFEST-02": {
        capability: [],
        measurement: [],
        note: "Follows MANIFEST-01. Its retention half is separable and already has a neighbour to follow -- the ninety-day audit retention that account-data-export-ticket already implements and tests -- but there is no manifest for it to retain.",
    },

    "PUSH-01": {
        capability: ["scripts/check-push-scope.mjs"],
        measurement: [],
        note: "Inverted by design: the gate is met by push infrastructure being *absent*, so what gets built for it is the assertion rather than a feature. check:push-scope now runs in the PR Fast Gate over dependencies, sources, the Prisma schema, routes and server credentials, and tests/pushScope.test.mjs pins its false positives as deliberately as its true ones -- the email NotificationDelivery queue and a Stripe getSubscription must not trip it, or the gate gets switched off. Deliberately NOT counted as the gate's evidence: it names a release bill of materials and a scope review, and neither exists. This states what the tree contains; approving a use case stays a decision recorded on the gate.",
    },
};

/**
 * The verdicts, and what each one means for someone choosing work:
 *
 * - `applicability_unknown`  -- `appliesWhen` names a runtime condition the
 *                               caller did not supply. Decide the condition
 *                               before reading anything else about this gate.
 * - `not_applicable`         -- the caller supplied the condition and it is off.
 * - `unmapped`               -- nobody has written down what this gate's
 *                               evidence is here. Not a statement about the gate.
 * - `not_implemented`        -- the subject does not exist yet. Real work, and
 *                               the only group worth reading as a backlog.
 * - `implemented_unmeasured` -- it exists and nothing produces the gate's
 *                               number. Usually a test or a report, not a feature.
 * - `evidence_present`       -- every artefact the mapping names exists. NOT a
 *                               claim that the criteria are met: the artefacts
 *                               still have to be run and read by a person, and
 *                               most of these gates are stated over production
 *                               data this repository does not hold.
 */
export const GATE_VERDICTS = {
    APPLICABILITY_UNKNOWN: "applicability_unknown",
    NOT_APPLICABLE: "not_applicable",
    UNMAPPED: "unmapped",
    NOT_IMPLEMENTED: "not_implemented",
    IMPLEMENTED_UNMEASURED: "implemented_unmeasured",
    EVIDENCE_PRESENT: "evidence_present",
};

/**
 * @param {{id: string, appliesWhen?: string, status?: string, evidenceRefs?: string[]}} gate
 * @param {{
 *   exists: (path: string) => boolean,
 *   conditions?: Record<string, boolean>,
 *   mapping?: Record<string, {capability: string[], measurement: string[], note?: string}>,
 * }} input
 */
export const classifyGate = (gate, { exists, conditions = {}, mapping = GATE_EVIDENCE }) => {
    const base = {
        id: gate.id,
        status: gate.status ?? null,
        appliesWhen: gate.appliesWhen ?? null,
        evidenceRefCount: (gate.evidenceRefs ?? []).length,
    };

    if (gate.appliesWhen) {
        const enabled = conditions[gate.appliesWhen];
        if (enabled === undefined) {
            return {
                ...base,
                verdict: GATE_VERDICTS.APPLICABILITY_UNKNOWN,
                present: [],
                missing: [],
                note: `${gate.appliesWhen} is a runtime condition; supply it to classify this gate.`,
            };
        }
        if (!enabled) {
            return {
                ...base,
                verdict: GATE_VERDICTS.NOT_APPLICABLE,
                present: [],
                missing: [],
                note: `${gate.appliesWhen} is off.`,
            };
        }
    }

    const entry = mapping[gate.id];
    if (!entry) {
        return {
            ...base,
            verdict: GATE_VERDICTS.UNMAPPED,
            present: [],
            missing: [],
            note: "No evidence mapping has been written for this gate.",
        };
    }

    const split = (paths) => ({
        present: paths.filter((path) => exists(path)),
        missing: paths.filter((path) => !exists(path)),
    });
    const capability = split(entry.capability);
    const measurement = split(entry.measurement);

    const present = [...capability.present, ...measurement.present];
    const missing = [...capability.missing, ...measurement.missing];

    let verdict;
    if (entry.capability.length === 0 || capability.present.length === 0) {
        verdict = GATE_VERDICTS.NOT_IMPLEMENTED;
    } else if (entry.measurement.length === 0 || measurement.missing.length > 0) {
        verdict = GATE_VERDICTS.IMPLEMENTED_UNMEASURED;
    } else {
        verdict = GATE_VERDICTS.EVIDENCE_PRESENT;
    }

    return { ...base, verdict, present, missing, note: entry.note ?? null };
};

/**
 * Classifies every gate and groups them.
 *
 * `backlog` is the group to read as work: gates whose subject does not exist.
 * `unproven` is the cheaper group -- something exists and nothing measures it,
 * which is usually a test rather than a feature. Neither is a claim that a
 * threshold is met, and `evidencePresent` least of all.
 */
export const inventoryReleaseGates = ({ gates, exists, conditions = {}, mapping = GATE_EVIDENCE }) => {
    const classified = gates.map((gate) => classifyGate(gate, { exists, conditions, mapping }));
    const of = (...verdicts) => classified.filter((gate) => verdicts.includes(gate.verdict));

    return {
        classified,
        backlog: of(GATE_VERDICTS.NOT_IMPLEMENTED),
        unproven: of(GATE_VERDICTS.IMPLEMENTED_UNMEASURED),
        evidencePresent: of(GATE_VERDICTS.EVIDENCE_PRESENT),
        undetermined: of(GATE_VERDICTS.APPLICABILITY_UNKNOWN, GATE_VERDICTS.UNMAPPED),
        notApplicable: of(GATE_VERDICTS.NOT_APPLICABLE),
    };
};
