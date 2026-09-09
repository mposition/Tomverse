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
 *   computes the change digest itself, runs the tests and the guards, applies
 *   the handling rules, counts the rounds, and decides the outcome. Neither
 *   executor decides whether the task passed.
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
 * - Two executors agreeing is not a pass. The control program's own checks
 *   must pass as well: at least one test run and every run passed, at least
 *   one guard rule run and every rule passed. Nothing run is a failed check
 *   -- an empty test list is not a passing one, and neither is an empty
 *   guard list -- and so is a diff that names a file the author did not
 *   report. A failed check sends the approved change back to the author
 *   (counting a round) and, if rounds are exhausted, on hold.
 * - A finding is acted on only with a reproduction, whatever its basis:
 *   `evidence` names something checkable and the reproduction is how to
 *   check it, and a `judgement` is an opinion that a reproduction turns into
 *   something checkable. A `preference` is settled by the project's rules
 *   and recorded as such. A finding with no reproduction is insufficient
 *   evidence: the current version stands, and the finding is recorded, never
 *   dropped.
 * - An actionable finding is never passed over. With a revision left it goes
 *   back to the author; in the last round it puts the change on hold, even
 *   under an approval -- a reviewer that approves while naming a reproducible
 *   error has named an error, not waived it.
 * - The cap is fixed: `MAX_REVISIONS` (2) fix rounds after the first review,
 *   and then an unresolved change is put on hold with its findings and
 *   reproduction material. A caller may lower the cap for a run; it cannot
 *   raise it.
 * - Invalid JSON, a missing result, a timeout, an executor failure and a
 *   digest mismatch are each a named failure. None of them is a pass.
 *
 * Pure apart from the injected executors, test runner, guards and clock.
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
    /**
     * Generated files inside the scope that a package may leave out of the
     * reviewed diff, named here before the exchange so an author cannot
     * decide later what the reviewer does not see. Each is still counted as
     * changed, and its content is digested into the package.
     */
    generatedPaths?: readonly string[];
    /**
     * The concluded exchange this task continues from, when there is one.
     * Its unresolved findings are handed to the reviewer of round 0 as the
     * previous findings, so a new exchange does not start from nothing --
     * and a chain of such continuations is capped (`MAX_SUPERSESSIONS`), so
     * starting over is not a way to get more rounds.
     */
    supersedes?: { taskId: string; exchange: string };
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

/** One guard rule, run once, with what it found. */
export type GuardRun = {
    rule: string;
    passed: boolean;
    /** What the rule reported. Short; the record is not a log. */
    detail: string;
    durationMs?: number;
};

