/**
 * Decides which open issues are still real work, by asking the repository
 * rather than the tracker.
 *
 * On 2026-08-12 every one of the six open issues was already resolved in code
 * on `develop`, and a task recommendation offered one of them as the next thing
 * to build. Nothing was wrong with the tracker's data -- the issues were open,
 * because closing them is a separate act that nobody had performed. The gap is
 * that "open" and "not yet done" are different facts, and only the first one is
 * cheap to read.
 *
 * So this asks the second question directly, from three independent angles. It
 * never collapses them into one boolean: each signal is reported with what it
 * looked at, because a signal that cannot be checked is how a stale list gets
 * believed a second time.
 *
 *   1. `pricing` -- for the model-pricing issues this repository keeps
 *      producing, does the model have an explicit MODEL_PRICING profile and has
 *      it left PENDING_VERIFIED_PRICE_REGISTER? That pair is the actual
 *      definition of done for them, and it is what four open issues had already
 *      met.
 *   2. `probe`   -- a hand-written predicate for an issue whose completion
 *      nothing generic can see. Each one restates that issue's own definition of
 *      done as something executable, and carries the remainder it does *not*
 *      cover, so a partially finished issue is never reported as finished.
 *   3. `commits` -- does any commit reachable from a release branch reference
 *      the issue number? The weakest of the three and deliberately never enough
 *      on its own: a commit that mentions an issue may have closed it, may have
 *      touched it in passing, or may be a merge subject naming a pull request
 *      that happens to share the number.
 *
 * Both content signals are evaluated **once per release branch**, not once
 * against the working tree. That distinction is the reason this file exists in
 * the shape it does: on the day it was written `main` was 117 commits behind
 * `develop`, and the six open issues were not uniformly split across that gap.
 * The four pricing profiles had reached `main`; the encoding-checker fix for
 * #278 had not. A tool that answered "is it fixed?" with one boolean would have
 * been wrong about one of those two groups whichever branch it happened to read.
 *
 * A probe is deliberately per-issue and hand-written. Inferring completion from
 * the wording of a title is the same mistake one level up: it would produce
 * confident answers about issues nobody checked.
 */

