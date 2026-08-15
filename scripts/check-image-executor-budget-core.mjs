// The three image-generation deadlines, checked against each other.
//
// One provider timeout and one backoff schedule decide all of them: how long a
// single attempt may legitimately take, how long the sweep waits before
// calling a generation abandoned, and how long the route that drives a group
// from `after()` is allowed to run. They were three independent literals with
// the relationship written only in prose, and prose does not fail a build.
//
// Two things go wrong when they drift apart, and neither is visible in a test
// run:
//
//  - a stale threshold at or below the worst legitimate attempt has the sweep
//    refunding work that is still running, and charging the provider for it;
//  - a route budget below what the executor needs cuts the executor off
//    mid-group. That is not a delay: nothing re-drives a `pending` generation,
//    so the request is lost and its owner waits out the stale window.
//
// Pure, so the arithmetic is testable without a Next build.

export const IMAGE_EXECUTOR_ROUTES = [
    "app/api/images/generations/route.ts",
    "app/api/images/targets/[targetId]/retry/route.ts",
];

const MAX_DURATION_PATTERN = /^export const maxDuration = (\d+);$/m;

export const readDeclaredMaxDuration = (source) => {
    const match = MAX_DURATION_PATTERN.exec(source);
    return match ? Number(match[1]) : null;
};

export function auditImageExecutorBudget({
    attemptWorstCaseMs,
    staleAfterMs,
    requiredSeconds,
    routes,
}) {
    const failures = [];

    if (!(staleAfterMs > attemptWorstCaseMs)) {
        failures.push(
            `STALE_IMAGE_GENERATION_AFTER_MS (${staleAfterMs}ms) must exceed ` +
                `IMAGE_ATTEMPT_WORST_CASE_MS (${attemptWorstCaseMs}ms), or the ` +
                `sweep refunds generations that are still running.`
        );
    }

    if (!(requiredSeconds * 1_000 >= attemptWorstCaseMs)) {
        failures.push(
            `IMAGE_EXECUTOR_MAX_DURATION_SECONDS (${requiredSeconds}s) is below ` +
                `a single attempt's worst case (${attemptWorstCaseMs}ms).`
        );
    }

    for (const route of routes) {
        if (!route.drivesExecutor) {
            failures.push(
                `${route.file} is listed as an image executor route but no ` +
                    `longer drives processImageGenerationGroup from after(). ` +
                    `Remove it from IMAGE_EXECUTOR_ROUTES instead of leaving a ` +
                    `check that verifies nothing.`
            );
            continue;
        }
        if (route.declaredSeconds === null) {
            failures.push(
                `${route.file} drives a generation group from after() but ` +
                    `declares no maxDuration, so an unstated platform default ` +
                    `decides where the executor is cut off.`
            );
            continue;
        }
        if (route.declaredSeconds < requiredSeconds) {
            failures.push(
                `${route.file} declares maxDuration = ${route.declaredSeconds}, ` +
                    `below the ${requiredSeconds}s the executor can need.`
            );
        }
    }

    return { failures };
}