export const FINDING_SEVERITIES = ["error", "warning", "nit"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_BASES = [
    /** Backed by something checkable: a failing test, a wrong output, a spec line. The reproduction is how to check it. */
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
    /** How to see the problem: a command, an input and expected output. Required for the finding to be acted on. */
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
    guardRuns: readonly GuardRun[];
    /** Failed guard rules and consistency failures, as text. */
    guardViolations: readonly string[];
    /** Last, and labelled: the author's summary and self-assessment. */
    authorSummary: string;
    authorSelfAssessment: string | null;
    /** Findings from the previous round, so the reviewer can check they were addressed. */
    previousFindings: readonly Finding[];
    /** Where those findings came from when not the previous round: the superseded exchange. */
    previousFindingsFrom?: string;
};

export type AuthorRequest = {
    task: CrossReviewTask;
    round: number;
    /** Actionable findings and failed checks from the previous round; null on round 0. */
    feedback: {
        findings: readonly Finding[];
        failedTests: readonly TestRun[];
        guardViolations: readonly string[];
        /** Every reason the checks did not pass, including "no test was run". */
        checkFailures: readonly string[];
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
    /** No reproduction, whatever the basis; the current version is kept. */
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
    guardRuns: readonly GuardRun[];
    guardViolations: readonly string[];
    /** Why the control program's checks did not pass; empty when they did. */
    checkFailures: readonly string[];
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
    guardRuns: readonly GuardRun[];
    guardViolations: readonly string[];
    checkFailures: readonly string[];
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
    /**
     * Runs the existing protection rules against the change and reports each
     * with its result. A failed rule is a failed check; so is an empty list,
     * since a guard that was not run has protected nothing.
     */
    guards: (change: { diff: string; filesChanged: readonly string[] }) => Promise<readonly GuardRun[]>;
    /** sha256 of the diff text. Injected so a test can pin it; the control computes it, never the author. */
    digest: (diff: string) => string;
    /** Fix-and-re-review rounds after the first review. At most `MAX_REVISIONS`; a caller may only lower it. */
    maxRevisions?: number;
    timeoutMs?: number;
    now?: () => Date;
};

/** The operating default's cap on fix rounds. Fixed; a run may go lower, never higher. */
export const MAX_REVISIONS = 2;
export const DEFAULT_MAX_REVISIONS = MAX_REVISIONS;
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** The cap a run may use, or a thrown error: raising the cap is not a run option. */
export const resolveMaxRevisions = (requested: number | undefined): number => {
    if (requested === undefined) return MAX_REVISIONS;
    if (!Number.isInteger(requested) || requested < 0 || requested > MAX_REVISIONS) {
        throw new RangeError(`maxRevisions must be an integer from 0 to ${MAX_REVISIONS}; got ${requested}`);
    }
    return requested;
};

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

const hasReproduction = (finding: Finding): boolean =>
    typeof finding.reproduction === "string" && finding.reproduction.trim() !== "";

/**
 * A finding the author has to act on, under the operating defaults: one
 * that comes with a reproduction. The basis says what kind of thing the
 * reproduction shows; it does not stand in for one.
 */
export const isActionable = (finding: Finding): boolean =>
    (finding.basis === "evidence" || finding.basis === "judgement") && hasReproduction(finding);

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

/** Findings that stop a pass: sent back, or left open with no revision to send them to. */
const blocking = (disposed: readonly DisposedFinding[]): readonly DisposedFinding[] =>
    disposed.filter((finding) => finding.disposition === "fix_requested" || finding.disposition === "unresolved_on_hold");

/**
 * The files a unified diff names: `diff --git` headers, and `+++` / `---`
 * pairs for a diff without them. What the author *says* it changed is
 * checked against this, so a file left out of `filesChanged` is still seen.
 */
export const filesNamedByDiff = (diff: string): readonly string[] => {
    const named = new Set<string>();
    let pendingOld: string | null = null;
    for (const line of diff.split("\n")) {
        const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
        if (header) {
            named.add(header[2]);
            pendingOld = null;
            continue;
        }
        const removed = /^--- a\/(.+)$/.exec(line);
        if (removed) {
            pendingOld = removed[1];
            continue;
        }
        const added = /^\+\+\+ b\/(.+)$/.exec(line);
        if (added) {
            named.add(added[1]);
            pendingOld = null;
            continue;
        }
        if (line.startsWith("+++ /dev/null") && pendingOld) {
            named.add(pendingOld);
            pendingOld = null;
        }
    }
    return [...named];
};

const inScope = (task: CrossReviewTask, file: string): boolean =>
    task.writableScope.length === 0 ||
    task.writableScope.some((scope) => file === scope || file.startsWith(scope.endsWith("/") ? scope : `${scope}/`));

const scopeViolations = (task: CrossReviewTask, files: readonly string[]): readonly string[] =>
    files.filter((file) => !inScope(task, file));

// ---------------------------------------------------------------------------
// Rules a person-driven exchange applies before a package or a review.

/** How many times a concluded exchange may be continued by a new task. */
export const MAX_SUPERSESSIONS = 2;

const underPath = (file: string, path: string): boolean =>
    path === "" || path === "." || file === path || file.startsWith(path.endsWith("/") ? path : `${path}/`);

/**
 * One spelling for a repository path: forward slashes, `.` and `..`
 * segments resolved, no trailing slash. Every path that is compared,
 * digested or handed to git goes through this once, so a Windows spelling,
 * a `./` prefix or a `..` written under an allowed directory cannot pass
 * one check and mean another path to git. A path that climbs above the
 * repository keeps its leading `..`, and `escapesRepository` says so.
 */
export const normalizeRepoPath = (path: string): string => {
    const segments: string[] = [];
    for (const segment of path.trim().replace(/\\/g, "/").split("/")) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") {
            if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
            else segments.push("..");
            continue;
        }
        segments.push(segment);
    }
    return segments.length === 0 ? "." : segments.join("/");
};

/** A normalised path that climbs above the repository root. */
export const escapesRepository = (normalized: string): boolean => normalized === ".." || normalized.startsWith("../");

/**
 * Characters git reads as a pattern (`*`, `?`, `[`, `]`) or, leading, as
 * pathspec magic (`:`, `!`, `^`). A repository path here is a literal
 * name, and a name git would read otherwise is refused rather than
 * escaped.
 */
const PATHSPEC_PATTERN = /[*?[\]]|^[:!^]/;
const pathspecPatternProblem = (raw: string, what: string): string =>
    `${raw} names ${what} with a character git reads as a pathspec pattern or magic (* ? [ ] or a leading : ! ^); a repository path here is a literal name`;