/** `#123`, but not inside a longer token such as a colour or an anchor. */
const ISSUE_REFERENCE = /(?:^|[^\w#])#(\d{1,6})(?!\w)/g;

/**
 * Issue numbers referenced by a commit's subject and body.
 *
 * Merge subjects ("Merge pull request #437 from ...") name the *pull request*,
 * not the issue it closes, and the two share a numbering space on GitHub. They
 * are kept anyway and marked, because a pull request number that collides with
 * an open issue's number is exactly the coincidence a reviewer has to see to
 * dismiss -- silently dropping merges would instead hide the real closing
 * commits that only ever appear in a merge subject.
 */
export const issueReferencesInCommit = (commit) => {
    ISSUE_REFERENCE.lastIndex = 0;
    const text = `${commit.subject ?? ""}\n${commit.body ?? ""}`;
    return new Set(
        [...text.matchAll(ISSUE_REFERENCE)].map((match) => Number(match[1]))
    );
};

/** True when the commit's subject is GitHub's own merge-commit wording. */
export const isMergeSubject = (subject) =>
    /^Merge (?:pull request #\d+|branch |remote-tracking branch )/.test(
        subject ?? ""
    );

/**
 * The priced and pending-verification model IDs recorded in a given revision of
 * `lib/modelPricing.ts`.
 *
 * A text scan rather than an import, because the question is asked of several
 * git revisions and only one of them is the working tree that could be
 * imported. The split is positional: everything before the
 * `PENDING_VERIFIED_PRICE_REGISTER` declaration is a profile and everything
 * after it is a register entry. That holds because the register is declared
 * after MODEL_PRICING and is the last block in the file to carry `modelId`
 * literals -- and because it is a shortcut rather than a parse, the script
 * checks this result against the imported module for the working tree and fails
 * if the two disagree.
 *
 * The declaration is matched at the start of a line so the several comments
 * elsewhere in the file that discuss the register by name do not move the split.
 */
export const parseModelPricingSource = (source) => {
    const declaration = source.match(
        /^export const PENDING_VERIFIED_PRICE_REGISTER\b/m
    );
    const boundary = declaration?.index ?? source.length;
    const priced = new Set();
    const pending = new Set();
    for (const match of source.matchAll(/\bmodelId:\s*"([^"]+)"/g)) {
        (match.index < boundary ? priced : pending).add(match[1].toLowerCase());
    }
    return { pricedModelIds: priced, pendingPriceModelIds: pending };
};

/**
 * Model identifiers named in an issue title.
 *
 * Two shapes cover every pricing issue this repository has filed:
 * "Verify production pricing: <id>" and "Move <id> pricing from environment
 * variables into MODEL_PRICING". Titles write the vendor's casing ("GLM-5.2")
 * while `lib/modelPricing.ts` writes the API slug ("glm-5.2"), so the result is
 * lower-cased here and compared that way.
 */
export const modelIdsInIssueTitle = (title) => {
    const ids = new Set();
    const verify = title.match(/^Verify production pricing:\s*(\S+)\s*$/);
    if (verify) ids.add(verify[1].toLowerCase());
    const move = title.match(
        /^Move (\S+) pricing from environment variables into MODEL_PRICING$/
    );
    if (move) ids.add(move[1].toLowerCase());
    return ids;
};

/**
 * Whether a title-derived identifier names a registered model.
 *
 * The provider prefix is optional on both sides: issue #248 says
 * `perplexity/sonar-deep-research` and so does the profile, but #244 says
 * `claude-fable-5` against a profile of the same name, and either could gain or
 * lose the prefix without the issue being re-titled. The suffix is only allowed
 * to decide it when exactly one side carries a prefix, so two genuinely
 * different models never match on their tail.
 */
const matchesModelId = (candidate, modelId) => {
    const left = candidate.toLowerCase();
    const right = modelId.toLowerCase();
    if (left === right) return true;
    return (
        left.split("/").pop() === right.split("/").pop() &&
        left.includes("/") !== right.includes("/")
    );
};

/**
 * Per-issue predicates, for completion that leaves no generic trace.
 *
 * `resolvedWhen` receives one branch's state, so this module stays pure and the
 * tests can drive it without a working tree. It returns `null` when the evidence
 * it needs is unavailable -- a missing file is "cannot tell", never "resolved".
 *
 * `remainder` states what the predicate does *not* prove, and is what keeps an
 * issue out of the resolved list even when its code has landed everywhere.
 */
export const ISSUE_PROBES = [
    {
        issue: 278,
        title: "Free the encoding checker from the TypeScript JavaScript compiler API",
        looksAt: "scripts/text-encoding-check-core.mjs",
        resolvedWhen: ({ readFile }) => {
            const source = readFile("scripts/text-encoding-check-core.mjs");
            if (source === null) return null;
            return !/\bfrom\s*["']typescript["']|require\(\s*["']typescript["']\s*\)/.test(
                source
            );
        },
        remainder:
            "The `typescript >=7` hold in .github/dependabot.yml stays, but no longer for either reason " +
            "the issue gives: Next.js 16.3 runs the project-local tsc CLI and no longer needs the compiler " +
            "API. The blocker measured on 2026-08-12 is the typescript-eslint that eslint-config-next " +
            "bundles, which throws on any major >= 7. Remove the entry once that accepts TypeScript 7.",
    },
    {
        issue: 256,
        title: "Move GLM-5.2 pricing from environment variables into MODEL_PRICING",
        looksAt: "lib/modelPricing.ts",
        resolvedWhen: ({ pricedModelIds }) =>
            [...pricedModelIds].some((id) => matchesModelId("glm-5.2", id)),
        remainder:
            "Steps 4-6 of the issue's migration order are operational: deploy the profile to production, " +
            "confirm costSource=registry, then remove the three CHAT_MODEL_GLM_5_2_* variables. " +
            "Staging is done; production still holds both the variables and the seeded registry row.",
    },
    {
        issue: 636,
        title: "Deprecate creation of fixed-amount billing promotions",
        looksAt: "app/api/admin/billing/route.ts",
        resolvedWhen: ({ readFile }) => {
            const source = readFile("app/api/admin/billing/route.ts");
            if (source === null) return null;
            // The block has to name the column it refuses. A percent-only rule
            // that never mentions `discountAmountCents` is not this issue.
            return (
                /discountAmountCents/.test(source) &&
                /percentage[- ]only|fixed[- ]amount/i.test(source)
            );
        },
        // The inventory this used to be blocked on was taken on 2026-08-16:
        // zero active fixed-amount codes, `PAYMENTTEST27` deactivated, recorded
        // in docs/policy/promotion-discount-currency.md §6.1. `blockedOn` is
        // gone rather than rewritten -- the report distinguishes "not started
        // because it must not be" from "not started", and this is neither.
        remainder:
            "`discountAmountCents` stays in the schema for the audit trail: dropping it is a separate " +
            "migration behind the three conditions in docs/policy/promotion-discount-currency.md §5. " +
            "The probe reads the API route only, so the Admin panel's half of the block " +
            "(components/admin/BillingAdminPanel.tsx) is covered by tests rather than by this signal.",
    },
    {
        issue: 637,
        title: "Verify the production AUD billing price override",
        looksAt: "lib/billingPriceCatalog.ts",
        resolvedWhen: () =>
            // Nothing in the tree can answer this. The question is what
            // production's AppSetting holds, who set it and what Stripe
            // actually charges; a probe that guessed from the default catalogue
            // would be answering a different question confidently.
            false,
        blockedOn:
            "Production reads: AppSetting.billingPriceCatalog and its AdminAuditLog entry, a recent AUD " +
            "Checkout Session's unit_amount, and existing AUD subscription item Prices. Note that " +
            "checkout builds an ad-hoc price_data per Session while plan change uses " +
            "BillingPlan.stripePriceId, so there are two price sources and nothing reconciles them. " +
            "Do not change the catalogue before the verification: reverting an override with no " +
            "approval record is itself a price change.",
    },
];

/**
 * @typedef {object} BranchState
 * @property {(path: string) => string | null} readFile Repository-relative reader at this revision.
 * @property {Set<string>} pricedModelIds Model IDs with an explicit MODEL_PRICING profile.
 * @property {Set<string>} pendingPriceModelIds Model IDs still in PENDING_VERIFIED_PRICE_REGISTER.
 *
 * @typedef {object} BacklogFacts
 * @property {string[]} refs Release branches, in promotion order.
 * @property {(ref: string) => BranchState} stateAt
 * @property {Map<number, Array<{sha: string, subject: string, branches: string[]}>>} commitsByIssue
 */

/**
 * The verdicts, and what each one means for a task list:
 *
 * - `resolved_in_code`        -- done on every release branch. Never offer it.
 * - `code_complete_remainder` -- the code landed everywhere and the probe states
 *                                what is still outstanding. The remainder is
 *                                deliberately not sub-typed: #256's is a
 *                                production deploy this team performs and #278's
 *                                is Next.js shipping TypeScript 7 support, and
 *                                the only thing a task list needs from both is
 *                                that neither is code to write today. The
 *                                `remainder` text says which.
 * - `resolved_not_on_all_branches` -- done on some release branches and not
 *                                others. Not a development task and not finished
 *                                either: what it needs is a promotion.
 * - `landed_but_unverified`   -- commits name the issue and nothing checks its
 *                                definition of done. A person has to look.
 * - `open_work`               -- no signal anywhere. This is the candidate list.
 */
export const VERDICTS = {
    RESOLVED_IN_CODE: "resolved_in_code",
    CODE_COMPLETE_REMAINDER: "code_complete_remainder",
    RESOLVED_NOT_ON_ALL_BRANCHES: "resolved_not_on_all_branches",
    LANDED_BUT_UNVERIFIED: "landed_but_unverified",
    /**
     * Not done, and not startable either.
     *
     * `candidates` answers "what may I pick up", and an issue whose first step
     * is reading production is not one of them: the work cannot begin and a
     * session that tries will either stall or guess. That is a different state
     * from `open_work`, and collapsing the two is what would send someone to
     * implement an Admin restriction without knowing which promotions are live.
     *
     * Declared by a probe's `blockedOn`, which names what is being waited for.
     */
    BLOCKED: "blocked",
    OPEN_WORK: "open_work",
};

/** The content signals for one issue on one branch. */
const signalsForBranch = (issue, ref, state) => {
    const signals = [];

    for (const modelId of modelIdsInIssueTitle(issue.title)) {
        const priced = [...state.pricedModelIds].find((id) =>
            matchesModelId(modelId, id)
        );
        const pending = [...state.pendingPriceModelIds].some((id) =>
            matchesModelId(modelId, id)
        );
        signals.push({
            kind: "pricing",
            ref,
            resolved: Boolean(priced) && !pending,
            detail: !priced
                ? `No MODEL_PRICING profile matches ${modelId}.`
                : pending
                  ? `${priced} has a profile but is still registered as pending verification.`
                  : `${priced} has an explicit MODEL_PRICING profile and is not in PENDING_VERIFIED_PRICE_REGISTER.`,
        });
    }

    for (const probe of ISSUE_PROBES) {
        if (probe.issue !== issue.number) continue;
        const outcome = probe.resolvedWhen(state);
        if (outcome === null) {
            signals.push({
                kind: "probe",
                ref,
                resolved: false,
                unavailable: true,
                detail: `Could not read ${probe.looksAt}, so this probe proves nothing.`,
            });
            continue;
        }
        signals.push({
            kind: "probe",
            ref,
            resolved: outcome,
            remainder: outcome ? probe.remainder : undefined,
            // Carried only while unresolved: once the issue is done, what it
            // was once waiting for is history rather than a warning.
            blockedOn: outcome ? undefined : probe.blockedOn,
            detail: outcome
                ? `${probe.looksAt} satisfies the issue's definition of done.`
                : `${probe.looksAt} does not yet satisfy the issue's definition of done.`,
        });
    }

    return signals;
};

/**
 * @param {{number: number, title: string}} issue
 * @param {BacklogFacts} facts
 */
export const classifyIssue = (issue, facts) => {
    const signals = [];
    /** Branches where every content signal this issue has came back resolved. */
    const resolvedOn = [];
    /** Branches that produced at least one content signal at all. */
    const evaluatedOn = [];

    for (const ref of facts.refs) {
        const branchSignals = signalsForBranch(issue, ref, facts.stateAt(ref));
        if (branchSignals.length === 0) continue;
        signals.push(...branchSignals);
        evaluatedOn.push(ref);
        if (branchSignals.every((signal) => signal.resolved)) resolvedOn.push(ref);
    }

    const commits = facts.commitsByIssue.get(issue.number) ?? [];
    const substantive = commits.filter((commit) => !isMergeSubject(commit.subject));
    const commitBranches = [
        ...new Set(commits.flatMap((commit) => commit.branches)),
    ].sort();
    if (commits.length > 0) {
        signals.push({
            kind: "commits",
            resolved: false,
            detail:
                `${commits.length} commit(s) reference #${issue.number}` +
                (commitBranches.length > 0
                    ? ` on ${commitBranches.join(", ")}`
                    : " on no release branch") +
                (substantive.length === 0
                    ? ". All are merge subjects, so the number may be a pull request rather than this issue."
                    : "."),
            branches: commitBranches,
        });
    }

    const remainder = signals.find((signal) => signal.resolved && signal.remainder);
    const blocked = signals.find(
        (signal) => !signal.resolved && signal.blockedOn
    );

    let verdict = VERDICTS.OPEN_WORK;
    if (resolvedOn.length > 0 && resolvedOn.length === evaluatedOn.length) {
        verdict = remainder
            ? VERDICTS.CODE_COMPLETE_REMAINDER
            : VERDICTS.RESOLVED_IN_CODE;
    } else if (resolvedOn.length > 0) {
        verdict = VERDICTS.RESOLVED_NOT_ON_ALL_BRANCHES;
    } else if (substantive.length > 0) {
        verdict = VERDICTS.LANDED_BUT_UNVERIFIED;
    } else if (blocked) {
        verdict = VERDICTS.BLOCKED;
    }

    return {
        number: issue.number,
        title: issue.title,
        verdict,
        resolvedOn,
        missingFrom: evaluatedOn.filter((ref) => !resolvedOn.includes(ref)),
        commitBranches,
        remainder: remainder?.remainder,
        blockedOn: blocked?.blockedOn,
        signals,
    };
};

/**
 * Classifies every open issue and separates the ones a task list may offer.
 *
 * `candidates` is the whole point of this module: it is `open_work` only.
 * `landed_but_unverified` is held back deliberately -- it is the state where
 * something is known to have happened and nothing confirms what, which is worth
 * a person's attention but is not a task to start.
 *
 * @param {{issues: Array<{number: number, title: string}>, facts: BacklogFacts}} input
 */
export const auditIssueBacklog = ({ issues, facts }) => {
    const classified = issues
        .map((issue) => classifyIssue(issue, facts))
        .sort((left, right) => left.number - right.number);

    const withVerdict = (...verdicts) =>
        classified.filter((issue) => verdicts.includes(issue.verdict));

    return {
        classified,
        candidates: withVerdict(VERDICTS.OPEN_WORK),
        staleOpen: withVerdict(
            VERDICTS.RESOLVED_IN_CODE,
            VERDICTS.CODE_COMPLETE_REMAINDER
        ),
        awaitingPromotion: withVerdict(VERDICTS.RESOLVED_NOT_ON_ALL_BRANCHES),
        needsReview: withVerdict(VERDICTS.LANDED_BUT_UNVERIFIED),
        blocked: withVerdict(VERDICTS.BLOCKED),
    };
};
