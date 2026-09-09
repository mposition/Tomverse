/**
 * The control program for an author–reviewer exchange between two AI
 * executors, with a fix loop and a hard iteration cap.
 *
 * ## Roles
 *
 * - The **author** produces a change for a task: a diff, a summary, the files
 *   it touched, and -- kept apart from all of that -- its own assessment.
 * - The **reviewer** reads the original requirement and the actual diff first,
 *   then the test results, and only then the author's summary and
 *   self-assessment, labelled as such. It returns a conclusion and findings,
 *   each with a location, a severity, and the basis it rests on.
 * - This module is the **control program**: it hands results between the two,
 *   computes the change digest itself, runs the tests, applies the handling
 *   rules, counts the rounds, and decides the outcome. Neither executor
 *   decides whether the task passed.
 *
 * Which model plays which role is configuration (`RoleAssignment`), and the
 * executors are injected, so the same loop runs against scripted mocks in a
 * test and against command-line tools in a session. Nothing here spawns a
 * process, reads a file, or reaches the network.
 *
 * ## Rules the loop applies, from the operating defaults
 *
 * - An approval is bound to a digest. The reviewer names the digest it
 *   reviewed; if that is not the digest of the change in hand, the verdict is
 *   not a verdict on this change and the run fails. An approval of round n is
 *   never reused for round n+1.
 * - Two executors agreeing is not a pass. The tests the control program ran
 *   must pass and the guard rules must hold, or the approved change goes back
 *   to the author (counting a round) and, if rounds are exhausted, on hold.
 * - A finding with evidence, or a judgement with a reproduction, is
 *   actionable: the author fixes it and the change is re-reviewed. A finding
 *   that is only a preference is settled by the project's rules and recorded
 *   as such. A judgement with no reproduction is insufficient evidence: the
 *   current version stands, and the finding is recorded, never dropped.
 * - After `maxRevisions` fix rounds an unresolved change is put on hold with
 *   its findings and reproduction material. It is not retried.
 * - Invalid JSON, a missing result, a timeout, an executor failure and a
 *   digest mismatch are each a named failure. None of them is a pass.
 *
 * Pure apart from the injected executors, test runner and clock.
 */

export const CROSS_REVIEW_VERSION = "cross-review-v1";

export type CrossReviewRole = "author" | "reviewer";

/** Which executor plays which role. Swappable; the loop does not care. */
export type RoleAssignment = {
    author: string;
    reviewer: string;
};

export const DEFAULT_ROLE_ASSIGNMENT: RoleAssignment = {
    author: "claude",
    reviewer: "codex",
};

export type CrossReviewTask = {
    taskId: string;
    /** The original requirement, verbatim. What the reviewer reads first. */
    requirement: string;
    completionCriteria: readonly string[];
    /** The commit the change is measured against. */
    baseCommit: string;
    /**
     * Paths the author may write. The reviewer writes nowhere: it is given
     * the diff as text and returns a verdict as text, so there is nothing it
     * could write even if it wanted to. Two executors never edit one file.
     */
    writableScope: readonly string[];
};

/** What an author executor returns. Its digest claim, if any, is ignored. */
export type AuthorOutput = {
    /** The unified diff against `baseCommit`, or the current worktree. */
    diff: string;
    summary: string;
    filesChanged: readonly string[];
    /**
     * The author's own view of its work. Carried separately so the reviewer
     * can be shown the requirement and the diff before it, and so a reader of
     * the record can tell the author's claim from the reviewer's finding.
     */
    selfAssessment?: string;
    /** The commit the author made, or null when the change is a worktree. */
    commit?: string | null;
};

export type TestRun = {
    command: string;
    passed: boolean;
    /** Kept short by the caller; the record is not a log. */
    output: string;
    durationMs: number;
};