/**
 * Why a set of `--diff-exclude` paths may not be applied to a package. The
 * allow list is exact: a path is accepted only when, in its one spelling
 * (`normalizeRepoPath`), it *is* one of the task's generated paths or *is*
 * the package's own output directory -- and never when it is, or contains,
 * a path of the writable scope, whatever else it is named as, since
 * excluding a scoped source or a parent of one would leave the change
 * unread and undigested. Everything else is refused by name: a path that
 * climbs above the repository, a file under the package directory (exclude
 * the directory itself), a parent of the package directory, and a path
 * declared nowhere. So `--out=. --diff-exclude=.` is refused because `.`
 * contains the scope, and `<out>/../../README.md` is refused because,
 * resolved, it is a file beside the package that nothing declared. A task
 * with an empty scope may write anywhere, so its scope is `.`. A name git
 * would read as a pattern or as pathspec magic is refused wherever it
 * appears: a scoped source spelt with brackets, `[c]rossReviewCore` for
 * `crossReviewCore`, is not a file but a pattern that matches the real
 * one, and as an exclusion it would hide that source, while as a package
 * directory it would let the exact match pass.
 */
export const packageExclusionProblems = (input: {
    excluded: readonly string[];
    generatedPaths: readonly string[];
    outDir: string;
    writableScope: readonly string[];
}): readonly string[] => {
    const out = normalizeRepoPath(input.outDir);
    const generated = input.generatedPaths.map(normalizeRepoPath);
    const scope = (input.writableScope.length > 0 ? input.writableScope : ["."]).map(normalizeRepoPath);
    const problems: string[] = [];
    if (PATHSPEC_PATTERN.test(out)) problems.push(pathspecPatternProblem(input.outDir, "the package directory"));
    for (const raw of input.excluded) {
        const path = normalizeRepoPath(raw);
        if (PATHSPEC_PATTERN.test(path)) {
            problems.push(pathspecPatternProblem(raw, "an excluded path"));
            continue;
        }
        if (escapesRepository(path)) {
            problems.push(`${raw} climbs above the repository; nothing outside it can be excluded`);
            continue;
        }
        const covered = scope.filter((entry) => underPath(entry, path));
        if (covered.length > 0) {
            problems.push(`${raw} is, or contains, the writable scope entry ${covered.join(", ")}; a scoped source cannot be excluded from the reviewed diff`);
            continue;
        }
        if (generated.includes(path) || path === out) continue;
        if (underPath(path, out)) {
            problems.push(`${raw} is under the package directory ${input.outDir}; exclude the package directory itself, not a file under it`);
            continue;
        }
        if (underPath(out, path)) {
            problems.push(`${raw} contains the package directory ${input.outDir}; exclude the package directory itself, not a parent of it`);
            continue;
        }
        problems.push(`${raw} is not one of the task's generatedPaths and is not the package directory`);
    }
    return problems;
};

/** What a superseded exchange must look like for a task to continue it. */
export type SupersededExchange = {
    taskId: string;
    status: string;
    findings: readonly DisposedFinding[];
    /** The exchanges that exchange itself continued, oldest first. */
    lineage?: readonly string[];
};

/**
 * Why a task may not continue the exchange it names. A continuation is for a
 * concluded exchange only -- on hold or failed, never passed or still open --
 * and the chain of continuations is capped, so starting a new task is not a
 * way to reset the revision cap.
 */
export const supersessionProblems = (task: CrossReviewTask, prior: SupersededExchange | null): readonly string[] => {
    if (!task.supersedes) return [];
    if (!prior) return [`${task.supersedes.exchange} could not be read`];
    const problems: string[] = [];
    if (prior.taskId !== task.supersedes.taskId) {
        problems.push(`the exchange at ${task.supersedes.exchange} is ${prior.taskId}, not ${task.supersedes.taskId}`);
    }
    if (prior.status !== "on_hold" && prior.status !== "failed") {
        problems.push(`the exchange ${prior.taskId} is ${prior.status}; only an exchange on hold or failed can be continued`);
    }
    const priorDepth = prior.lineage?.length ?? 0;
    if (priorDepth + 1 > MAX_SUPERSESSIONS) {
        problems.push(
            `${prior.taskId} is already ${priorDepth} continuation(s) deep; the cap is ${MAX_SUPERSESSIONS}, and a person decides what happens to the change`
        );
    }
    return problems;
};

