// The DB integration runner names its suites one by one. This checks that the
// list and the directory still describe the same thing.
//
// A glob would remove the need for the list, and cannot: the suites are split
// across several `node --test` processes because module mocks are
// process-global, and which process a file belongs in is a real decision the
// list records. What a hand-written list cannot do is notice a file nobody
// added to it.
//
// That has already happened twice. The runner carries a comment about the
// first -- "written alongside their slices but never listed here, i.e. never
// actually run by CI -- a guard nobody runs is not a guard" -- and asks the
// next person to keep the list in step. Asking is not enforcing:
// `provider-probe.db.test.ts` was written in #245, never listed, and had been
// failing ever since STG-R002 changed how a failure is scoped. Nobody could
// have known, because nothing ran it.
//
// Pure, so both directions are testable without a database.

/** A path in the runner that no longer exists is as bad as a missing one. */
export function auditDbIntegrationCoverage({ suiteFiles, runnerSource }) {
    const failures = [];

    const referenced = new Set(
        [...runnerSource.matchAll(/"(tests\/integration\/[^"]+\.db\.test\.ts)"/g)].map(
            (match) => match[1]
        )
    );

    for (const file of suiteFiles) {
        const path = `tests/integration/${file}`;
        if (!referenced.has(path)) {
            failures.push(
                `${path} exists but the runner never names it, so CI has never run it.`
            );
        }
    }

    for (const path of referenced) {
        const file = path.slice("tests/integration/".length);
        if (!suiteFiles.includes(file)) {
            failures.push(
                `${path} is named by the runner but does not exist; the run fails on a missing file.`
            );
        }
    }

    return { failures, referenced: [...referenced].sort() };
}