export const FINDING_SEVERITIES = ["error", "warning", "nit"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_BASES = [
    /** Backed by something checkable: a failing test, a wrong output, a spec line. */
    "evidence",
    /** A matter of taste. Settled by the project's rules, not by argument. */
    "preference",
    /** An opinion about behaviour. Actionable only with a reproduction. */
    "judgement",
] as const;
export type FindingBasis = (typeof FINDING_BASES)[number];

export type Finding = {
    /** `path:line`, a symbol, or a section. Never empty. */
    location: string;
    severity: FindingSeverity;
    basis: FindingBasis;
    claim: string;
    /** How to see the problem: a command, an input and expected output. */
    reproduction?: string;
};

export const REVIEW_CONCLUSIONS = ["approve", "request_changes", "blocked"] as const;
export type ReviewConclusion = (typeof REVIEW_CONCLUSIONS)[number];

export type ReviewVerdict = {
    taskId: string;
    round: number;
    /** The digest of the change the reviewer actually read. */
    reviewedDigest: string;
    conclusion: ReviewConclusion;
    findings: readonly Finding[];
    nextAction: string;
};

/** What the reviewer is handed, in the order it is meant to read it. */
export type ReviewRequest = {
    task: CrossReviewTask;
    round: number;
    changeDigest: string;
    commit: string | null;
    diff: string;
    testResults: readonly TestRun[];
    guardViolations: readonly string[];
    /** Last, and labelled: the author's summary and self-assessment. */
    authorSummary: string;
    authorSelfAssessment: string | null;
    /** Findings from the previous round, so the reviewer can check they were addressed. */
    previousFindings: readonly Finding[];
};

export type AuthorRequest = {
    task: CrossReviewTask;
    round: number;
    /** Actionable findings and failing tests from the previous round; null on round 0. */
    feedback: {
        findings: readonly Finding[];
        failedTests: readonly TestRun[];
        guardViolations: readonly string[];
    } | null;
};

export const EXECUTOR_FAILURES = [
    "invalid_json",
    "missing_result",
    "timeout",
    "execution_failed",
    "schema_mismatch",
    "not_executed",
] as const;
export type ExecutorFailure = (typeof EXECUTOR_FAILURES)[number];

export type ExecutorResult<T> =
    | { ok: true; value: T }
    | { ok: false; failure: ExecutorFailure; detail: string };

export type AuthorExecutor = {
    id: string;
    produce: (request: AuthorRequest) => Promise<ExecutorResult<AuthorOutput>>;
};

export type ReviewerExecutor = {
    id: string;
    review: (request: ReviewRequest) => Promise<ExecutorResult<ReviewVerdict>>;
};

export type FindingDisposition =
    /** Sent back to the author. */
    | "fix_requested"
    /** A preference; the project's rules decide, and the change stands. */
    | "resolved_by_project_rule"
    /** A judgement with no reproduction; the current version is kept. */
    | "insufficient_evidence_kept_current"
    /** Rounds exhausted with this still open. */
    | "unresolved_on_hold";

export type DisposedFinding = Finding & { disposition: FindingDisposition };

export type RoundRecord = {
    round: number;
    changeDigest: string;
    commit: string | null;
    filesChanged: readonly string[];
    changeSummary: string;
    testResults: readonly TestRun[];
    guardViolations: readonly string[];
    reviewConclusion: ReviewConclusion | null;
    findings: readonly DisposedFinding[];
    nextAction: string;
};

export const CROSS_REVIEW_STATUSES = ["passed", "on_hold", "failed"] as const;
export type CrossReviewStatus = (typeof CROSS_REVIEW_STATUSES)[number];

export type CrossReviewFailure =
    | `author_${ExecutorFailure}`
    | `reviewer_${ExecutorFailure}`
    | "digest_mismatch"
    | "task_mismatch"
    | "round_mismatch"
    | "scope_violation";

export type HoldReason =
    | "revisions_exhausted"
    | "reviewer_blocked"
    | "approved_but_checks_failed";

/**
 * The exchange record: everything either side needs, and nothing that lets
 * one side's claim stand in for the other's finding.
 */
export type ExchangeRecord = {
    version: string;
    taskId: string;
    requirement: string;
    completionCriteria: readonly string[];
    baseCommit: string;
    roles: RoleAssignment;
    maxRevisions: number;
    rounds: readonly RoundRecord[];
    /** The latest change's digest, the one any further verdict must name. */
    changeDigest: string | null;
    commit: string | null;
    changeSummary: string | null;
    testResults: readonly TestRun[];
    reviewConclusion: ReviewConclusion | null;
    findings: readonly DisposedFinding[];
    nextAction: string;
    status: CrossReviewStatus;
    failure: CrossReviewFailure | null;
    holdReason: HoldReason | null;
    producedAt: string;
};

export type CrossReviewOutcome = {
    status: CrossReviewStatus;
    failure: CrossReviewFailure | null;
    holdReason: HoldReason | null;
    exchange: ExchangeRecord;
};

export type CrossReviewControl = {
    task: CrossReviewTask;
    roles?: RoleAssignment;
    author: AuthorExecutor;
    reviewer: ReviewerExecutor;
    /** Runs the required tests against the change. The control program's, not the author's. */
    runTests: (change: { diff: string; filesChanged: readonly string[]; commit: string | null }) => Promise<readonly TestRun[]>;
    /** Existing protection rules. A non-empty list is a failed check. */
    guards?: (change: { diff: string; filesChanged: readonly string[] }) => Promise<readonly string[]>;
    /** sha256 of the diff text. Injected so a test can pin it; the control computes it, never the author. */
    digest: (diff: string) => string;
    /** Fix-and-re-review rounds after the first review. Default 2. */
    maxRevisions?: number;
    timeoutMs?: number;
    now?: () => Date;
};

export const DEFAULT_MAX_REVISIONS = 2;
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** Why a parsed object is not an `AuthorOutput`. Empty means it is one. */
export const authorOutputProblems = (value: unknown): readonly string[] => {
    if (!isRecord(value)) return ["not an object"];
    const problems: string[] = [];
    if (typeof value.diff !== "string") problems.push("diff must be a string");
    if (typeof value.summary !== "string" || value.summary.trim() === "") problems.push("summary must be a non-empty string");
    if (!isStringArray(value.filesChanged)) problems.push("filesChanged must be a string array");
    if (value.selfAssessment !== undefined && typeof value.selfAssessment !== "string") {
        problems.push("selfAssessment must be a string when present");
    }
    if (value.commit !== undefined && value.commit !== null && typeof value.commit !== "string") {
        problems.push("commit must be a string or null");
    }
    return problems;
};

const findingProblems = (value: unknown, index: number): readonly string[] => {
    if (!isRecord(value)) return [`findings[${index}] is not an object`];
    const problems: string[] = [];
    if (typeof value.location !== "string" || value.location.trim() === "") problems.push(`findings[${index}].location must be a non-empty string`);
    if (!FINDING_SEVERITIES.includes(value.severity as FindingSeverity)) problems.push(`findings[${index}].severity must be one of ${FINDING_SEVERITIES.join("|")}`);
    if (!FINDING_BASES.includes(value.basis as FindingBasis)) problems.push(`findings[${index}].basis must be one of ${FINDING_BASES.join("|")}`);
    if (typeof value.claim !== "string" || value.claim.trim() === "") problems.push(`findings[${index}].claim must be a non-empty string`);
    if (value.reproduction !== undefined && typeof value.reproduction !== "string") problems.push(`findings[${index}].reproduction must be a string when present`);
    return problems;
};

/** Why a parsed object is not a `ReviewVerdict`. Empty means it is one. */
export const reviewVerdictProblems = (value: unknown): readonly string[] => {
    if (!isRecord(value)) return ["not an object"];
    const problems: string[] = [];
    if (typeof value.taskId !== "string") problems.push("taskId must be a string");
    if (typeof value.round !== "number" || !Number.isInteger(value.round)) problems.push("round must be an integer");
    if (typeof value.reviewedDigest !== "string" || value.reviewedDigest === "") problems.push("reviewedDigest must be a non-empty string");
    if (!REVIEW_CONCLUSIONS.includes(value.conclusion as ReviewConclusion)) problems.push(`conclusion must be one of ${REVIEW_CONCLUSIONS.join("|")}`);
    if (!Array.isArray(value.findings)) problems.push("findings must be an array");
    else value.findings.forEach((finding, index) => problems.push(...findingProblems(finding, index)));
    if (typeof value.nextAction !== "string") problems.push("nextAction must be a string");
    return problems;
};

/**
 * Parses executor output as JSON and checks it against a schema.
 *
 * Whole text first; then the last line, for a tool that streams events and
 * prints its result last; then the last `{...}` block. Anything else is
 * `invalid_json`, and a document that parses but is not the shape asked for
 * is `schema_mismatch`. An empty output is `missing_result`.
 */
export const parseExecutorJson = <T>(
    text: string,
    problemsOf: (value: unknown) => readonly string[]
): ExecutorResult<T> => {
    if (typeof text !== "string" || text.trim() === "") {
        return { ok: false, failure: "missing_result", detail: "the executor produced no output" };
    }
    const attempts: string[] = [text.trim()];
    const lines = text.trim().split("\n");
    if (lines.length > 1) attempts.push(lines[lines.length - 1].trim());
    const lastBrace = text.lastIndexOf("}");
    const firstBrace = text.indexOf("{");
    if (firstBrace !== -1 && lastBrace > firstBrace) attempts.push(text.slice(firstBrace, lastBrace + 1));

    let parsed: unknown = undefined;
    let parsedAny = false;
    for (const attempt of attempts) {
        try {
            parsed = JSON.parse(attempt);
            parsedAny = true;
            break;
        } catch {
            // try the next shape
        }
    }
    if (!parsedAny) {
        return { ok: false, failure: "invalid_json", detail: `no JSON document in ${text.length} byte(s) of output` };
    }
    const problems = problemsOf(parsed);
    if (problems.length > 0) {
        return { ok: false, failure: "schema_mismatch", detail: problems.join("; ") };
    }
    return { ok: true, value: parsed as T };
};

const withTimeout = async <T>(
    work: Promise<ExecutorResult<T>>,
    timeoutMs: number
): Promise<ExecutorResult<T>> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<ExecutorResult<T>>((resolve) => {
        timer = setTimeout(
            () => resolve({ ok: false, failure: "timeout", detail: `no result within ${timeoutMs}ms` }),
            timeoutMs
        );
    });
    try {
        return await Promise.race([
            work.catch(
                (error): ExecutorResult<T> => ({
                    ok: false,
                    failure: "execution_failed",
                    detail: error instanceof Error ? error.message : String(error),
                })
            ),
            timeout,
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

/** A finding the author has to act on, under the operating defaults. */
export const isActionable = (finding: Finding): boolean =>
    finding.basis === "evidence" ||
    (finding.basis === "judgement" && typeof finding.reproduction === "string" && finding.reproduction.trim() !== "");

const dispose = (finding: Finding, disposition: FindingDisposition): DisposedFinding => ({
    ...finding,
    disposition,
});

const disposeFindings = (findings: readonly Finding[], canRevise: boolean): readonly DisposedFinding[] =>
    findings.map((finding) => {
        if (isActionable(finding)) return dispose(finding, canRevise ? "fix_requested" : "unresolved_on_hold");
        if (finding.basis === "preference") return dispose(finding, "resolved_by_project_rule");
        return dispose(finding, "insufficient_evidence_kept_current");
    });

const scopeViolations = (task: CrossReviewTask, filesChanged: readonly string[]): readonly string[] => {
    if (task.writableScope.length === 0) return [];
    return filesChanged.filter(
        (file) => !task.writableScope.some((scope) => file === scope || file.startsWith(scope.endsWith("/") ? scope : `${scope}/`))
    );
};

export async function runCrossReview(control: CrossReviewControl): Promise<CrossReviewOutcome> {
    const roles = control.roles ?? DEFAULT_ROLE_ASSIGNMENT;
    const maxRevisions = control.maxRevisions ?? DEFAULT_MAX_REVISIONS;
    const timeoutMs = control.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const now = control.now ?? (() => new Date());
    const task = control.task;
    const rounds: RoundRecord[] = [];

    const finish = (
        status: CrossReviewStatus,
        failure: CrossReviewFailure | null,
        holdReason: HoldReason | null,
        nextAction: string
    ): CrossReviewOutcome => {
        const last = rounds[rounds.length - 1] ?? null;
        const exchange: ExchangeRecord = {
            version: CROSS_REVIEW_VERSION,
            taskId: task.taskId,
            requirement: task.requirement,
            completionCriteria: task.completionCriteria,
            baseCommit: task.baseCommit,
            roles,
            maxRevisions,
            rounds,
            changeDigest: last?.changeDigest ?? null,
            commit: last?.commit ?? null,
            changeSummary: last?.changeSummary ?? null,
            testResults: last?.testResults ?? [],
            reviewConclusion: last?.reviewConclusion ?? null,
            findings: last?.findings ?? [],
            nextAction,
            status,
            failure,
            holdReason,
            producedAt: now().toISOString(),
        };
        return { status, failure, holdReason, exchange };
    };

    let feedback: AuthorRequest["feedback"] = null;
    let previousFindings: readonly Finding[] = [];

    for (let round = 0; round <= maxRevisions; round += 1) {
        const produced: ExecutorResult<AuthorOutput> = await withTimeout<AuthorOutput>(
            control.author.produce({ task, round, feedback }),
            timeoutMs
        );
        if (!produced.ok) {
            rounds.push({
                round,
                changeDigest: "",
                commit: null,
                filesChanged: [],
                changeSummary: "",
                testResults: [],
                guardViolations: [],
                reviewConclusion: null,
                findings: [],
                nextAction: `author ${produced.failure}: ${produced.detail}`,
            });
            return finish("failed", `author_${produced.failure}`, null, "the author produced no usable change; nothing was reviewed");
        }
        const output: AuthorOutput = produced.value;
        const violations = scopeViolations(task, output.filesChanged);
        if (violations.length > 0) {
            rounds.push({
                round,
                changeDigest: control.digest(output.diff),
                commit: output.commit ?? null,
                filesChanged: output.filesChanged,
                changeSummary: output.summary,
                testResults: [],
                guardViolations: violations.map((file) => `outside writable scope: ${file}`),
                reviewConclusion: null,
                findings: [],
                nextAction: "the change touched files outside the task's writable scope",
            });
            return finish("failed", "scope_violation", null, "the change touched files outside the task's writable scope; nothing was reviewed");
        }

        // The control program's digest, of the diff it holds. The author's
        // own claim about its digest, if it made one, is not consulted.
        const changeDigest = control.digest(output.diff);
        const testResults = await control.runTests({
            diff: output.diff,
            filesChanged: output.filesChanged,
            commit: output.commit ?? null,
        });
        const guardViolations: readonly string[] = control.guards
            ? await control.guards({ diff: output.diff, filesChanged: output.filesChanged })
            : [];
        const checksPass = testResults.every((run) => run.passed) && guardViolations.length === 0;

        const reviewed: ExecutorResult<ReviewVerdict> = await withTimeout<ReviewVerdict>(
            control.reviewer.review({
                task,
                round,
                changeDigest,
                commit: output.commit ?? null,
                diff: output.diff,
                testResults,
                guardViolations,
                authorSummary: output.summary,
                authorSelfAssessment: output.selfAssessment ?? null,
                previousFindings,
            }),
            timeoutMs
        );
        const record: RoundRecord = {
            round,
            changeDigest,
            commit: output.commit ?? null,
            filesChanged: output.filesChanged,
            changeSummary: output.summary,
            testResults,
            guardViolations,
            reviewConclusion: null,
            findings: [],
            nextAction: "",
        };
        if (!reviewed.ok) {
            rounds.push({ ...record, nextAction: `reviewer ${reviewed.failure}: ${reviewed.detail}` });
            return finish("failed", `reviewer_${reviewed.failure}`, null, "the reviewer returned no usable verdict; the change is not approved");
        }
        const verdict = reviewed.value;
        if (verdict.reviewedDigest !== changeDigest) {
            rounds.push({
                ...record,
                reviewConclusion: verdict.conclusion,
                nextAction: `the verdict names digest ${verdict.reviewedDigest}, the change is ${changeDigest}`,
            });
            return finish("failed", "digest_mismatch", null, "the verdict is about a different change; it does not apply to this one");
        }
        if (verdict.taskId !== task.taskId) {
            rounds.push({ ...record, reviewConclusion: verdict.conclusion, nextAction: `the verdict names task ${verdict.taskId}` });
            return finish("failed", "task_mismatch", null, "the verdict is about a different task");
        }
        if (verdict.round !== round) {
            rounds.push({ ...record, reviewConclusion: verdict.conclusion, nextAction: `the verdict names round ${verdict.round}` });
            return finish("failed", "round_mismatch", null, "the verdict is about a different round; an earlier approval is not reused");
        }

        const canRevise = round < maxRevisions;

        if (verdict.conclusion === "blocked") {
            rounds.push({
                ...record,
                reviewConclusion: "blocked",
                findings: verdict.findings.map((finding) => dispose(finding, "unresolved_on_hold")),
                nextAction: verdict.nextAction,
            });
            return finish("on_hold", null, "reviewer_blocked", verdict.nextAction || "the reviewer could not review this change; a person decides");
        }

        if (verdict.conclusion === "approve") {
            const disposed = disposeFindings(verdict.findings, canRevise);
            if (checksPass && !disposed.some((finding) => finding.disposition === "fix_requested")) {
                rounds.push({ ...record, reviewConclusion: "approve", findings: disposed, nextAction: verdict.nextAction });
                return finish("passed", null, null, verdict.nextAction || "approved on this digest with tests and guards passing");
            }
            // Two executors agreeing is not a pass. Failing tests or a guard
            // violation send the change back, and count a round.
            rounds.push({
                ...record,
                reviewConclusion: "approve",
                findings: disposed,
                nextAction: canRevise
                    ? "approved, but a required check failed; the author fixes it and the change is re-reviewed"
                    : "approved, but a required check failed and no revision remains",
            });
            if (!canRevise) {
                return finish("on_hold", null, "approved_but_checks_failed", "approved by the reviewer, refused by the checks; a person decides");
            }
            feedback = {
                findings: disposed.filter((finding) => finding.disposition === "fix_requested"),
                failedTests: testResults.filter((run) => !run.passed),
                guardViolations,
            };
            previousFindings = verdict.findings;
            continue;
        }

        // request_changes
        const disposed = disposeFindings(verdict.findings, canRevise);
        const actionable = disposed.filter((finding) => finding.disposition === "fix_requested");
        const unresolved = disposed.filter((finding) => finding.disposition === "unresolved_on_hold");
        if (actionable.length === 0 && unresolved.length === 0 && checksPass) {
            // Nothing the reviewer raised rests on evidence, and the checks
            // pass: the current version stands, with every finding recorded.
            rounds.push({
                ...record,
                reviewConclusion: "request_changes",
                findings: disposed,
                nextAction: "no finding was actionable under the operating defaults; the current version stands",
            });
            return finish("passed", null, null, "changes were requested on preference or unreproduced judgement only; the current version stands with the findings on record");
        }
        rounds.push({
            ...record,
            reviewConclusion: "request_changes",
            findings: disposed,
            nextAction: canRevise ? verdict.nextAction || "fix and re-review" : "revisions exhausted",
        });
        if (!canRevise) {
            return finish("on_hold", null, "revisions_exhausted", `unresolved after ${maxRevisions} revision(s); on hold with the findings and reproductions recorded`);
        }
        feedback = {
            findings: actionable,
            failedTests: testResults.filter((run) => !run.passed),
            guardViolations,
        };
        previousFindings = verdict.findings;
    }

    // Unreachable: every branch above returns before the loop ends.
    return finish("on_hold", null, "revisions_exhausted", "the loop ended without a verdict");
}

/**
 * The text the reviewer is given, in reading order: requirement, criteria,
 * the diff, the tests, and only then the author's account of itself. The
 * reviewer answers with one JSON document in the `ReviewVerdict` shape.
 */
export const renderReviewPrompt = (request: ReviewRequest): string => {
    const lines: string[] = [];
    lines.push(`# Independent review — task ${request.task.taskId}, round ${request.round}`);
    lines.push("");
    lines.push("Review the change against the original requirement below. Read the requirement and the diff before anything else.");
    lines.push("Do not take the author's summary as a description of what the change does; the diff is.");
    lines.push("");
    lines.push("## Requirement (original)");
    lines.push("");
    lines.push(request.task.requirement);
    lines.push("");
    lines.push("## Completion criteria");
    lines.push("");
    for (const criterion of request.task.completionCriteria) lines.push(`- ${criterion}`);
    lines.push("");
    lines.push(`## Change under review — digest ${request.changeDigest}${request.commit ? `, commit ${request.commit}` : ""}`);
    lines.push("");
    lines.push("```diff");
    lines.push(request.diff);
    lines.push("```");
    lines.push("");
    lines.push("## Test results (run by the control program)");
    lines.push("");
    if (request.testResults.length === 0) lines.push("- none run");
    for (const run of request.testResults) {
        lines.push(`- ${run.passed ? "PASS" : "FAIL"} \`${run.command}\` (${run.durationMs}ms)`);
        if (run.output.trim()) lines.push(`  ${run.output.trim().split("\n").join("\n  ")}`);
    }
    if (request.guardViolations.length > 0) {
        lines.push("");
        lines.push("## Guard violations");
        lines.push("");
        for (const violation of request.guardViolations) lines.push(`- ${violation}`);
    }
    if (request.previousFindings.length > 0) {
        lines.push("");
        lines.push("## Findings from the previous round (check each was addressed)");
        lines.push("");
        for (const finding of request.previousFindings) {
            lines.push(`- [${finding.severity}/${finding.basis}] ${finding.location}: ${finding.claim}`);
        }
    }
    lines.push("");
    lines.push("## Author's account (read last; a claim, not a finding)");
    lines.push("");
    lines.push(`Summary: ${request.authorSummary}`);
    if (request.authorSelfAssessment) lines.push(`Self-assessment: ${request.authorSelfAssessment}`);
    lines.push("");
    lines.push("## Answer format");
    lines.push("");
    lines.push("Reply with exactly one JSON document and nothing else:");
    lines.push("");
    lines.push("```json");
    lines.push(
        JSON.stringify(
            {
                taskId: request.task.taskId,
                round: request.round,
                reviewedDigest: request.changeDigest,
                conclusion: "approve | request_changes | blocked",
                findings: [
                    {
                        location: "path:line or symbol",
                        severity: "error | warning | nit",
                        basis: "evidence | preference | judgement",
                        claim: "what is wrong, in one sentence",
                        reproduction: "how to see it (required for a judgement to be acted on)",
                    },
                ],
                nextAction: "one sentence",
            },
            null,
            2
        )
    );
    lines.push("```");
    lines.push("");
    lines.push("`reviewedDigest` must be the digest above, verbatim. A finding with basis `preference` is settled by the project's rules; a `judgement` without a reproduction is recorded and not acted on.");
    return `${lines.join("\n")}\n`;
};