/** The findings a continuation inherits: those the prior exchange left open, as plain findings. */
export const inheritedFindings = (prior: SupersededExchange): readonly Finding[] =>
    prior.findings
        .filter((finding) => finding.disposition === "unresolved_on_hold" || finding.disposition === "fix_requested")
        .map((finding) => ({
            location: finding.location,
            severity: finding.severity,
            basis: finding.basis,
            claim: finding.claim,
            ...(finding.reproduction !== undefined ? { reproduction: finding.reproduction } : {}),
        }));

/** The lineage a continuation records: the prior's lineage, then the prior. */
export const lineageOf = (prior: SupersededExchange): readonly string[] => [...(prior.lineage ?? []), prior.taskId];

// ---------------------------------------------------------------------------
// The reviewer's environment, checked before a paid review.

/** What the preflight asks the reviewer to answer. */
export type PreflightReport = {
    /** The read command's standard output, verbatim. */
    readOutput: string;
    /** Whether a write was attempted at the probe path. */
    writeAttempted: boolean;
    /** What happened to the write: "written", or the error text. */
    writeResult: string;
};

export const preflightReportProblems = (value: unknown): readonly string[] => {
    if (!isRecord(value)) return ["not an object"];
    const problems: string[] = [];
    if (typeof value.readOutput !== "string") problems.push("readOutput must be a string");
    if (typeof value.writeAttempted !== "boolean") problems.push("writeAttempted must be a boolean");
    if (typeof value.writeResult !== "string") problems.push("writeResult must be a string");
    return problems;
};

/** The rule a preflight record was judged under. A review accepts only records of the current one. */
export const PREFLIGHT_RECORD_VERSION = "cross-review-preflight-v3";

/**
 * Two steps and one JSON answer: not a review, and not to be read as one.
 * The write is asked for as one shell command naming the probe path, so the
 * tool's own record of the attempt -- the command and what it printed --
 * carries the path. A patch or edit tool's refusal names no path, and so
 * says nothing about the probe (`writeRefusalEvidence`).
 */
export const renderPreflightPrompt = (input: { readCommand: string; probePath: string }): string =>
    [
        "# Reviewer environment preflight",
        "",
        "This is not a review. Do exactly the two steps below, then answer with one JSON document and nothing else.",
        "",
        `1. Run this command and capture its standard output verbatim: \`${input.readCommand}\``,
        `2. Try to create a file at \`${input.probePath}\` containing the single word \`probe\`, with ONE shell command that names that exact path -- in PowerShell: \`Set-Content -LiteralPath '${input.probePath}' -Value probe\`; in a POSIX shell: \`printf probe > '${input.probePath}'\`. Use the shell for this step, not a patch or file-editing tool: the record has to show the command and its result at that path. If it is refused, do not retry, do not try another location or another method; report what happened.`,
        "",
        "```json",
        JSON.stringify(
            {
                readOutput: "the command's standard output, verbatim",
                writeAttempted: true,
                writeResult: '"written", or the error text the attempt produced',
            },
            null,
            2
        ),
        "```",
        "",
    ].join("\n");

/**
 * Whether the environment is fit for a review: the read produced what the
 * control program itself knows to be true, and the write was attempted and
 * refused. What the reviewer *said* is recorded and not trusted on its own:
 * the probe's absence, and a refusal of a write at the probe path that the
 * tool itself reported in its own output (`writeRefusalObserved`, read by
 * the caller from the raw events or stderr with `writeRefusalEvidence`),
 * are the evidence. A report that claims the write succeeded is a failure
 * even with no probe: either it wrote somewhere else, or it is not
 * describing what happened.
 */
export const judgePreflight = (input: {
    report: PreflightReport;
    expectedReadOutput: string;
    probeExists: boolean;
    /** The tool's own output showed a write at the probe path being refused (a denied command, a failed file change there). */
    writeRefusalObserved: boolean;
}): { passed: boolean; problems: readonly string[] } => {
    const problems: string[] = [];
    const expected = input.expectedReadOutput.trim();
    if (expected === "" || !input.report.readOutput.includes(expected)) {
        problems.push(`the read did not produce the expected output (expected to contain ${JSON.stringify(expected)})`);
    }
    if (input.probeExists) problems.push("the write probe landed: the reviewer can write to the working tree");
    if (!input.report.writeAttempted) problems.push("the reviewer did not attempt the write, so nothing about writes was shown");
    if (/\b(written|wrote|created|succeeded|success)\b/i.test(input.report.writeResult)) {
        problems.push(`the reviewer reports the write as done (${JSON.stringify(input.report.writeResult.slice(0, 80))}); a write that lands anywhere is a failed preflight`);
    }
    if (!input.writeRefusalObserved) {
        problems.push(
            "the tool's own output shows no refused write at the probe path; a refusal that names no path, a denial of some other file, and the reviewer's account of a refusal are not evidence by themselves"
        );
    }
    return { passed: problems.length === 0, problems };
};

/** What a refusal looks like in a tool's output. Matched line by line, never against the reviewer's own words. */
const REFUSAL_TEXT = /rejected|refused|blocked|denied|not permitted|read-only file system|EACCES|EPERM|EROFS/i;

/**
 * The spellings under which a text can name the probe: the exact relative
 * path, and the same path under the working directory when one is given.
 * Lower-cased, forward slashes; nothing else -- not a path that merely
 * ends in the probe's (`shadow/<probe>`), which is a different file.
 */
const probeSpellings = (probePath: string, cwd: string | undefined): readonly string[] => {
    const relative = normalizeRepoPath(probePath);
    if (relative === "." || escapesRepository(relative)) return [];
    const spellings = [relative];
    if (cwd !== undefined && cwd.trim() !== "") {
        const root = cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "");
        spellings.push(`${root}/${relative}`);
    }
    return spellings.map((spelling) => spelling.toLowerCase());
};

/** What may continue a path on either side of a match; a match bounded by one of these is part of a longer path. */
const PATH_CHARACTER = /[a-z0-9._~/-]/;

/** Whether `text` contains `token` as a whole path, not as part of a longer one. Separators and case are normalised. */
const namesToken = (text: string, token: string): boolean => {
    const haystack = text.replace(/\\+/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
    for (let from = 0; ; ) {
        const at = haystack.indexOf(token, from);
        if (at === -1) return false;
        const before = at === 0 ? "" : haystack[at - 1];
        const after = haystack[at + token.length] ?? "";
        if (!PATH_CHARACTER.test(before) && !PATH_CHARACTER.test(after)) return true;
        from = at + 1;
    }
};

/**
 * The tool's own evidence that a write *at the probe path* was refused, or
 * null. Codex prints one event per line: a `command_execution` item whose
 * command names the probe and whose output says the write was refused; an
 * `error` item naming the probe; a `file_change` item at the probe that did
 * not complete. Claude Code's JSON envelope has no item stream, so a denial
 * is a `permission_denials` entry naming the probe. A stderr line counts
 * when it names the probe. A refusal that names no path -- Codex's own
 * "patch rejected" line -- or a denial of some other file or tool shows
 * that something was refused, not that the probe was, and is not evidence
 * here; nor is anything the reviewer says in an agent message. Naming the
 * probe means the exact relative path, or the same path under the working
 * directory when one is given, as a whole path: a denial at
 * `shadow/<probe>` or at `<probe>.bak` is a denial of some other file.
 */
export const writeRefusalEvidence = (stdout: string, stderr: string, probePath: string, cwd?: string): string | null => {
    const spellings = probeSpellings(probePath, cwd);
    if (spellings.length === 0) return null;
    const namesProbe = (text: unknown): boolean => typeof text === "string" && spellings.some((spelling) => namesToken(text, spelling));
    const clip = (text: string): string => text.trim().replace(/\s+/g, " ").slice(0, 200);
    for (const line of stderr.split("\n")) {
        if (namesProbe(line) && REFUSAL_TEXT.test(line)) return `stderr: ${clip(line)}`;
    }
    for (const line of stdout.split("\n")) {
        let event: unknown;
        try {
            event = JSON.parse(line);
        } catch {
            continue;
        }
        if (!isRecord(event)) continue;
        const item = isRecord(event.item) ? event.item : null;
        if (item) {
            if (item.type === "command_execution" && namesProbe(item.command) && typeof item.aggregated_output === "string") {
                const refused = item.aggregated_output.split("\n").find((outputLine) => REFUSAL_TEXT.test(outputLine));
                if (refused !== undefined) return `command_execution ${clip(String(item.command))} -> ${clip(refused)}`;
            }
            if (item.type === "error" && namesProbe(item.message) && REFUSAL_TEXT.test(String(item.message))) {
                return `error item: ${clip(String(item.message))}`;
            }
            if (item.type === "file_change" && item.status !== "completed" && item.status !== "in_progress" && namesProbe(JSON.stringify(item.changes ?? null))) {
                return `file_change ${String(item.status)} at the probe path`;
            }
        }
        if (Array.isArray(event.permission_denials)) {
            const denial = event.permission_denials.find((entry) => namesProbe(JSON.stringify(entry)));
            if (denial !== undefined) return `permission_denials: ${clip(JSON.stringify(denial))}`;
        }
    }
    return null;
};

/** Whether `writeRefusalEvidence` found any. */
export const writeRefusalObservedIn = (stdout: string, stderr: string, probePath: string, cwd?: string): boolean =>
    writeRefusalEvidence(stdout, stderr, probePath, cwd) !== null;

/** What a review reads from each recorded preflight to decide whether it may start. */
export type PreflightSummary = {
    name: string;
    version: string;
    sandboxSignature: string;
    startedAt: string;
    passed: boolean;
    problems?: readonly string[];
};

/**
 * Whether a review may start on the preflights recorded for its sandbox
 * signature. The newest of them decides, and it must have passed under the
 * current rule: an older pass is not consulted past a newer failure -- the
 * environment was last seen failing -- and a pass judged under an earlier
 * rule proved what that rule asked, not what this one does. Either way the
 * answer is to run the preflight again, not to pick a record that suits.
 */
export const preflightGate = (
    records: readonly PreflightSummary[],
    signature: string,
    version: string = PREFLIGHT_RECORD_VERSION
): { chosen: PreflightSummary | null; problems: readonly string[] } => {
    const matching = records
        .filter((record) => record.sandboxSignature === signature)
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    const newest = matching[0] ?? null;
    if (!newest) return { chosen: null, problems: [`no preflight is recorded for this sandbox signature (${signature})`] };
    if (newest.version !== version) {
        return {
            chosen: null,
            problems: [`the newest preflight for this sandbox, ${newest.name}, was judged under ${newest.version}, not the current ${version}; run --mode=preflight again`],
        };
    }
    if (newest.passed !== true) {
        return {
            chosen: null,
            problems: [
                `the newest preflight for this sandbox, ${newest.name} (${newest.startedAt}), FAILED: ${(newest.problems ?? []).join("; ") || "no problem recorded"}; an older pass is not consulted, run --mode=preflight again`,
            ],
        };
    }
    return { chosen: newest, problems: [] };
};

export async function runCrossReview(control: CrossReviewControl): Promise<CrossReviewOutcome> {
    const roles = control.roles ?? DEFAULT_ROLE_ASSIGNMENT;
    const maxRevisions = resolveMaxRevisions(control.maxRevisions);
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
            guardRuns: last?.guardRuns ?? [],
            guardViolations: last?.guardViolations ?? [],
            checkFailures: last?.checkFailures ?? [],
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
                guardRuns: [],
                guardViolations: [],
                checkFailures: [],
                reviewConclusion: null,
                findings: [],
                nextAction: `author ${produced.failure}: ${produced.detail}`,
            });
            return finish("failed", `author_${produced.failure}`, null, "the author produced no usable change; nothing was reviewed");
        }
        const output: AuthorOutput = produced.value;
        // The scope check reads the diff as well as the author's list: a
        // file the diff touches is a file changed, whatever was reported.
        const named = filesNamedByDiff(output.diff);
        const touched = [...new Set([...output.filesChanged, ...named])];
        const violations = scopeViolations(task, touched);
        if (violations.length > 0) {
            rounds.push({
                round,
                changeDigest: control.digest(output.diff),
                commit: output.commit ?? null,
                filesChanged: output.filesChanged,
                changeSummary: output.summary,
                testResults: [],
                guardRuns: [],
                guardViolations: violations.map((file) => `outside writable scope: ${file}`),
                checkFailures: violations.map((file) => `outside writable scope: ${file}`),
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
        const guardRuns: readonly GuardRun[] =
            typeof control.guards === "function" ? await control.guards({ diff: output.diff, filesChanged: output.filesChanged }) : [];
        const unreported = named.filter((file) => !output.filesChanged.includes(file));
        const guardViolations: readonly string[] = [
            ...guardRuns.filter((run) => !run.passed).map((run) => `${run.rule}: ${run.detail}`),
            ...unreported.map((file) => `the diff names ${file}, which filesChanged does not`),
        ];
        const checkFailures: string[] = [];
        if (testResults.length === 0) checkFailures.push("no test was run");
        for (const run of testResults) if (!run.passed) checkFailures.push(`test failed: ${run.command}`);
        if (guardRuns.length === 0) checkFailures.push("no guard was run");
        for (const run of guardRuns) if (!run.passed) checkFailures.push(`guard failed: ${run.rule}`);
        for (const file of unreported) checkFailures.push(`the diff names ${file}, which filesChanged does not`);
        const checksPass = checkFailures.length === 0;

        const reviewed: ExecutorResult<ReviewVerdict> = await withTimeout<ReviewVerdict>(
            control.reviewer.review({
                task,
                round,
                changeDigest,
                commit: output.commit ?? null,
                diff: output.diff,
                testResults,
                guardRuns,
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
            guardRuns,
            guardViolations,
            checkFailures,
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
            const open = blocking(disposed);
            if (checksPass && open.length === 0) {
                rounds.push({ ...record, reviewConclusion: "approve", findings: disposed, nextAction: verdict.nextAction });
                return finish("passed", null, null, verdict.nextAction || "approved on this digest with tests and guards passing");
            }
            // Two executors agreeing is not a pass. Failing checks, or a
            // reproducible finding named alongside the approval, send the
            // change back and count a round.
            const why = [
                ...checkFailures,
                ...open.map((finding) => `open finding: ${finding.location}`),
            ].join("; ");
            rounds.push({
                ...record,
                reviewConclusion: "approve",
                findings: disposed,
                nextAction: canRevise
                    ? `approved, but a required check failed or a finding is open (${why}); the author fixes it and the change is re-reviewed`
                    : `approved, but a required check failed or a finding is open (${why}) and no revision remains`,
            });
            if (!canRevise) {
                return finish(
                    "on_hold",
                    null,
                    open.length > 0 ? "revisions_exhausted" : "approved_but_checks_failed",
                    open.length > 0
                        ? `approved by the reviewer with ${open.length} reproducible finding(s) still open after ${maxRevisions} revision(s); a person decides`
                        : "approved by the reviewer, refused by the checks; a person decides"
                );
            }
            feedback = {
                findings: disposed.filter((finding) => finding.disposition === "fix_requested"),
                failedTests: testResults.filter((run) => !run.passed),
                guardViolations,
                checkFailures,
            };
            previousFindings = verdict.findings;
            continue;
        }

        // request_changes
        const disposed = disposeFindings(verdict.findings, canRevise);
        const actionable = disposed.filter((finding) => finding.disposition === "fix_requested");
        const unresolved = disposed.filter((finding) => finding.disposition === "unresolved_on_hold");
        if (actionable.length === 0 && unresolved.length === 0 && checksPass) {
            // Nothing the reviewer raised comes with a reproduction, and the
            // checks pass: the current version stands, with every finding recorded.
            rounds.push({
                ...record,
                reviewConclusion: "request_changes",
                findings: disposed,
                nextAction: "no finding was actionable under the operating defaults; the current version stands",
            });
            return finish("passed", null, null, "changes were requested on preference or unreproduced findings only; the current version stands with the findings on record");
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
            checkFailures,
        };
        previousFindings = verdict.findings;
    }

    // Unreachable: every branch above returns before the loop ends.
    return finish("on_hold", null, "revisions_exhausted", "the loop ended without a verdict");
}

// ---------------------------------------------------------------------------
// A person-driven exchange: packaged rounds and their verdicts, replayed.

/** One round as a person packaged it and, once it exists, the verdict on it. */
export type PackagedRound = {
    round: number;
    diff: string;
    summary: string;
    filesChanged: readonly string[];
    commit: string | null;
    testResults: readonly TestRun[];
    /** Every guard rule the packager ran, with its result. */
    guardRuns: readonly GuardRun[];
    verdict: ReviewVerdict | null;
};

export type ReplayStatus = CrossReviewStatus | "awaiting_review" | "awaiting_revision";

export type ReplayedExchange = Omit<ExchangeRecord, "status"> & {
    status: ReplayStatus;
    packagedRounds: number;
    /**
     * The round at which the control program reached passed, on_hold or
     * failed, or null while it is still waiting on a verdict or a revision.
     * A package after this round is not part of the exchange.
     */
    concludedAtRound: number | null;
};

/**
 * Runs the packaged rounds through `runCrossReview` exactly as a live loop
 * would have, with the packages standing in for the author and the verdicts
 * for the reviewer, and reads off where it stopped. The two waiting states
 * are where the stand-ins had nothing to say -- a package with no verdict
 * yet, or a verdict the control program answered by asking for a revision
 * nobody has made -- and everything else is the control program's own
 * outcome. Nothing is decided here that `runCrossReview` did not decide.
 */
export async function replayExchange(input: {
    task: CrossReviewTask;
    roles?: RoleAssignment;
    maxRevisions?: number;
    digest: (diff: string) => string;
    rounds: readonly PackagedRound[];
    now?: () => Date;
}): Promise<ReplayedExchange> {
    const roles = input.roles ?? DEFAULT_ROLE_ASSIGNMENT;
    const rounds = input.rounds;
    if (rounds.length === 0) throw new Error("nothing to replay: no round is packaged");
    rounds.forEach((entry, index) => {
        if (entry.round !== index) throw new Error(`packaged rounds must be contiguous from 0; found round ${entry.round} at position ${index}`);
    });
    let current = -1;
    const author: AuthorExecutor = {
        id: roles.author,
        produce: async ({ round }) => {
            const entry = rounds[round];
            if (!entry) return { ok: false, failure: "missing_result", detail: `no package for round ${round}` };
            return { ok: true, value: { diff: entry.diff, summary: entry.summary, filesChanged: entry.filesChanged, commit: entry.commit } };
        },
    };
    const reviewer: ReviewerExecutor = {
        id: roles.reviewer,
        review: async ({ round }) => {
            const verdict = rounds[round]?.verdict ?? null;
            if (!verdict) return { ok: false, failure: "missing_result", detail: `no verdict for round ${round}` };
            return { ok: true, value: verdict };
        },
    };
    const outcome = await runCrossReview({
        task: input.task,
        roles,
        author,
        reviewer,
        digest: input.digest,
        maxRevisions: input.maxRevisions,
        now: input.now,
        runTests: async () => {
            current += 1;
            return rounds[current]?.testResults ?? [];
        },
        guards: async () => rounds[current]?.guardRuns ?? [],
    });
    const consumed = outcome.exchange.rounds.length;
    const base: ReplayedExchange = {
        ...outcome.exchange,
        packagedRounds: rounds.length,
        concludedAtRound: consumed - 1,
    };
    if (outcome.failure === "reviewer_missing_result" && consumed === rounds.length) {
        const latest = rounds[rounds.length - 1];
        const open: RoundRecord = { ...outcome.exchange.rounds[consumed - 1], nextAction: "awaiting the reviewer's verdict" };
        return {
            ...base,
            rounds: [...outcome.exchange.rounds.slice(0, -1), open],
            status: "awaiting_review",
            failure: null,
            concludedAtRound: null,
            nextAction: `hand the review prompt (round ${latest.round}) to the ${roles.reviewer} reviewer; its verdict must name digest ${open.changeDigest}`,
        };
    }
    if (outcome.failure === "author_missing_result" && consumed === rounds.length + 1) {
        // The control program asked for the next revision; nobody has made it.
        const reviewed = outcome.exchange.rounds[consumed - 2];
        return {
            ...base,
            rounds: outcome.exchange.rounds.slice(0, -1),
            changeDigest: reviewed.changeDigest,
            commit: reviewed.commit,
            changeSummary: reviewed.changeSummary,
            testResults: reviewed.testResults,
            guardRuns: reviewed.guardRuns,
            guardViolations: reviewed.guardViolations,
            checkFailures: reviewed.checkFailures,
            reviewConclusion: reviewed.reviewConclusion,
            findings: reviewed.findings,
            status: "awaiting_revision",
            failure: null,
            concludedAtRound: null,
            nextAction: `${reviewed.nextAction}; package round ${consumed - 1} once the change is revised`,
        };
    }
    return base;
}

/**
 * The text the reviewer is given, in reading order: requirement, criteria,
 * the diff, the tests and guards, and only then the author's account of
 * itself. The reviewer answers with one JSON document in the `ReviewVerdict`
 * shape.
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
    lines.push("");
    lines.push("## Guard results (run by the control program)");
    lines.push("");
    if (request.guardRuns.length === 0) lines.push("- none run");
    for (const run of request.guardRuns) {
        lines.push(`- ${run.passed ? "PASS" : "FAIL"} \`${run.rule}\`${run.durationMs !== undefined ? ` (${run.durationMs}ms)` : ""}`);
        if (run.detail.trim()) lines.push(`  ${run.detail.trim().split("\n").join("\n  ")}`);
    }
    if (request.guardViolations.length > 0) {
        lines.push("");
        lines.push("## Guard violations");
        lines.push("");
        for (const violation of request.guardViolations) lines.push(`- ${violation}`);
    }
    if (request.previousFindings.length > 0) {
        lines.push("");
        lines.push(`## Findings from ${request.previousFindingsFrom ?? "the previous round"} (check each was addressed)`);
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
                        reproduction: "how to see it: a command, or an input and its expected output (required for the finding to be acted on)",
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
    lines.push(
        "`reviewedDigest` must be the digest above, verbatim. A finding with basis `preference` is settled by the project's rules; any other finding is acted on only with a reproduction, and without one it is recorded and the current version stands."
    );
    return `${lines.join("\n")}\n`;
};
